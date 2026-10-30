import type { Config } from '../config.ts';
import { tx, type Db } from '../db/index.ts';
import { listPendingForSource, markPendingDelivery } from '../db/repos/deliveries.ts';
import { getPost, insertPosts } from '../db/repos/posts.ts';
import { getSource, type SourceRow } from '../db/repos/sources.ts';
import { deliveryTargets } from '../db/repos/subscriptions.ts';
import { log } from '../obs/log.ts';
import { E, isCoded } from '../platform/errors.ts';
import type { FeedItem, ParsedFeed } from '../platform/feed/native.ts';
import type { Http } from '../platform/http.ts';
import type { SourceRef } from '../platform/registry.ts';
import type { TelegramSender } from '../telegram/api.ts';
import { targetOf } from '../telegram/target.ts';
import { fetchFeed } from './s2-feed.ts';
import { classifyPost } from './s3-classify.ts';
import { unseenItems } from './s4-dedupe.ts';
import { renderPost } from './s6-render.ts';
import { deliver } from './s7-deliver.ts';
import { recordCheck, recordDelivery } from './s8-record.ts';

export interface RunDeps {
  db: Db;
  http: Http;
  sender: TelegramSender;
  cfg: Config;
}

export interface RunResult {
  fresh: number;
  delivered: number;
  failed: number;
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
    recordCheck(deps.db, sourceId, true, now);
  } catch (err) {
    recordCheck(deps.db, sourceId, false, now);
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

  for (const row of deliveryTargets(deps.db, sourceId)) {
    const target = targetOf(row.tg_chat_id, row.message_thread_id, row.type);
    for (const delivery of listPendingForSource(deps.db, sourceId, row.chat_id)) {
      const post = getPost(deps.db, delivery.post_id);
      if (!post) continue;
      try {
        const ids = await deliver(deps.sender, renderPost(post, classifyPost(post)), target);
        recordDelivery(deps.db, { postId: post.id, chatId: row.chat_id, status: 'sent', parts: ids.length, messageIds: ids.join(','), errorCode: null, now });
        delivered++;
      } catch (err) {
        const code = isCoded(err) ? err.code : E.TG_UNKNOWN;
        recordDelivery(deps.db, { postId: post.id, chatId: row.chat_id, status: 'failed', parts: 0, messageIds: null, errorCode: code, now });
        failed++;
        log('warn', 'deliver_failed', { post: post.id, chat: row.chat_id, code });
      }
    }
  }
  return { delivered, failed };
}

const refOfSource = (source: SourceRow): SourceRef => ({
  platform: source.platform as SourceRef['platform'],
  canonicalUrl: source.canonical_url,
  externalId: source.external_id ?? '',
  feedUrl: source.feed_url,
  strategy: source.strategy as SourceRef['strategy'],
});
