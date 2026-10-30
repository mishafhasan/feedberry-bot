import type { Config } from '../config.ts';
import { tx, type Db } from '../db/index.ts';
import { listPendingForSource, markPendingDelivery } from '../db/repos/deliveries.ts';
import { getPost, insertPosts } from '../db/repos/posts.ts';
import { getSource, type SourceRow } from '../db/repos/sources.ts';
import { demoteChat } from '../db/repos/chats.ts';
import { deliveryTargets } from '../db/repos/subscriptions.ts';
import { recordEvent } from '../db/repos/events.ts';
import { alerts, type Notifier } from '../obs/alerts.ts';
import { log } from '../obs/log.ts';
import { extractArticle } from '../article/readability.ts';
import { publishArticle, telegraphClient, type TelegraphClient } from '../article/telegraph.ts';
import type { MediaEngine, MediaItem } from '../media/cobalt.ts';
import { probeDuration } from '../media/probe.ts';
import type { Thumbnailer } from '../media/thumb.ts';
import { E, isCoded } from '../platform/errors.ts';
import type { FeedItem, ParsedFeed } from '../platform/feed/native.ts';
import type { Http } from '../platform/http.ts';
import type { SourceRef } from '../platform/registry.ts';
import { payloadOf, type MessagePlan } from '../render/plan.ts';
import type { TelegramSender } from '../telegram/api.ts';
import { targetOf } from '../telegram/target.ts';
import { fetchFeed } from './s2-feed.ts';
import { classifyMedia } from './s3-classify.ts';
import { unseenItems } from './s4-dedupe.ts';
import { mediaSignal, prepareMedia } from './s5-media.ts';
import { renderArticle, renderArticleFallback, renderPost } from './s6-render.ts';
import { deliver } from './s7-deliver.ts';
import { recordDelivery, recordFailure, recordSuccess } from './s8-record.ts';
import { cleanupWorkDir, workDirFor } from './s9-cleanup.ts';

export interface RunDeps {
  db: Db;
  http: Http;
  sender: TelegramSender;
  cfg: Config;
  media: MediaEngine;
  /** ffmpeg frame at 1 s, or null when ffmpeg is absent (R7/R8 fall to a link card). */
  thumbnail: Thumbnailer;
  /** Telegra.ph (ADR-007); tests inject a recorder, production uses the real client. */
  telegraph?: TelegraphClient;
  /** Operator DM for §13.1 alerts; absent means alerts are only logged. */
  notifier?: Notifier;
}

export interface RunResult {
  fresh: number;
  delivered: number;
  failed: number;
}

/** §5.7: the only extension point. A hook sees an immutable context and may replace the plan. */
export interface HookContext {
  readonly sourceId: number;
  readonly chatId: number;
  readonly postId: number;
  readonly url: string | null;
}

export interface PipelineHook {
  id: string;
  after: 'classify' | 'render';
  run(context: HookContext, plan: MessagePlan): Promise<MessagePlan> | MessagePlan;
}

/** Empty in the MVP; registered at boot. A hook can never send: stage 7 owns delivery. */
const hooks: PipelineHook[] = [];

export function registerHook(hook: PipelineHook): void {
  hooks.push(hook);
}

export function resetHooks(): void {
  hooks.length = 0;
}

async function applyHooks(after: PipelineHook['after'], context: HookContext, plan: MessagePlan): Promise<MessagePlan> {
  let current = plan;
  for (const hook of hooks.filter((candidate) => candidate.after === after)) {
    current = await hook.run(Object.freeze(context), current);
    log('info', 'hook_applied', { hook: hook.id, kind: current.kind });
  }
  return current;
}

/**
 * Stages 2 → 3 → 4 → 6 → 7 → 8 for one source (ARCHITECTURE §5.1). Delivery always stays in
 * stage 7, so the rate limiter cannot be bypassed by any future hook.
 */
export async function runFetchSource(deps: RunDeps, sourceId: number, now = Date.now()): Promise<RunResult> {
  const source = getSource(deps.db, sourceId);
  if (!source || source.enabled !== 1) return { fresh: 0, delivered: 0, failed: 0 };

  let fresh = 0;
  try {
    const feed = await fetchFeed(deps.http, refOfSource(source));
    const newItems = unseenItems(deps.db, sourceId, feed.items);
    fresh = newItems.length;
    if (fresh > 0) persistNew(deps.db, sourceId, feed, newItems, now);
    recordSuccess(deps.db, sourceId, now);
    recordEvent(deps.db, { level: 'info', code: 'fetch_ok', sourceId, detail: `${fresh} new`, at: now });
  } catch (err) {
    const code = isCoded(err) ? err.code : 'E_UNKNOWN';
    const failures = recordFailure(deps.db, sourceId, code, now);
    recordEvent(deps.db, { level: 'error', code: 'fetch_fail', sourceId, detail: code, at: now });
    // §4.5: the owner hears about a source once per 24 h, not once per failure.
    if (failures >= 3 && deps.notifier) await alerts.sourceFailing(deps.db, deps.notifier, sourceId, code, now);
    throw err;
  }

  const { delivered, failed } = await deliverPending(deps, sourceId, now);
  log('info', 'fetch_done', { source: sourceId, fresh, delivered, failed });
  return { fresh, delivered, failed };
}

/** Records every item as seen (§5.4) and leaves the fresh ones pending for each target chat. */
function persistNew(db: Db, sourceId: number, feed: ParsedFeed, freshItems: FeedItem[], now: number): void {
  const targets = deliveryTargets(db, sourceId);
  const freshGuids = new Set(freshItems.map((item) => item.guid));
  tx(db, () => {
    const posts = insertPosts(db, sourceId, feed.items, now);
    for (const post of posts) {
      if (!freshGuids.has(post.guid)) continue;
      for (const target of targets) markPendingDelivery(db, post.id, target.chat_id, now);
    }
  });
}

/** Sends everything pending for a source, per chat, oldest first (§9.3). No head-of-line blocking. */
export async function deliverPending(deps: RunDeps, sourceId: number, now = Date.now()): Promise<{ delivered: number; failed: number }> {
  let delivered = 0;
  let failed = 0;
  const platform = getSource(deps.db, sourceId)?.platform ?? 'rss';

  for (const row of deliveryTargets(deps.db, sourceId)) {
    const target = targetOf(row.tg_chat_id, row.message_thread_id, row.type);
    for (const delivery of listPendingForSource(deps.db, sourceId, row.chat_id)) {
      const post = getPost(deps.db, delivery.post_id ?? 0);
      if (!post) continue;

      // One directory per (post, chat) attempt; the pid keeps two processes from sharing it.
      const dir = workDirFor(`post-${post.id}-${row.chat_id}-${process.pid}`);
      try {
        const hookContext: HookContext = { sourceId, chatId: row.chat_id, postId: post.id, url: post.url };
        const plan = await applyHooks('render', hookContext, await planForDelivery(deps, post, dir, platform));
        const ids = await deliver(deps.sender, plan, target);
        recordDelivery(deps.db, { postId: post.id, chatId: row.chat_id, status: 'sent', parts: ids.length, messageIds: ids.join(','), errorCode: null, now });
        recordEvent(deps.db, { level: 'info', code: 'send_ok', sourceId, chatId: row.chat_id, detail: `${ids.length} parts`, at: now });
        delivered++;
      } catch (err) {
        const code = isCoded(err) ? err.code : E.TG_UNKNOWN;
        if (code === E.TG_429) {
          // §9.2: leave the row pending, let the worker requeue the job. Nothing is lost.
          log('warn', 'deliver_flood_wait', { post: post.id, chat: row.chat_id });
          throw err;
        }
        recordDelivery(deps.db, { postId: post.id, chatId: row.chat_id, status: 'failed', parts: 0, messageIds: null, errorCode: code, now });
        recordEvent(deps.db, { level: 'error', code: 'send_fail', sourceId, chatId: row.chat_id, detail: code, at: now });
        // §12.3: a 403 demotes the chat so S4 stops offering it; the row is never deleted.
        if (code === E.TG_FORBIDDEN) demoteChat(deps.db, row.tg_chat_id);
        failed++;
        log('warn', 'deliver_failed', { post: post.id, chat: row.chat_id, code, cause: message(err) });
      } finally {
        // Stage 9 always runs, success or failure (§5.1).
        await cleanupWorkDir(dir);
      }
    }
  }
  return { delivered, failed };
}

const MEDIA_TIMEOUT_MS = 120_000;
/** R13 fires below this many readable characters (§8.1). */
const ARTICLE_MIN_CHARS = 400;

/** Stages 3 → 5 → 6 for one post; any media failure degrades to a link card, never a lost post. */
async function planForDelivery(deps: RunDeps, post: NonNullable<ReturnType<typeof getPost>>, dir: string, platform: string): Promise<MessagePlan> {
  const payload = payloadOf(post.payload_json);
  const hadFeedMedia = payload.media.length > 0;
  const signal = mediaSignal(MEDIA_TIMEOUT_MS);

  let items: MediaItem[] = [];
  if (post.url) {
    try {
      items = (await deps.media.resolve(post.url, signal)).items;
    } catch (err) {
      log('warn', 'media_resolve_failed', { post: post.id, code: isCoded(err) ? err.code : 'unknown', cause: err instanceof Error ? err.message : String(err) });
    }
  }

  const kind = classifyMedia(items, hadFeedMedia, { platform, hasBody: Boolean(payload.summary) });
  if (kind === 'article') return planArticle(deps, post);
  if (items.length === 0) return renderPost(post, kind, []);

  let files;
  try {
    files = await prepareMedia(deps.media, items, dir, { maxMb: deps.cfg.limits.maxDownloadMb, signal });
  } catch (err) {
    // Too large is a silent success path: the post ships as a link, not as a failure (ADR-012).
    log('warn', 'media_download_failed', { post: post.id, code: isCoded(err) ? err.code : 'unknown' });
    return renderPost(post, 'link_only', []);
  }

  if (kind !== 'video') return renderPost(post, kind, files);

  const video = files[0];
  if (!video) return renderPost(post, 'link_only', []);

  // §8.6: ffprobe, then the feed's hint, then unknown (R9 keeps the size rule).
  const durationSec = (await probeDuration(video.path)) ?? items[0]?.durationSec ?? null;
  const thumbnail = await deps.thumbnail(video.path, dir);
  return renderPost(post, kind, files, { durationSec, thumbnail });
}

/** R12/R13: fetch, extract, publish to Telegra.ph; anything thin or broken falls back to the link. */
async function planArticle(deps: RunDeps, post: NonNullable<ReturnType<typeof getPost>>): Promise<MessagePlan> {
  try {
    const article = await extractArticle(deps.http, post.url ?? '');
    if (article.textLength < ARTICLE_MIN_CHARS) return renderArticleFallback(post, article.title);
    return renderArticle(article, await publishArticle(deps.telegraph ?? telegraphClient, article));
  } catch (err) {
    log('warn', 'article_failed', { post: post.id, code: isCoded(err) ? err.code : 'unknown' });
    return renderArticleFallback(post, null);
  }
}

const refOfSource = (source: SourceRow): SourceRef => ({
  platform: source.platform as SourceRef['platform'],
  canonicalUrl: source.canonical_url,
  externalId: source.external_id ?? '',
  feedUrl: source.feed_url,
  strategy: source.strategy as SourceRef['strategy'],
});

const message = (err: unknown): string => (err instanceof Error ? `${err.name}: ${err.message}` : String(err));
