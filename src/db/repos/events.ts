import type { Db } from '../index.ts';

export interface EventInput {
  level: 'info' | 'warn' | 'error';
  code: string;
  sourceId?: number | null;
  chatId?: number | null;
  detail?: string | null;
  at?: number;
}

/** §13.1: counters and failure reasons live in `events`; there is no metrics server. */
export function recordEvent(db: Db, event: EventInput): void {
  db.prepare('INSERT INTO events (at, level, code, source_id, chat_id, detail) VALUES (?, ?, ?, ?, ?, ?)').run(
    event.at ?? Date.now(),
    event.level,
    event.code,
    event.sourceId ?? null,
    event.chatId ?? null,
    event.detail ?? null,
  );
}

export function countSince(db: Db, code: string, since: number): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM events WHERE code = ? AND at >= ?').get(code, since) as { n: number };
  return row.n;
}

/** `IS` is NULL-safe: an alert without a source passes null and matches the NULL it stored. */
export function hasRecent(db: Db, code: string, sourceId: number | null, since: number): boolean {
  return db.prepare('SELECT 1 AS ok FROM events WHERE code = ? AND source_id IS ? AND at >= ? LIMIT 1').get(code, sourceId, since) !== undefined;
}

export function countFailingSources(db: Db): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM sources WHERE consecutive_failures >= 3').get() as { n: number };
  return row.n;
}

export function lastFetchOkAt(db: Db): number | null {
  const row = db.prepare("SELECT MAX(at) AS at FROM events WHERE code = 'fetch_ok'").get() as { at: number | null };
  return row.at;
}

export interface AccessRequest {
  tg_user_id: number;
  username: string | null;
}

/** Who asked for access, once per user; an approved user drops off the operator's list. */
export function recentAccessRequests(db: Db, limit: number): AccessRequest[] {
  return db
    .prepare(
      `SELECT chat_id AS tg_user_id, MAX(detail) AS username FROM events
       WHERE code = 'access_requested' AND chat_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM users u WHERE u.tg_user_id = events.chat_id AND u.status = 'allowed')
       GROUP BY chat_id ORDER BY MAX(id) DESC LIMIT ?`,
    )
    .all(limit) as unknown as AccessRequest[];
}

/** Add-user by @mention: the id the requester's event already carries. */
export function findAccessRequestByUsername(db: Db, username: string): number | null {
  const row = db
    .prepare("SELECT chat_id AS id FROM events WHERE code = 'access_requested' AND LOWER(detail) = LOWER(?) ORDER BY id DESC LIMIT 1")
    .get(username) as { id: number } | undefined;
  return row?.id ?? null;
}
