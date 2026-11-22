/**
 * ADR-033's ledger, offline: the day bucket answers RPD, the minute bucket RPM, a 429 its own deadline,
 * and each bucket rolls over on its own clock.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDb } from '../../src/db/index.ts';
import { quotaLedger } from '../../src/digest/quota.ts';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

test('the ledger skips a rung whose day is spent, and a new UTC day starts empty', () => {
  const db = openDb(':memory:');
  let now = Date.UTC(2026, 10, 22, 9, 0, 0);
  const ledger = quotaLedger(db, () => now);
  const spendAcrossMinutes = (times: number): void => {
    for (let call = 0; call < times; call++) {
      now += MINUTE;
      ledger.spend('gemini-3.8-flash');
    }
  };

  assert.equal(ledger.spent('gemini-3.8-flash', 0), false, 'nothing spent yet');
  spendAcrossMinutes(19);
  assert.equal(ledger.spent('gemini-3.8-flash', 0), false, 'nineteen of twenty');
  spendAcrossMinutes(1);
  assert.equal(ledger.spent('gemini-3.8-flash', 0), true, 'twenty a day is the cap');
  now += DAY;
  assert.equal(ledger.spent('gemini-3.8-flash', 0), false, 'a new day is a new budget');
  db.close();
});

test('the reserve keeps the script its last slots on every rung', () => {
  const db = openDb(':memory:');
  let now = Date.UTC(2026, 10, 22, 9, 0, 0);
  const ledger = quotaLedger(db, () => now);
  for (let call = 0; call < 18; call++) {
    now += MINUTE;
    ledger.spend('gemini-3.6-flash');
  }
  assert.equal(ledger.spent('gemini-3.6-flash', 0), false, 'the summaries may still ask');
  assert.equal(ledger.spent('gemini-3.6-flash', 2), true, 'but not the two slots the script keeps');
  db.close();
});

test('the minute bucket spreads a busy digest, and a block expires on its own clock', () => {
  const db = openDb(':memory:');
  let now = Date.UTC(2026, 10, 22, 9, 0, 0);
  const ledger = quotaLedger(db, () => now);
  for (let call = 0; call < 5; call++) ledger.spend('gemini-4-hydrogen');
  assert.equal(ledger.spent('gemini-4-hydrogen', 0), true, 'five a minute is the cap');
  now += MINUTE;
  assert.equal(ledger.spent('gemini-4-hydrogen', 0), false, 'the next minute frees the rung');

  ledger.spend('gemini-2.5-flash');
  ledger.block('gemini-2.5-flash', now + 30_000);
  assert.equal(ledger.spent('gemini-2.5-flash', 0), true, 'a 429 blocks without spending');
  now += 31_000;
  assert.equal(ledger.spent('gemini-2.5-flash', 0), false, 'and the block is not a day');
  db.close();
});
