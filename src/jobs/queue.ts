import type { Db } from '../db/index.ts';

export type JobKind = 'fetch_source' | 'deliver_post' | 'manual_check' | 'cleanup';

/** §4.4 priorities. Backfill is below scheduled so live posts never wait behind history. */
export const PRIORITY = { manual: 100, scheduled: 50, backfill: 40, retry: 10 } as const;

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
