import { mkdir } from 'node:fs/promises';
import { ownChat } from '../db/repos/chats.ts';
import { commitDigestWindow, digestPosts, digestSourceCount, digestSourceIds, digestTimezone, dropStaleWindow, getDigest, pinDigestWindow } from '../db/repos/digests.ts';
import { recordEvent } from '../db/repos/events.ts';
import { getSource } from '../db/repos/sources.ts';
import { log } from '../obs/log.ts';
import { Coded, E } from '../platform/errors.ts';
import { cleanupWorkDir, workDirFor } from '../pipeline/cleanup.ts';
import { mediaSignal } from '../pipeline/prepare-media.ts';
import { runFetchSource, type RunDeps } from '../pipeline/run.ts';
import { payloadOf, type MessagePlan } from '../render/message-plan.ts';
import { targetOf } from '../telegram/target.ts';
import { audioOverview } from './audio.ts';
import { digestGemini } from './quota.ts';
import { overBudget, partSize, renderDigest } from './render.ts';
import { writeScript } from './script.ts';
import { publishPage, summarisePost, clamp, MAX_HEADLINE, MAX_SOURCE_TITLE, type DigestLang } from './summarise.ts';

/**
 * ADR-029: one digest run. The job ends before the queue's stale-lock window, so the same digest can
 * never be handed to a second worker while it is still speaking.
 */
export const DIGEST_BUDGET_MS = 8 * 60_000;
export const DIGEST_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Gemini calls run three at a time: enough pace for a 60-post day, gentle on the quota. */
const SUMMARY_CONCURRENCY = 3;

/**
 * The `digest` job. Order matters: the selected sources are checked once before the window closes,
 * the window is then pinned, and the same pin is reused by every retry, so a retry sees the posts the
 * first attempt saw. The window is committed only after the last part is on Telegram.
 */
export async function runDigest(deps: RunDeps, digestId: number, now = Date.now()): Promise<void> {
  const cfg = deps.cfg.digest;
  const digest = getDigest(deps.db, digestId);
  if (cfg === undefined || digest === undefined || digest.enabled !== 1) return;
  const chat = ownChat(deps.db, digest.user_id, digest.chat_id);
  if (chat === undefined) return;

  const gemini = deps.gemini ?? digestGemini(cfg, deps.db);
  const lang: DigestLang = digest.lang === 'ta' ? 'ta' : 'en';
  const tz = digestTimezone(deps.db, digestId);
  const signal = mediaSignal(DIGEST_BUDGET_MS);
  const dir = workDirFor(`digest-${digestId}-${process.pid}`);

  try {
    // The audio and the pictures land here; a download would create it, a text-only digest would not.
    await mkdir(dir, { recursive: true });
    // A pin left by a run that died is a day old: drop it, so this run checks its sources again.
    dropStaleWindow(deps.db, digestId, now);
    const pinned = getDigest(deps.db, digestId)?.window_end ?? null;
    // A post published minutes before the digest belongs to it: one last check per source.
    if (pinned === null) {
      for (const sourceId of digestSourceIds(deps.db, digestId)) {
        try {
          await runFetchSource(deps, sourceId, now);
        } catch (err) {
          // A dead feed is a failed check, not a failed digest; the window still closes.
          log('warn', 'digest_fetch_failed', { source: sourceId, cause: message(err) });
        }
      }
    }

    // +1 ms: the pre-check records its new posts with first_seen_at === now, and the window's upper
    // bound is strict, so pinning at `now` would push every one of them into tomorrow's digest.
    const windowEnd = pinDigestWindow(deps.db, digestId, now + 1);
    const from = Math.max(digest.last_window_end ?? 0, windowEnd - DIGEST_WINDOW_MS);
    const posts = digestPosts(deps.db, digestId, from, windowEnd);
    const summarised = posts.slice(0, cfg.maxPosts);
    const overflow = posts.slice(cfg.maxPosts);
    const titles = new Map<number, string | null>();
    const titleOf = (sourceId: number): string | null => {
      if (!titles.has(sourceId)) titles.set(sourceId, getSource(deps.db, sourceId)?.title ?? null);
      // A feed's own name has no clamp of its own, and the header prints it once per story: a paragraph
      // here would spend a whole part's budget before a single summary was rendered.
      const title = titles.get(sourceId) ?? null;
      return title === null ? null : clamp(title, MAX_SOURCE_TITLE);
    };

    const items = await mapLimit(summarised, SUMMARY_CONCURRENCY, (post) =>
      summarisePost({ db: deps.db, http: deps.http, media: deps.media, telegraph: deps.telegraph, gemini, maxMb: deps.cfg.limits.maxDownloadMb }, post, lang, dir, signal, titleOf(post.source_id)),
    );
    // Every story falling back means Gemini itself is down: leave the window pinned and retry later.
    if (items.length > 0 && items.every((item) => item.fellBack)) throw new Coded(E.FEED_DOWN, 'every digest summary failed');
    // Over the job budget: retry on the pinned window instead of shipping a half-planned digest.
    if (signal.aborted) throw new Coded(E.FEED_DOWN, 'digest over budget');

    const date = dateLabel(windowEnd, tz, 'en');
    const built =
      posts.length === 0
        ? { plans: renderDigest({ lang, date, tz, sourceCount: digestSourceCount(deps.db, digestId), items: [], extra: [], postCount: 0, audio: null }), audioSec: 0 }
        : await plansFor(deps, { lang, date, tz, digestId, items, overflow, postCount: posts.length, dir, signal, gemini });

    const target = targetOf(chat.tg_chat_id, chat.message_thread_id, chat.type);
    // A part Telegram would refuse costs its own stories, and one refusal used to cost every part
    // after it. Send none of them instead: the pin stays, and the retry on the same window delivers
    // the whole digest rather than a copy the reader can never complete (ADR-035).
    const oversized = built.plans.flatMap((plan, index) => (plan.kind === 'rich' && overBudget(plan.html) ? [{ part: index + 1, ...partSize(plan.html) }] : []));
    if (oversized.length > 0) {
      log('error', 'digest_parts_over_budget', { digest: digestId, planned: built.plans.length, oversized });
      // Deterministic and terminal: the same renderer refuses the same part on every attempt, so the
      // retry ladder would only re-plan, re-voice and re-download for the same answer (ADR-035).
      throw new Coded(E.TOO_LARGE, 'digest part over budget');
    }

    // Every part is attempted: one refused part must not cost the stories after it. A failure is
    // logged with the size that was refused, so the live threshold can be read instead of guessed.
    const failed: number[] = [];
    let firstFailure: unknown;
    for (const [index, plan] of built.plans.entries()) {
      try {
        await deps.sender.send(plan, target);
      } catch (err) {
        failed.push(index + 1);
        firstFailure ??= err;
        log('error', 'digest_part_failed', { digest: digestId, part: index + 1, parts: built.plans.length, ...partSize(plan.kind === 'rich' ? plan.html : ''), cause: message(err) });
      }
    }
    log('info', 'digest_parts_sent', { digest: digestId, planned: built.plans.length, sent: built.plans.length - failed.length, failed });
    // The stored links live as long as the post row (retention prunes posts): a retry, the other
    // language or another user on the same source reads them instead of writing the page again.
    // The window is committed only when every part is on Telegram, so a missing one comes back on the
    // retry instead of staying missing.
    // shortcut: a failed part resends the whole digest on the retry; add a per-part ledger if the
    // duplicates that costs ever matter.
    if (failed.length > 0) throw firstFailure;
    commitDigestWindow(deps.db, digestId, windowEnd);

    log('info', 'digest_sent', {
      digest: digestId,
      posts: posts.length,
      parts: built.plans.length,
      images: built.plans.reduce((sum, plan) => sum + (plan.kind === 'rich' ? plan.media.filter((entry) => entry.kind === 'photo').length : 0), 0),
      audioSec: built.audioSec,
    });
    recordEvent(deps.db, { level: 'info', code: 'digest_sent', chatId: chat.id, detail: `${posts.length} posts, ${built.plans.length} parts`, at: now });
  } finally {
    // Stage 9: every path deletes the work files, images and PCM included.
    await cleanupWorkDir(dir);
  }
}

/** Script → audio → render. A failed script or voice costs the player, never the digest. */
async function plansFor(
  deps: RunDeps,
  input: {
    lang: DigestLang;
    date: string;
    tz: string;
    digestId: number;
    items: Awaited<ReturnType<typeof summarisePost>>[];
    overflow: ReturnType<typeof digestPosts>;
    postCount: number;
    dir: string;
    signal: AbortSignal;
    gemini: NonNullable<RunDeps['gemini']>;
  },
): Promise<{ plans: MessagePlan[]; audioSec: number }> {
  let audio: { file: string; seconds: number } | null = null;
  try {
    const script = await writeScript(input.gemini, { lang: input.lang, date: input.date, items: input.items }, input.signal);
    audio = await audioOverview(input.gemini, script, input.dir, `FeedBerry Daily Digest · ${input.date}`, input.signal, deps.encodeAudio);
  } catch (err) {
    // The stories are already summarised; the message is worth more than the voice.
    log('warn', 'digest_audio_failed', { digest: input.digestId, cause: message(err) });
  }

  // Overflow stories get a Telegraph page too, so every "Also today" link matches the items' links.
  const pages = await mapLimit(input.overflow, SUMMARY_CONCURRENCY, (post) => publishPage({ db: deps.db, http: deps.http, telegraph: deps.telegraph }, post, input.signal));
  const extra = input.overflow.map((post, index) => ({
    // A feed can hand over a whole paragraph as a title; one unbounded label would blow a whole part.
    headline: clamp(payloadOf(post.payload_json).title || post.url || 'Post', MAX_HEADLINE),
    url: pages[index] ?? post.url,
  }));

  const plans = renderDigest({
    lang: input.lang,
    date: input.date,
    tz: input.tz,
    sourceCount: digestSourceCount(deps.db, input.digestId),
    items: input.items,
    extra,
    postCount: input.postCount,
    audio,
  });
  return { plans, audioSec: Math.round(audio?.seconds ?? 0) };
}

/** `Mon, 16 Nov 2026` in the owner's zone, in the digest's own language. */
export function dateLabel(ms: number, tz: string, lang: DigestLang): string {
  return new Intl.DateTimeFormat(lang === 'ta' ? 'ta-IN' : 'en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).format(ms);
}

/** Three at a time, results in input order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      out[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));
