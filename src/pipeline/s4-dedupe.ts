import type { Db } from '../db/index.ts';
import { Coded, E } from '../platform/errors.ts';
import type { FeedItem } from '../platform/feed/native.ts';
import type { SourceRef } from '../platform/registry.ts';
import { tx } from '../db/index.ts';
import { markPendingDelivery } from '../db/repos/deliveries.ts';
import { insertPosts, listSeenRows } from '../db/repos/posts.ts';
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
 * One identity is not enough — a guid can be regenerated, a link can gain tracking params, and a
 * republished item can change both — so guid, link and (title, published) fingerprint all count.
 */
export function unseenItems(db: Db, sourceId: number, items: FeedItem[]): FeedItem[] {
  const seen = listSeenRows(db, sourceId);
  const guids = new Set(seen.map((row) => normalizeGuid(row.guid)));
  const urls = new Set(seen.map((row) => row.url).filter((url): url is string => url !== null).map(normalizeUrl));
  const prints = new Set(seen.map((row) => fingerprint(titleOf(row.payload_json), row.published_at)).filter((print): print is string => print !== null));

  return items.filter((item) => {
    if (guids.has(normalizeGuid(item.guid))) return false;
    if (item.link !== null && urls.has(normalizeUrl(item.link))) return false;
    const print = fingerprint(item.title, item.publishedAt);
    return !(print !== null && prints.has(print));
  });
}

/** Feeds re-issue guids with a cache-busting tail; the base is the identity. */
export function normalizeGuid(guid: string): string {
  return guid.trim().toLowerCase().replace(/[?#].*$/, '');
}

/**
 * Two posts by one source with the same title at the same second are the same post, whatever
 * either identifier says. Null when the pair is too weak to compare.
 */
export function fingerprint(title: string | null | undefined, publishedAt: number | null): string | null {
  const name = (title ?? '').trim().toLowerCase();
  if (!name || publishedAt === null) return null;
  return `${publishedAt}|${name}`;
}

function titleOf(payloadJson: string | null): string | null {
  try {
    const parsed = JSON.parse(payloadJson ?? '{}') as { title?: string };
    return parsed.title ?? null;
  } catch {
    return null;
  }
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
