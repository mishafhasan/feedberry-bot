import type { Db } from '../index.ts';

export interface UserRow {
  id: number;
  tg_user_id: number;
  tz: string;
  locale: string | null;
  created_at: number;
}

/** First contact creates the row; later contacts reuse it (OQ-15). */
export function ensureUser(db: Db, tgUserId: number, now = Date.now()): UserRow {
  db.prepare('INSERT INTO users (tg_user_id, created_at) VALUES (?, ?) ON CONFLICT(tg_user_id) DO NOTHING').run(tgUserId, now);
  return db.prepare('SELECT * FROM users WHERE tg_user_id = ?').get(tgUserId) as unknown as UserRow;
}
