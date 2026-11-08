import type { Config } from '../config.ts';
import { tx, type Db } from '../db/index.ts';
import { listPendingForSource, markPendingDelivery } from '../db/repos/deliveries.ts';
import { getPost, insertPosts, type PostRow } from '../db/repos/posts.ts';
import { getSource, setSourceFeedUrl, type SourceRow } from '../db/repos/sources.ts';
import { demoteChat } from '../db/repos/chats.ts';
import { deliveryTargets, sourceContentKinds } from '../db/repos/subscriptions.ts';
import { recordEvent } from '../db/repos/events.ts';
import { alerts, type Notifier } from '../obs/alerts.ts';
import { log } from '../obs/log.ts';
import type { TelegraphClient } from '../article/telegraph.ts';
import type { MediaEngine, MediaItem } from '../media/cobalt.ts';
import { probeDuration } from '../media/probe.ts';
import type { Thumbnailer } from '../media/thumb.ts';
import { E, isCoded } from '../platform/errors.ts';
import { allowsContent, parseContentTypes, youtubeKindOf } from '../platform/content-types.ts';
import type { FeedItem, ParsedFeed } from '../platform/feed/native.ts';
import { fetchThreadsThread, threadText } from '../platform/feed/threads.ts';
import type { Http } from '../platform/http.ts';
import { pageText } from '../platform/page-text.ts';
import type { SourceRef } from '../platform/registry.ts';
import { payloadOf, type MessagePlan } from '../render/plan.ts';
import type { TelegramSender } from '../telegram/api.ts';
import { targetOf } from '../telegram/target.ts';
import { fetchSourceFeed } from './s2-feed.ts';
import { classifyMedia } from './s3-classify.ts';
import { effectiveKeywords, passesFilter } from './filter.ts';
import { planArticle } from './article-plan.ts';
import { unseenItems, uniqueItems } from './s4-dedupe.ts';
import { mediaSignal, prepareMedia } from './s5-media.ts';
import { renderPost } from './s6-render.ts';
import { pageOfPost, withReadMore } from './read-more.ts';
import { LONG_VIDEO_SEC, MAX_UPLOAD_BYTES } from '../render/video.ts';
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
    const feed = await fetchSourceFeed(deps.http, refOfSource(source), sourceContentKinds(deps.db, sourceId), deps.cfg.rsshubBase);
    // A discovered feed URL is stored once, so the next check goes straight to the feed (§5.3).
    if (source.feed_url === null && feed.feedUrl) setSourceFeedUrl(deps.db, sourceId, feed.feedUrl);
    const newItems = unseenItems(deps.db, sourceId, feed.items);
    fresh = newItems.length;
    if (fresh > 0) persistNew(deps.db, source, feed, newItems, now);
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
function persistNew(db: Db, source: SourceRow, feed: ParsedFeed, freshItems: FeedItem[], now: number): void {
  const targets = deliveryTargets(db, source.id);
  const freshGuids = new Set(freshItems.map((item) => item.guid));
  tx(db, () => {
    const posts = insertPosts(db, source.id, uniqueItems(feed.items), now);
    for (const post of posts) {
      if (!freshGuids.has(post.guid)) continue;
      const kind = source.platform === 'youtube' ? youtubeKindOf(post.url) : null;
      for (const target of targets) {
        // Every post is recorded once per source; each chat only hears about the kinds it chose.
        if (!allowsContent(parseContentTypes(target.content_types), kind)) continue;
        markPendingDelivery(db, post.id, target.chat_id, now);
      }
    }
  });
}

/**
 * One delivery pass per source at a time. A fetch ends with a pass and the backfill job runs one of
 * its own, so two passes would read the same `pending` rows and send them twice.
 * shortcut: in-process only; a second process on the same file would need a claim in the database.
 */
const delivering = new Map<number, Promise<void>>();

/** Sends everything pending for a source, per chat, oldest first (§9.3). No head-of-line blocking. */
export async function deliverPending(deps: RunDeps, sourceId: number, now = Date.now()): Promise<{ delivered: number; failed: number }> {
  const pass = (delivering.get(sourceId) ?? Promise.resolve()).then(() => deliverSource(deps, sourceId, now));
  const tail = pass.then(() => undefined, () => undefined);
  delivering.set(sourceId, tail);
  try {
    return await pass;
  } finally {
    if (delivering.get(sourceId) === tail) delivering.delete(sourceId);
  }
}

async function deliverSource(deps: RunDeps, sourceId: number, now: number): Promise<{ delivered: number; failed: number }> {
  let delivered = 0;
  let failed = 0;
  const source = getSource(deps.db, sourceId);
  const platform = source?.platform ?? 'rss';
  const sourceTitle = source?.title ?? null;
  // One Telegra.ph page per post, however many chats it goes to.
  const pages = new Map<number, string | null>();
  // One permalink GET per Threads post, however many chats it goes to.
  const threads = new Map<number, PostRow>();

  for (const row of deliveryTargets(deps.db, sourceId)) {
    const target = targetOf(row.tg_chat_id, row.message_thread_id, row.type);
    const keywords = effectiveKeywords(row.keywords, row.default_keywords);
    for (const delivery of listPendingForSource(deps.db, sourceId, row.chat_id)) {
      const stored = getPost(deps.db, delivery.post_id ?? 0);
      if (!stored) continue;
      const post = await withThreadText(deps.http, stored, platform, threads);

      // ADR-020: the words are already parsed, so a post nobody asked for costs no download and
      // no send. `skipped` is final, which is what keeps a filtered post out of the next pass.
      if (!passesFilter(payloadOf(post.payload_json), keywords)) {
        recordDelivery(deps.db, { postId: post.id, chatId: row.chat_id, status: 'skipped', parts: 0, messageIds: null, errorCode: null, now });
        continue;
      }

      // One directory per (post, chat) attempt; the pid keeps two processes from sharing it.
      const dir = workDirFor(`post-${post.id}-${row.chat_id}-${process.pid}`);
      try {
        const hookContext: HookContext = { sourceId, chatId: row.chat_id, postId: post.id, url: post.url };
        const planned = await withReadMore(await planForDelivery(deps, post, dir, platform, sourceTitle), pageOfPost(post), { telegraph: deps.telegraph, sourceTitle }, pages);
        const plan = await applyHooks('render', hookContext, planned);
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

/** Stages 3 → 5 → 6 for one post; any media failure degrades to a link card, never a lost post. */
async function planForDelivery(deps: RunDeps, post: NonNullable<ReturnType<typeof getPost>>, dir: string, platform: string, sourceTitle: string | null): Promise<MessagePlan> {
  const payload = payloadOf(post.payload_json);
  const hadFeedMedia = payload.media.length > 0;
  const signal = mediaSignal(MEDIA_TIMEOUT_MS);

  // R12: a website or blog post is an article when the page yields readable text. Trying this first
  // also skips cobalt, whose og:image made every blog post look like a photo with a headline.
  if (platform === 'rss' && post.url) {
    const article = await planArticle({ http: deps.http, telegraph: deps.telegraph }, {
      url: post.url,
      title: payload.title || null,
      publishedAt: post.published_at,
      sourceTitle,
      platform,
    });
    if (article) return article;
  }

  let items: MediaItem[] = [];
  let engineTitle: string | null = null;
  if (post.url) {
    try {
      const resolved = await deps.media.resolve(post.url, signal);
      items = resolved.items;
      // The feed often ships an empty title; the engine fetched one anyway, so keep it.
      engineTitle = resolved.title?.trim() || null;
    } catch (err) {
      log('warn', 'media_resolve_failed', { post: post.id, code: isCoded(err) ? err.code : 'unknown', cause: err instanceof Error ? err.message : String(err) });
    }
  }
  // A community post has no extractor: the feed's own photos are the media, so the album still ships.
  // An upload's feed media is only its thumbnail, so a failed extraction stays a link card (R14).
  if (items.length === 0 && youtubeKindOf(post.url) === 'post') items = feedPhotos(payload.media);

  const kind = classifyMedia(items, hadFeedMedia);
  // A feed that ships media only (X/Twitter, TikTok) leaves the caption to the page's own words.
  const hasFeedText = payload.title !== '' || (payload.summary ?? '') !== '';
  const titleFallback = engineTitle ?? (hasFeedText || !post.url ? null : await pageText(deps.http, post.url));
  if (items.length === 0) return renderPost(post, kind, [], { platform, sourceTitle, titleFallback });

  let files;
  try {
    files = await prepareMedia(deps.media, items, dir, { maxMb: deps.cfg.limits.maxDownloadMb, signal });
  } catch (err) {
    // Too large is a silent success path: the post ships as a link, not as a failure (ADR-012).
    log('warn', 'media_download_failed', { post: post.id, code: isCoded(err) ? err.code : 'unknown' });
    return renderPost(post, 'link_only', [], { platform, sourceTitle, titleFallback });
  }

  if (kind !== 'video') return renderPost(post, kind, files, { platform, sourceTitle, titleFallback });

  const video = files[0];
  if (!video) return renderPost(post, 'link_only', [], { platform, sourceTitle, titleFallback });

  // §8.6: ffprobe, then the feed's hint, then unknown (R9 keeps the size rule).
  const durationSec = (await probeDuration(video.path)) ?? items[0]?.durationSec ?? null;

  // Only a clip that cannot be uploaded needs a preview; anything else stays a plain video.
  const needsPreview = video.size > MAX_UPLOAD_BYTES || (durationSec !== null && durationSec >= LONG_VIDEO_SEC);
  if (!needsPreview) return renderPost(post, kind, files, { durationSec, platform, sourceTitle, titleFallback });

  // The platform poster the feed already carries beats a frame grab; ffmpeg is the fallback.
  const poster = payload.media.find((item) => item.type === 'photo')?.url ?? null;
  const thumbnail = poster ?? (await deps.thumbnail(video.path, dir));
  return renderPost(post, kind, files, { durationSec, thumbnail, thumbnailRemote: poster !== null, platform, sourceTitle, titleFallback });
}

/**
 * Threads' RSS ships a cut-down preview with the handle glued to the front, so a scheduled post
 * printed the same words twice. The permalink holds the whole thread; a failed GET keeps the feed.
 */
async function withThreadText(http: Http, post: PostRow, platform: string, known: Map<number, PostRow>): Promise<PostRow> {
  if (platform !== 'threads' || post.url === null) return post;
  const cached = known.get(post.id);
  if (cached !== undefined) return cached;
  const enriched = await threadRow(http, post);
  known.set(post.id, enriched);
  return enriched;
}

async function threadRow(http: Http, post: PostRow): Promise<PostRow> {
  try {
    const thread = await fetchThreadsThread(http, post.url ?? '');
    const text = threadText(thread);
    if (text === '') return post;
    const payload = payloadOf(post.payload_json);
    return {
      ...post,
      published_at: thread.posts[0]?.publishedAt ?? post.published_at,
      // The permalink's words replace the preview; an empty title stops the opening printing twice.
      payload_json: JSON.stringify({ ...payload, title: '', summary: text }),
    };
  } catch (err) {
    log('warn', 'threads_text_failed', { post: post.id, cause: err instanceof Error ? err.message : String(err) });
    return post;
  }
}

/** A feed that ships photo URLs and no extractor behind them (a YouTube community post album). */
function feedPhotos(media: Array<{ url: string; type: string }>): MediaItem[] {
  return media.filter((item) => item.type === 'photo').map((item) => ({ kind: 'photo' as const, url: item.url, picker: false }));
}

const refOfSource = (source: SourceRow): SourceRef => ({
  platform: source.platform as SourceRef['platform'],
  canonicalUrl: source.canonical_url,
  externalId: source.external_id ?? '',
  feedUrl: source.feed_url,
  strategy: source.strategy as SourceRef['strategy'],
});

const message = (err: unknown): string => (err instanceof Error ? `${err.name}: ${err.message}` : String(err));
