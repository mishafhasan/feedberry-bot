import type { Db } from '../db/index.ts';
import { enqueue, PRIORITY } from '../jobs/queue.ts';
import { slotAfter } from './slots.ts';

/** A slot older than this is skipped, not replayed: the bot was off, the feed moved on (ADR-010). */
export const LATE_SLOT_MS = 12 * 60 * 60 * 1000;

interface DueRow {
  source_id: number;
  subscription_id: number;
  next_slot_at: number | null;
  tz: string;
  interval_minutes: number | null;
}

export interface TickResult {
  sources: number;
  advanced: number;
  enqueued: number;
  cleanup: boolean;
}

const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** A daily retention run; `jobs_one_active` keeps it to one at a time. */
function enqueueCleanup(db: Db, now: number): boolean {
  const last = db.prepare("SELECT MAX(at) AS at FROM events WHERE code = 'cleanup'").get() as { at: number | null };
  if (last.at !== null && now - last.at < CLEANUP_INTERVAL_MS) return false;
  return enqueue(db, { kind: 'cleanup', targetId: 0, priority: PRIORITY.retry, runAfter: now });
}

/**
 * §4.2: one query for due subscriptions, then advance every due slot **before** enqueueing, so a
 * crash can never produce a hot loop. One fetch per source, shared by all its subscribers (ADR-004).
 */
export function tick(db: Db, now = Date.now()): TickResult {
  const due = db
    .prepare(
      `SELECT s.id AS source_id, sub.id AS subscription_id, sub.next_slot_at, u.tz, s.interval_minutes
       FROM sources s
       JOIN subscriptions sub ON sub.source_id = s.id
       JOIN users u ON u.id = sub.user_id
       WHERE s.enabled = 1 AND sub.deliver = 1
         AND (sub.next_slot_at IS NULL OR sub.next_slot_at <= ?)`,
    )
    .all(now) as unknown as DueRow[];

  const perSource = new Map<number, { due: DueRow[]; late: boolean }>();
  for (const row of due) {
    const entry = perSource.get(row.source_id) ?? { due: [], late: true };
    entry.due.push(row);
    // Fresh if any due subscription is inside the late window (a NULL slot counts as fresh).
    if (row.next_slot_at === null || now - row.next_slot_at <= LATE_SLOT_MS) entry.late = false;
    perSource.set(row.source_id, entry);
  }

  const advance = db.prepare('UPDATE subscriptions SET next_slot_at = ? WHERE id = ?');
  let advanced = 0;
  let enqueued = 0;

  for (const [sourceId, { due: rows, late }] of perSource) {
    for (const row of rows) {
      advance.run(slotAfter(now, row.tz, row.interval_minutes), row.subscription_id);
      advanced++;
    }
    if (!late && enqueue(db, { kind: 'fetch_source', targetId: sourceId, priority: PRIORITY.scheduled, runAfter: now })) enqueued++;
  }

  return { sources: perSource.size, advanced, enqueued, cleanup: enqueueCleanup(db, now) };
}
