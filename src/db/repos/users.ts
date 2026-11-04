import type { Db } from '../index.ts';

/** Only 'allowed' opens the bot; anything else (including an unknown string) is denied. */
export type UserStatus = 'pending' | 'allowed' | 'blocked';

export interface UserRow {
  id: number;
  tg_user_id: number;
  tz: string;
  locale: string | null;
  created_at: number;
  status: string;
}

/** First contact creates the row; later contacts reuse it (OQ-15). The upsert never changes status. */
export function ensureUser(db: Db, tgUserId: number, now = Date.now()): UserRow {
  db.prepare('INSERT INTO users (tg_user_id, created_at) VALUES (?, ?) ON CONFLICT(tg_user_id) DO NOTHING').run(tgUserId, now);
  return db.prepare('SELECT * FROM users WHERE tg_user_id = ?').get(tgUserId) as unknown as UserRow;
}

export function getUser(db: Db, tgUserId: number): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE tg_user_id = ?').get(tgUserId) as unknown as UserRow | undefined;
}

/** Admin decision on an existing row; a missing row stays missing (the admin adds it instead). */
export function setUserStatus(db: Db, tgUserId: number, status: UserStatus): void {
  db.prepare('UPDATE users SET status = ? WHERE tg_user_id = ?').run(status, tgUserId);
}

/** Admin approval: creates the row or flips it to 'allowed', touching nothing else. */
export function upsertAllowedUser(db: Db, tgUserId: number, now = Date.now()): UserRow {
  return db
    .prepare("INSERT INTO users (tg_user_id, created_at, status) VALUES (?, ?, 'allowed') ON CONFLICT(tg_user_id) DO UPDATE SET status = 'allowed' RETURNING *")
    .get(tgUserId, now) as unknown as UserRow;
}

export interface UserListItem extends UserRow {
  source_count: number;
}

/** Admin users list: newest first, with the subscription count the row prints. */
export function listUsers(db: Db, limit: number, offset: number): { rows: UserListItem[]; total: number } {
  const total = (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  const rows = db
    .prepare(
      `SELECT u.*, (SELECT COUNT(*) FROM subscriptions sub WHERE sub.user_id = u.id) AS source_count
       FROM users u ORDER BY u.id DESC LIMIT ? OFFSET ?`,
    )
    .all(limit, offset) as unknown as UserListItem[];
  return { rows, total };
}

export function userStats(db: Db): { all: number; allowed: number; pending: number; blocked: number } {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(status = 'allowed'), 0) AS allowed,
              COALESCE(SUM(status = 'pending'), 0) AS pending,
              COALESCE(SUM(status = 'blocked'), 0) AS blocked
       FROM users`,
    )
    .get() as unknown as { total: number; allowed: number; pending: number; blocked: number };
  return { all: row.total, allowed: row.allowed, pending: row.pending, blocked: row.blocked };
}

/** Notify-all: the recipients are exactly the users the gate would let in. */
export function listAllowedTgIds(db: Db): number[] {
  const rows = db.prepare("SELECT tg_user_id FROM users WHERE status = 'allowed' ORDER BY tg_user_id").all() as Array<{ tg_user_id: number }>;
  return rows.map((row) => row.tg_user_id);
}

/** The bot's interface language lives on the user row, so it survives a restart. */
export function setLocale(db: Db, tgUserId: number, locale: string): void {
  db.prepare('UPDATE users SET locale = ? WHERE tg_user_id = ?').run(locale, tgUserId);
}
