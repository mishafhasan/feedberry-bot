import type { Db } from '../db/index.ts';
import { Coded, E } from '../platform/errors.ts';
import type { FeedItem } from '../platform/feed/native.ts';
import type { SourceRef } from '../platform/registry.ts';
import { tx } from '../db/index.ts';
import { markPendingDelivery } from '../db/repos/deliveries.ts';
import { insertPosts, listSeen } from '../db/repos/posts.ts';
import { countSubscriptionsForUser, findSubscription, insertSubscription } from '../db/repos/subscriptions.ts';
import { upsertSource } from '../db/repos/sources.ts';
import { enqueue, PRIORITY } from '../jobs/queue.ts';

export interface AddSourceInput {
  userId: number;
  chatId: number;
  source: SourceRef;
  title: string | null;
  avatarUrl: string | null;
  items: FeedItem[];
  /** S5 "Add and send latest posts" vs "Add without sending" (§5.4). */
  deliverLatest: boolean;
  backfillCount: number;
  now?: number;
}

/** OQ-11: the limit is per user and counts subscriptions, exactly what S1 prints. */
export function assertWithinSourceLimit(db: Db, userId: number, limit: number): void {
  if (countSubscriptionsForUser(db, userId) >= limit) throw new Coded(E.SOURCE_LIMIT, `limit ${limit}`);
}

/**
 * Stage 4 read half (§5.4): the feed items this source has never recorded.
 * The guid is not enough — RSSHub regenerates it and some feeds append tracking params — so the
 * normalized link is checked too.
 */
export function unseenItems(db: Db, sourceId: number, items: FeedItem[]): FeedItem[] {
  const seen = listSeen(db, sourceId);
  const guids = new Set(seen.guids);
  const urls = new Set(seen.urls.map(normalizeUrl));
  return items.filter((item) => !guids.has(item.guid) && !(item.link !== null && urls.has(normalizeUrl(item.link))));
}

/** Same post, different spelling: drop the scheme, `www.`, the fragment, tracking params and a trailing slash. */
export function normalizeUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return url.trim();
  }
  for (const key of [...parsed.searchParams.keys()]) {
    if (/^(utm_|fbclid$|gclid$|mc_|ref$)/i.test(key)) parsed.searchParams.delete(key);
  }
  const search = parsed.searchParams.toString();
  const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
  return `${host}${parsed.pathname.replace(/\/+$/, '')}${search ? `?${search}` : ''}`;
}

/**
 * Stage 4 write half: sources + subscriptions + the "seen" set, plus the backfill marker.
 * One transaction, so a duplicate or a limit failure leaves nothing behind.
 */
export function addSource(db: Db, input: AddSourceInput): { sourceId: number; pending: number } {
  const now = input.now ?? Date.now();
  return tx(db, () => {
    const source = upsertSource(db, {
      platform: input.source.platform,
      canonicalUrl: input.source.canonicalUrl,
      externalId: input.source.externalId,
      feedUrl: input.source.feedUrl,
      strategy: input.source.strategy,
      title: input.title,
      avatarUrl: input.avatarUrl,
    });

    if (findSubscription(db, source.id, input.chatId)) throw new Coded(E.DUPLICATE, 'same source and chat');

    const subscription = insertSubscription(db, {
      userId: input.userId,
      sourceId: source.id,
      chatId: input.chatId,
      deliver: true,
      nextSlotAt: null, // M4 fills the slot; a null slot is not due
      now,
    });
    if (!subscription) throw new Coded(E.DUPLICATE, 'same source and chat');

    // Everything the feed showed is "seen" the moment it is recorded (§5.4).
    const posts = insertPosts(db, source.id, input.items, now);

    let pending = 0;
    if (input.deliverLatest) {
      const newest = [...posts].sort((a, b) => (a.published_at ?? 0) - (b.published_at ?? 0)).slice(-input.backfillCount);
      for (const post of newest) {
        markPendingDelivery(db, post.id, input.chatId, now);
        pending++;
      }
      if (pending > 0) enqueue(db, { kind: 'deliver_post', targetId: source.id, priority: PRIORITY.backfill, runAfter: now });
    }

    return { sourceId: source.id, pending };
  });
}
