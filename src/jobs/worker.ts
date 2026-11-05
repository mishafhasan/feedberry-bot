import { log } from '../obs/log.ts';
import { alerts } from '../obs/alerts.ts';
import { E, isCoded } from '../platform/errors.ts';
import { deliverPending, runFetchSource, type RunDeps } from '../pipeline/run.ts';
import { runRetention } from '../pipeline/s9-cleanup.ts';
import { recordEvent } from '../db/repos/events.ts';
import { tick } from '../scheduler/tick.ts';
import { claim, complete, fail, recoverStale, reschedule, retryDelayMs, type JobRow } from './queue.ts';

/** §9.2: a flood wait longer than the inline limit frees the worker and retries later. */
const FLOOD_REQUEUE_MS = 5 * 60_000;

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
    const code = isCoded(err) ? err.code : E.TG_UNKNOWN;

    if (code === E.TG_429) {
      // A flood wait never consumes an attempt: requeue and let the worker go.
      reschedule(deps.db, job.id, now + FLOOD_REQUEUE_MS, code);
      deps.db.prepare('UPDATE jobs SET attempts = MAX(attempts - 1, 0) WHERE id = ?').run(job.id);
      log('warn', 'job_requeued_429', { job: job.id, kind: job.kind });
      return true;
    }

    const delay = retryDelayMs(code, job.attempts);
    if (delay === null) {
      fail(deps.db, job.id, cause);
      log('error', 'job_failed', { job: job.id, kind: job.kind, code, cause });
    } else {
      reschedule(deps.db, job.id, now + delay, code);
      // The cause is the only thing that tells a 5xx, a login wall and a timeout apart.
      log('warn', 'job_retry', { job: job.id, kind: job.kind, code, inMs: delay, cause });
    }
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
    case 'cleanup': {
      // §13.1 retention; the event also marks the daily run for the scheduler.
      const result = runRetention(deps.db, deps.cfg.limits.maxSourceAgeDays, now);
      recordEvent(deps.db, { level: 'info', code: 'cleanup', detail: `${result.posts} posts, ${result.events} events`, at: now });
      return;
    }
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
          // §13.1 alerts that are cheap to check once per slot.
          if (deps.notifier) {
            await alerts.silent(deps.db, deps.notifier, now).catch(() => false);
            await alerts.queueBacklog(deps.db, deps.notifier, now).catch(() => false);
          }
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
