/**
 * ADR-029: the worker refreshes its claim while a job runs, so a digest that outlives the stale window
 * is never handed to a second worker (which would send the digest twice).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDb } from '../../src/db/index.ts';
import { claim, complete, enqueue, touch } from '../../src/jobs/queue.ts';

test('touch refreshes a running claim and never revives a finished job', () => {
  const db = openDb(':memory:');

  try {
    enqueue(db, { kind: 'digest', targetId: 7, priority: 50, runAfter: 0 });
    const job = claim(db, 0);
    assert.ok(job);
    const read = (): { locked_at: number | null; state: string } | undefined =>
      db.prepare('SELECT locked_at, state FROM jobs WHERE id = ?').get(job?.id ?? 0) as { locked_at: number | null; state: string } | undefined;

    touch(db, job.id, 5_000);
    assert.equal(read()?.locked_at, 5_000, 'a live run moves its lock with it');
    assert.equal(read()?.state, 'running');

    complete(db, job.id);
    touch(db, job.id, 9_000);
    assert.equal(read()?.locked_at, 5_000, 'a done job is left alone');
  } finally {
    db.close();
  }
});
