import { capsFor, type DigestConfig } from '../config.ts';
import type { Db } from '../db/index.ts';
import { blockQuota, quotaRow, spendQuota } from '../db/repos/digests.ts';
import { geminiClient, type Gemini, type Ledger } from './gemini.ts';

const utcDay = (now: number): string => new Date(now).toISOString().slice(0, 10);
const minuteOf = (now: number): number => Math.floor(now / 60_000);

/**
 * ADR-033: the free tier's caps as a ledger the client consults before every request. The day bucket
 * answers RPD (the binding limit), the minute bucket answers RPM (three summaries run at once), and a
 * 429 the provider still sends adds its own deadline on top.
 */
export function quotaLedger(db: Db, clock: () => number = Date.now): Ledger {
  return {
    spent(model, reserve) {
      const now = clock();
      const caps = capsFor(model);
      const row = quotaRow(db, model);
      if (row === undefined) return false;
      if (row.blocked_until > now) return true;
      if (row.day === utcDay(now) && row.day_count >= caps.rpd - reserve) return true;
      return row.minute === minuteOf(now) && row.minute_count >= caps.rpm;
    },
    spend(model) {
      spendQuota(db, model, clock());
    },
    block(model, until) {
      blockQuota(db, model, until);
    },
  };
}

/** The production client: the two ladders plus the ledger that remembers each rung's free-tier caps. */
export const digestGemini = (cfg: DigestConfig, db: Db): Gemini => geminiClient(cfg, fetch, undefined, quotaLedger(db));
