import type { Db } from '../index.ts';
import { formatContentTypes, parseContentTypes, type ContentKind } from '../../platform/content-types.ts';

export interface SubscriptionRow {
  id: number;
  user_id: number;
  source_id: number;
  chat_id: number;
  deliver: number;
  next_slot_at: number | null;
  created_at: number;
  /** `video,short,post`; NULL means every kind. */
  content_types: string | null;
  /** ADR-020: this chat's own keyword list; NULL falls back to the user's default. */
  keywords: string | null;
}

export interface SubscriptionInput {
  userId: number;
  sourceId: number;
  chatId: number;
  deliver: boolean;
  nextSlotAt: number | null;
  /** The kinds this chat watches; null keeps every one. */
  contentTypes?: ContentKind[] | null;
  /** ADR-020: comma list; null or empty falls back to the user's default. */
  keywords?: string | null;
  now?: number;
}

/** Returns null when this (source, chat) pair already exists — the caller maps that to E_DUPLICATE. */
export function insertSubscription(db: Db, input: SubscriptionInput): SubscriptionRow | null {
  const row = db
    .prepare(
      `INSERT INTO subscriptions (user_id, source_id, chat_id, deliver, next_slot_at, created_at, content_types, keywords)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source_id, chat_id) DO NOTHING
       RETURNING *`,
    )
    .get(
      input.userId,
      input.sourceId,
      input.chatId,
      input.deliver ? 1 : 0,
      input.nextSlotAt,
      input.now ?? Date.now(),
      input.contentTypes == null ? null : formatContentTypes(input.contentTypes),
      input.keywords ?? null,
    ) as unknown as SubscriptionRow | undefined;
  return row ?? null;
}

export function findSubscription(db: Db, sourceId: number, chatId: number): SubscriptionRow | undefined {
  return db.prepare('SELECT * FROM subscriptions WHERE source_id = ? AND chat_id = ?').get(sourceId, chatId) as unknown as SubscriptionRow | undefined;
}

/** OQ-11: the 250 limit counts subscriptions, which is what S1 prints. */
/** True when any of this user's chats already follows the source. */
export function subscribedByUser(db: Db, userId: number, sourceId: number): boolean {
  return db.prepare('SELECT 1 AS n FROM subscriptions WHERE user_id = ? AND source_id = ? LIMIT 1').get(userId, sourceId) !== undefined;
}

export function countSubscriptionsForUser(db: Db, userId: number): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM subscriptions WHERE user_id = ?').get(userId) as { n: number };
  return row.n;
}

export function deleteSubscription(db: Db, userId: number, sourceId: number): SubscriptionRow | undefined {
  return db
    .prepare('DELETE FROM subscriptions WHERE user_id = ? AND source_id = ? RETURNING *')
    .get(userId, sourceId) as unknown as SubscriptionRow | undefined;
}

export interface SourceCard {
  subscription_id: number;
  source_id: number;
  platform: string;
  canonical_url: string;
  title: string | null;
  avatar_url: string | null;
  enabled: number;
  last_check_at: number | null;
  last_ok_at: number | null;
  last_error_code: string | null;
  consecutive_failures: number;
  interval_minutes: number | null;
  content_types: string | null;
  keywords: string | null;
}

/** S7 rows: the caller's subscriptions joined with their health fields (§6). */
export function listSourceCards(db: Db, userId: number, platform: string | null, limit: number, offset: number): { rows: SourceCard[]; total: number } {
  const filter = platform ? ' AND s.platform = ?' : '';
  const args: Array<string | number> = platform ? [userId, platform] : [userId];

  const total = (db.prepare(`SELECT COUNT(*) AS n FROM subscriptions sub JOIN sources s ON s.id = sub.source_id WHERE sub.user_id = ?${filter}`).get(...args) as {
    n: number;
  }).n;

  const rows = db
    .prepare(
      `SELECT sub.id AS subscription_id, s.id AS source_id, s.platform, s.canonical_url, s.title, s.avatar_url, s.enabled,
              s.last_check_at, s.last_ok_at, s.last_error_code, s.consecutive_failures, s.interval_minutes, sub.content_types, sub.keywords
       FROM subscriptions sub JOIN sources s ON s.id = sub.source_id
       WHERE sub.user_id = ?${filter}
       ORDER BY sub.id DESC LIMIT ? OFFSET ?`,
    )
    .all(...args, limit, offset) as unknown as SourceCard[];

  return { rows, total };
}

/** The chips under S7: only platforms this user actually has. */
export function platformsForUser(db: Db, userId: number): string[] {
  const rows = db
    .prepare('SELECT DISTINCT s.platform FROM subscriptions sub JOIN sources s ON s.id = sub.source_id WHERE sub.user_id = ? ORDER BY s.platform')
    .all(userId) as Array<{ platform: string }>;
  return rows.map((row) => row.platform);
}

/** S16 "all sources": the distinct sources this user follows, for one bulk cadence change. */
export function sourceIdsForUser(db: Db, userId: number): number[] {
  const rows = db.prepare('SELECT DISTINCT source_id FROM subscriptions WHERE user_id = ?').all(userId) as Array<{ source_id: number }>;
  return rows.map((row) => row.source_id);
}

/** Every member of one source with their timezone, for recomputing slots after a cadence change. */
export function subscriptionSlots(db: Db, sourceId: number): Array<{ id: number; tz: string }> {
  return db
    .prepare('SELECT sub.id AS id, u.tz AS tz FROM subscriptions sub JOIN users u ON u.id = sub.user_id WHERE sub.source_id = ?')
    .all(sourceId) as unknown as Array<{ id: number; tz: string }>;
}

/** S16: a cadence change takes effect at once instead of at the old slot. */
export function setNextSlot(db: Db, subscriptionId: number, at: number): void {
  db.prepare('UPDATE subscriptions SET next_slot_at = ? WHERE id = ?').run(at, subscriptionId);
}

/** Every card action is authorised by ownership of the subscription, never by the callback alone. */
export function ownsSource(db: Db, userId: number, sourceId: number): boolean {
  return db.prepare('SELECT 1 AS ok FROM subscriptions WHERE user_id = ? AND source_id = ?').get(userId, sourceId) !== undefined;
}

/** Admin user details: platform + title of everything this user follows. */
export function listSourcesForUser(db: Db, userId: number): Array<{ source_id: number; platform: string; title: string | null }> {
  return db
    .prepare(
      `SELECT DISTINCT s.id AS source_id, s.platform, s.title FROM subscriptions sub JOIN sources s ON s.id = sub.source_id
       WHERE sub.user_id = ? ORDER BY s.platform, s.title`,
    )
    .all(userId) as unknown as Array<{ source_id: number; platform: string; title: string | null }>;
}

export function getSourceCard(db: Db, userId: number, sourceId: number): SourceCard | undefined {
  return db
    .prepare(
      `SELECT sub.id AS subscription_id, s.id AS source_id, s.platform, s.canonical_url, s.title, s.avatar_url, s.enabled,
              s.last_check_at, s.last_ok_at, s.last_error_code, s.consecutive_failures, s.interval_minutes, sub.content_types, sub.keywords
       FROM subscriptions sub JOIN sources s ON s.id = sub.source_id
       WHERE sub.user_id = ? AND s.id = ?`,
    )
    .get(userId, sourceId) as unknown as SourceCard | undefined;
}

/** The card behind one S7 row: a user may follow the same channel from two chats. */
export function subscriptionCard(db: Db, userId: number, subscriptionId: number): SourceCard | undefined {
  return db
    .prepare(
      `SELECT sub.id AS subscription_id, s.id AS source_id, s.platform, s.canonical_url, s.title, s.avatar_url, s.enabled,
              s.last_check_at, s.last_ok_at, s.last_error_code, s.consecutive_failures, s.interval_minutes, sub.content_types, sub.keywords
       FROM subscriptions sub JOIN sources s ON s.id = sub.source_id
       WHERE sub.user_id = ? AND sub.id = ?`,
    )
    .get(userId, subscriptionId) as unknown as SourceCard | undefined;
}

/** The picker writes one subscription it owns; the source row is shared, the choice is not. */
export function setSubscriptionContentTypes(db: Db, userId: number, subscriptionId: number, kinds: ContentKind[]): boolean {
  const result = db.prepare('UPDATE subscriptions SET content_types = ? WHERE id = ? AND user_id = ?').run(formatContentTypes(kinds), subscriptionId, userId);
  return Number(result.changes) > 0;
}

/** ADR-020: `raw` NULL clears the list, which hands the row back to the user's default. */
export function setSubscriptionKeywords(db: Db, userId: number, subscriptionId: number, raw: string | null): boolean {
  const result = db.prepare('UPDATE subscriptions SET keywords = ? WHERE id = ? AND user_id = ?').run(raw, subscriptionId, userId);
  return Number(result.changes) > 0;
}

/** The kinds the chats on this source asked for together; null when one row predates the picker. */
export function sourceContentKinds(db: Db, sourceId: number): ContentKind[] | null {
  const rows = db.prepare('SELECT content_types FROM subscriptions WHERE source_id = ?').all(sourceId) as Array<{ content_types: string | null }>;
  const chosen = rows.map((row) => parseContentTypes(row.content_types));
  if (chosen.some((kinds) => kinds === null)) return null;

  const union = new Set<ContentKind>();
  for (const kinds of chosen) for (const kind of kinds ?? []) union.add(kind);
  return [...union];
}

export interface DeliveryTargetRow {
  chat_id: number;
  tg_chat_id: number;
  message_thread_id: number | null;
  type: string;
  /** This chat's own choice of kinds; NULL means every one. */
  content_types: string | null;
  /** ADR-020: this chat's keyword list, and the user's fallback behind it. */
  keywords: string | null;
  default_keywords: string | null;
}

/** Stage 7 targets: every active subscription whose chat may still receive posts (§9.4). */
export function deliveryTargets(db: Db, sourceId: number): DeliveryTargetRow[] {
  return db
    .prepare(
      `SELECT c.id AS chat_id, c.tg_chat_id, c.message_thread_id, c.type, sub.content_types, sub.keywords, u.default_keywords
       FROM subscriptions sub JOIN chats c ON c.id = sub.chat_id JOIN users u ON u.id = sub.user_id
       WHERE sub.source_id = ? AND sub.deliver = 1 AND c.can_post = 1
       ORDER BY c.id`,
    )
    .all(sourceId) as unknown as DeliveryTargetRow[];
}
