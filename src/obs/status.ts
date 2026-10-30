import type { Db } from '../db/index.ts';
import { counters } from './alerts.ts';

/** `/status`, admin only (§13.1): queued jobs, failing sources, last 24 h counters. */
export function statusText(db: Db, now = Date.now()): string {
  const jobs = db.prepare('SELECT state, COUNT(*) AS n FROM jobs GROUP BY state').all() as Array<{ state: string; n: number }>;
  const byState = new Map(jobs.map((row) => [row.state, row.n]));
  const sources = db.prepare('SELECT COUNT(*) AS n FROM sources').get() as { n: number };
  const counts = counters(db, now);

  return [
    '📊 FeedBerry status',
    `Jobs: ${byState.get('queued') ?? 0} queued, ${byState.get('running') ?? 0} running, ${byState.get('failed') ?? 0} failed`,
    `Sources: ${sources.n} total, ${counts.failingSources ?? 0} failing`,
    `Last 24 h: ${counts.fetchOk ?? 0} fetches ok, ${counts.fetchFail ?? 0} failed`,
    `Last 24 h: ${counts.sendOk ?? 0} posts sent, ${counts.sendFail ?? 0} failed`,
  ].join('\n');
}
