import type { Db } from '../index.ts';

export type DeliveryStatus = 'pending' | 'sent' | 'failed' | 'skipped';

export interface DeliveryRow {
  id: number;
  post_id: number;
  chat_id: number;
  status: DeliveryStatus;
  parts: number | null;
  message_ids: string | null;
  attempts: number;
  error_code: string | null;
  at: number;
}

/**
 * Backfill marker (M3). `pending` means "recorded, not sent yet": M4/M5 deliver these oldest
 * first. One row per (post, chat) so two subscribers never collide.
 */
export function markPendingDelivery(db: Db, postId: number, chatId: number, now = Date.now()): void {
  db.prepare("INSERT INTO deliveries (post_id, chat_id, status, at) VALUES (?, ?, 'pending', ?) ON CONFLICT(post_id, chat_id) DO NOTHING").run(
    postId,
    chatId,
    now,
  );
}

export function listPendingForSource(db: Db, sourceId: number, chatId: number): DeliveryRow[] {
  return db
    .prepare(
      `SELECT d.* FROM deliveries d JOIN posts p ON p.id = d.post_id
       WHERE p.source_id = ? AND d.chat_id = ? AND d.status = 'pending'
       ORDER BY p.published_at ASC, p.id ASC`,
    )
    .all(sourceId, chatId) as unknown as DeliveryRow[];
}

/** MAX_DOWNLOADS_PER_DAY is counted per user over Download-mode deliveries (post_id IS NULL). */
export function countDownloadsSince(db: Db, ownerUserId: number, since: number): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM deliveries d JOIN chats c ON c.id = d.chat_id
       WHERE c.owner_user_id = ? AND d.post_id IS NULL AND d.at >= ?`,
    )
    .get(ownerUserId, since) as { n: number };
  return row.n;
}
