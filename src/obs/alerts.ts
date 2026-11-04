import type { Db } from '../db/index.ts';
import { countFailingSources, countSince, hasRecent, lastFetchOkAt, recordEvent } from '../db/repos/events.ts';
import { log } from '../obs/log.ts';

/** One Telegram DM to the operator (§13.1). Injected so tests can assert the count. */
export interface Notifier {
  notify(text: string): Promise<void>;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const CONSECUTIVE_LIMIT = 3;
const QUEUE_LIMIT = 100;
const SILENT_FETCH_MS = 26 * 60 * 60 * 1000;

export const alerts = {
  /** (a) three consecutive failures on one source, at most once per source per 24 h. */
  async sourceFailing(db: Db, notifier: Notifier, sourceId: number, code: string, now = Date.now()): Promise<boolean> {
    if (hasRecent(db, 'alert:source', sourceId, now - DAY_MS)) return false;
    recordEvent(db, { level: 'warn', code: 'alert:source', sourceId, detail: code, at: now });
    await notifier.notify(`Source #${sourceId} failed ${CONSECUTIVE_LIMIT} times in a row (${code}).`);
    return true;
  },

  /** (b) the queue is backing up. */
  async queueBacklog(db: Db, notifier: Notifier, now = Date.now()): Promise<boolean> {
    const queued = (db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE state = 'queued'").get() as { n: number }).n;
    if (queued <= QUEUE_LIMIT) return false;
    if (hasRecent(db, 'alert:queue', null, now - DAY_MS)) return false;
    recordEvent(db, { level: 'warn', code: 'alert:queue', detail: `${queued} jobs`, at: now });
    await notifier.notify(`Job queue has ${queued} queued jobs.`);
    return true;
  },

  /** (c) nothing has fetched successfully in 26 h while sources exist. */
  async silent(db: Db, notifier: Notifier, now = Date.now()): Promise<boolean> {
    const sources = (db.prepare('SELECT COUNT(*) AS n FROM sources WHERE enabled = 1').get() as { n: number }).n;
    if (sources === 0) return false;
    const last = lastFetchOkAt(db);
    if (last !== null && now - last < SILENT_FETCH_MS) return false;
    if (hasRecent(db, 'alert:silent', null, now - DAY_MS)) return false;
    recordEvent(db, { level: 'warn', code: 'alert:silent', detail: `${sources} sources`, at: now });
    await notifier.notify(`No successful fetch in 26 h across ${sources} sources.`);
    return true;
  },
};

/** Counters for `/status` (§13.1). */
export function counters(db: Db, now = Date.now()): Record<string, number> {
  const since = now - DAY_MS;
  return {
    fetchOk: countSince(db, 'fetch_ok', since),
    fetchFail: countSince(db, 'fetch_fail', since),
    sendOk: countSince(db, 'send_ok', since),
    sendFail: countSince(db, 'send_fail', since),
    failingSources: countFailingSources(db),
  };
}

export function logAlert(kind: string): void {
  log('warn', 'alert_sent', { kind });
}
