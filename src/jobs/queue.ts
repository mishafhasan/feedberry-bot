import type { Db } from '../db/index.ts';

export type JobState = 'queued' | 'running' | 'done' | 'failed';

export interface JobRow {
  id: number;
  kind: string;
  target_id: number;
  priority: number;
  run_after: number;
  state: JobState;
  attempts: number;
  locked_at: number | null;
  last_error: string | null;
}

export type JobKind = 'fetch_source' | 'deliver_post' | 'manual_check' | 'cleanup';

/** §4.4 priorities. Backfill is below scheduled so live posts never wait behind history. */
export const PRIORITY = { manual: 100, scheduled: 50, backfill: 40, retry: 10 } as const;

/** A crash mid-job loses one attempt: `running` older than 10 min goes back to `queued`. */
export const STALE_LOCK_MS = 10 * 60 * 1000;

export interface EnqueueInput {
  kind: JobKind;
  targetId: number;
  priority: number;
  runAfter?: number;
}

/** One active job per (kind, target): `jobs_one_active` turns a repeated enqueue into a no-op. */
export function enqueue(db: Db, input: EnqueueInput): boolean {
  const result = db
    .prepare("INSERT INTO jobs (kind, target_id, priority, run_after, state) VALUES (?, ?, ?, ?, 'queued') ON CONFLICT DO NOTHING")
    .run(input.kind, input.targetId, input.priority, input.runAfter ?? Date.now());
  return Number(result.changes) > 0;
}

/** The single claim statement of §4.4: two workers can never take the same job. */
export function claim(db: Db, now = Date.now()): JobRow | undefined {
  return db
    .prepare(
      `UPDATE jobs SET state = 'running', locked_at = ?, attempts = attempts + 1
       WHERE id = (SELECT id FROM jobs WHERE state = 'queued' AND run_after <= ?
                   ORDER BY priority DESC, run_after LIMIT 1)
       RETURNING *`,
    )
    .get(now, now) as unknown as JobRow | undefined;
}

export function recoverStale(db: Db, now = Date.now()): number {
  return Number(db.prepare("UPDATE jobs SET state = 'queued', locked_at = NULL WHERE state = 'running' AND locked_at < ?").run(now - STALE_LOCK_MS).changes);
}

export function complete(db: Db, id: number): void {
  db.prepare("UPDATE jobs SET state = 'done', last_error = NULL WHERE id = ?").run(id);
}

export function fail(db: Db, id: number, error: string): void {
  db.prepare("UPDATE jobs SET state = 'failed', last_error = ? WHERE id = ?").run(error, id);
}

/** Puts a job back with a delay; the backoff ladder that calls this lands in M8 (§4.5). */
export function reschedule(db: Db, id: number, runAfter: number, error: string | null = null): void {
  db.prepare("UPDATE jobs SET state = 'queued', run_after = ?, locked_at = NULL, last_error = ? WHERE id = ?").run(runAfter, error, id);
}
