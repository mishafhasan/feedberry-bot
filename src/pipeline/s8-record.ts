import type { Db } from '../db/index.ts';
import type { DeliveryStatus } from '../db/repos/deliveries.ts';

export interface DeliveryRecord {
  /** null in Download mode: a single post link has no `posts` row (ADR-013). */
  postId: number | null;
  chatId: number;
  status: DeliveryStatus;
  parts: number;
  messageIds: string | null;
  errorCode: string | null;
  now?: number;
}

/** Stage 8: one row per (post, chat), updated in place so a retry never duplicates a message. */
export function recordDelivery(db: Db, record: DeliveryRecord): void {
  db.prepare(
    `INSERT INTO deliveries (post_id, chat_id, status, parts, message_ids, attempts, error_code, at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT(post_id, chat_id) DO UPDATE SET
       status = excluded.status,
       parts = excluded.parts,
       message_ids = excluded.message_ids,
       attempts = deliveries.attempts + 1,
       error_code = excluded.error_code,
       at = excluded.at`,
  ).run(record.postId, record.chatId, record.status, record.parts, record.messageIds, record.errorCode, record.now ?? Date.now());
}

/** Health fields on `sources` (§6). A success clears the failure streak. */
export function recordSuccess(db: Db, sourceId: number, now = Date.now()): void {
  db.prepare('UPDATE sources SET last_check_at = ?, last_ok_at = ?, last_error_code = NULL, last_error_at = NULL, consecutive_failures = 0 WHERE id = ?').run(
    now,
    now,
    sourceId,
  );
}

/** Returns the new consecutive-failure count so the caller can alert on the third one. */
export function recordFailure(db: Db, sourceId: number, code: string, now = Date.now()): number {
  db.prepare('UPDATE sources SET last_check_at = ?, last_error_code = ?, last_error_at = ?, consecutive_failures = consecutive_failures + 1 WHERE id = ?').run(
    now,
    code,
    now,
    sourceId,
  );
  const row = db.prepare('SELECT consecutive_failures AS n FROM sources WHERE id = ?').get(sourceId) as { n: number };
  return row.n;
}
