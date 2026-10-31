import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allowAdd, allowCallback, allowCheck, resetQuotas } from '../../src/bot/quotas.ts';

test('M9 quotas: callback and add windows, then the hourly check cap (§12.4)', () => {
  resetQuotas();

  assert.equal(allowCallback(1, 2000, 1000), true);
  assert.equal(allowCallback(1, 2000, 2500), false, 'inside the 2 s window');
  assert.equal(allowCallback(1, 2000, 3000), true, 'after it');

  assert.equal(allowAdd(1, 10_000, 10_000), true);
  assert.equal(allowAdd(1, 10_000, 15_000), false, 'inside the 10 s window');
  assert.equal(allowAdd(2, 10_000, 15_000), true, 'quotas are per user');

  for (let i = 0; i < 30; i++) assert.equal(allowCheck(1, 30, 100_000 + i), true, `check ${i}`);
  assert.equal(allowCheck(1, 30, 100_041), false, 'the 31st check in the hour is refused');
  assert.equal(allowCheck(1, 30, 100_041 + 3_600_001), true, 'the window rolls over after an hour');

  assert.equal(allowCallback(3, 0, 1), true, 'a zero interval disables the quota');
  assert.equal(allowAdd(3, 0, 1), true);
  assert.equal(allowCheck(3, 0, 1), true);
});
