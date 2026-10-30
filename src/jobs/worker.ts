import { log } from '../obs/log.ts';
import { deliverPending, runFetchSource, type RunDeps } from '../pipeline/run.ts';
import { tick } from '../scheduler/tick.ts';
import { claim, complete, fail, recoverStale, type JobRow } from './queue.ts';

export interface WorkerDeps extends RunDeps {
  workerConcurrency: number;
}

/** Claims one job and runs it. Returns false when the queue is empty. */
export async function runOnce(deps: WorkerDeps, now = Date.now()): Promise<boolean> {
  recoverStale(deps.db, now);
  const job = claim(deps.db, now);
  if (!job) return false;

  try {
    await execute(deps, job, now);
    complete(deps.db, job.id);
  } catch (err) {
    const cause = message(err);
    fail(deps.db, job.id, cause);
    log('error', 'job_failed', { job: job.id, kind: job.kind, cause });
  }
  return true;
}

async function execute(deps: WorkerDeps, job: JobRow, now: number): Promise<void> {
  switch (job.kind) {
    case 'fetch_source':
    case 'manual_check':
      // A manual check is a fetch that never touches next_slot_at (§4.6).
      await runFetchSource(deps, job.target_id, now);
      return;
    case 'deliver_post':
      await deliverPending(deps, job.target_id, now);
      return;
    default:
      return; // cleanup arrives with the media pipeline in M5
  }
}

/**
 * One loop for the whole process (§4.1): every poll claims at most one job, and the slot tick
 * runs at most every 30 s. Idle cost is two indexed queries.
 */
export function startWorker(deps: WorkerDeps, options: { pollMs?: number; slotMs?: number } = {}): { stop(): void } {
  const pollMs = options.pollMs ?? 1000;
  const slotMs = options.slotMs ?? 30_000;
  let inFlight = 0;
  let lastSlot = 0;

  const timer = setInterval(() => {
    if (inFlight >= deps.workerConcurrency) return;
    inFlight++;
    void (async () => {
      try {
        const now = Date.now();
        if (now - lastSlot >= slotMs) {
          lastSlot = now;
          tick(deps.db, now);
        }
        await runOnce(deps, now);
      } catch (err) {
        log('error', 'worker_loop_failed', { cause: message(err) });
      } finally {
        inFlight--;
      }
    })();
  }, pollMs);

  return { stop: () => clearInterval(timer) };
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));
