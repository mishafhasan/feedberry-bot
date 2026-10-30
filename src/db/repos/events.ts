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

export function hasRecent(db: Db, code: string, sourceId: number, since: number): boolean {
  return db.prepare('SELECT 1 AS ok FROM events WHERE code = ? AND source_id = ? AND at >= ? LIMIT 1').get(code, sourceId, since) !== undefined;
}

export function countFailingSources(db: Db): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM sources WHERE consecutive_failures >= 3').get() as { n: number };
  return row.n;
}

export function lastFetchOkAt(db: Db): number | null {
  const row = db.prepare("SELECT MAX(at) AS at FROM events WHERE code = 'fetch_ok'").get() as { at: number | null };
  return row.at;
}
