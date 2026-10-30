import type { Db } from '../db/index.ts';
import type { DeliveryStatus } from '../db/repos/deliveries.ts';

export interface DeliveryRecord {
  postId: number;
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

/** Health fields on `sources` (§6). `ok=false` keeps the last success visible for S7's age. */
export function recordCheck(db: Db, sourceId: number, ok: boolean, now = Date.now()): void {
  if (ok) db.prepare('UPDATE sources SET last_check_at = ?, last_ok_at = ? WHERE id = ?').run(now, now, sourceId);
  else db.prepare('UPDATE sources SET last_check_at = ? WHERE id = ?').run(now, sourceId);
}
