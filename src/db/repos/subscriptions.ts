import type { Db } from '../index.ts';

export interface SubscriptionRow {
  id: number;
  user_id: number;
  source_id: number;
  chat_id: number;
  deliver: number;
  next_slot_at: number | null;
  created_at: number;
}

export interface SubscriptionInput {
  userId: number;
  sourceId: number;
  chatId: number;
  deliver: boolean;
  nextSlotAt: number | null;
  now?: number;
}

/** Returns null when this (source, chat) pair already exists — the caller maps that to E_DUPLICATE. */
export function insertSubscription(db: Db, input: SubscriptionInput): SubscriptionRow | null {
  const row = db
    .prepare(
      `INSERT INTO subscriptions (user_id, source_id, chat_id, deliver, next_slot_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(source_id, chat_id) DO NOTHING
       RETURNING *`,
    )
    .get(input.userId, input.sourceId, input.chatId, input.deliver ? 1 : 0, input.nextSlotAt, input.now ?? Date.now()) as unknown as
    | SubscriptionRow
    | undefined;
  return row ?? null;
}

export function findSubscription(db: Db, sourceId: number, chatId: number): SubscriptionRow | undefined {
  return db.prepare('SELECT * FROM subscriptions WHERE source_id = ? AND chat_id = ?').get(sourceId, chatId) as unknown as SubscriptionRow | undefined;
}

/** OQ-11: the 250 limit counts subscriptions, which is what S1 prints. */
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
  title: string | null;
  avatar_url: string | null;
  enabled: number;
  last_check_at: number | null;
  last_ok_at: number | null;
  last_error_code: string | null;
  consecutive_failures: number;
  interval_minutes: number | null;
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
      `SELECT sub.id AS subscription_id, s.id AS source_id, s.platform, s.title, s.avatar_url, s.enabled,
              s.last_check_at, s.last_ok_at, s.last_error_code, s.consecutive_failures, s.interval_minutes
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

/** Every card action is authorised by ownership of the subscription, never by the callback alone. */
export function ownsSource(db: Db, userId: number, sourceId: number): boolean {
  return db.prepare('SELECT 1 AS ok FROM subscriptions WHERE user_id = ? AND source_id = ?').get(userId, sourceId) !== undefined;
}

export function getSourceCard(db: Db, userId: number, sourceId: number): SourceCard | undefined {
  return db
    .prepare(
      `SELECT sub.id AS subscription_id, s.id AS source_id, s.platform, s.title, s.avatar_url, s.enabled,
              s.last_check_at, s.last_ok_at, s.last_error_code, s.consecutive_failures, s.interval_minutes
       FROM subscriptions sub JOIN sources s ON s.id = sub.source_id
       WHERE sub.user_id = ? AND s.id = ?`,
    )
    .get(userId, sourceId) as unknown as SourceCard | undefined;
}

export interface DeliveryTargetRow {
  chat_id: number;
  tg_chat_id: number;
  message_thread_id: number | null;
  type: string;
}

/** Stage 7 targets: every active subscription whose chat may still receive posts (§9.4). */
export function deliveryTargets(db: Db, sourceId: number): DeliveryTargetRow[] {
  return db
    .prepare(
      `SELECT c.id AS chat_id, c.tg_chat_id, c.message_thread_id, c.type
       FROM subscriptions sub JOIN chats c ON c.id = sub.chat_id
       WHERE sub.source_id = ? AND sub.deliver = 1 AND c.can_post = 1
       ORDER BY c.id`,
    )
    .all(sourceId) as unknown as DeliveryTargetRow[];
}
