import assert from 'node:assert/strict';
import { test } from 'node:test';
import { slotAfter } from '../../src/scheduler/slots.ts';

const utc = (year: number, month: number, day: number, hour: number): number => Date.UTC(year, month - 1, day, hour);

test('M4 slots: an interval override replaces the two daily slots', () => {
  assert.equal(slotAfter(1_000_000, 'UTC', 5), 1_000_000 + 5 * 60_000);
  assert.equal(slotAfter(1_000_000, 'UTC', 1440), 1_000_000 + 24 * 60 * 60_000);
});

test('M4 slots: 08:00 and 20:00 in UTC', () => {
  assert.equal(slotAfter(utc(2025, 10, 24, 7), 'UTC', null), utc(2025, 10, 24, 8));
  assert.equal(slotAfter(utc(2025, 10, 24, 9), 'UTC', null), utc(2025, 10, 24, 20));
  assert.equal(slotAfter(utc(2025, 10, 24, 21), 'UTC', null), utc(2025, 10, 25, 8));
});

test('M4 slots: DST is a wall-clock recomputation, not a fixed offset', () => {
  // Berlin switches to CEST on 2025-03-30 at 02:00 local, so 08:00 local is 06:00 UTC that day.
  assert.equal(slotAfter(utc(2025, 3, 30, 5), 'Europe/Berlin', null), utc(2025, 3, 30, 6));
  // The day before, 20:00 local is still 19:00 UTC (CET).
  assert.equal(slotAfter(utc(2025, 3, 29, 12), 'Europe/Berlin', null), utc(2025, 3, 29, 19));
  // After the switch back on 2025-10-26, 08:00 local is 07:00 UTC (CET).
  assert.equal(slotAfter(utc(2025, 10, 26, 5), 'Europe/Berlin', null), utc(2025, 10, 26, 7));
});

test('M4 slots: the next slot is always in the future', () => {
  const now = utc(2025, 10, 24, 12);
  for (const tz of ['UTC', 'Europe/Berlin', 'America/New_York', 'Asia/Tokyo', 'Australia/Sydney']) {
    for (let hour = 0; hour < 24; hour++) {
      const at = now + hour * 3_600_000;
      assert.ok(slotAfter(at, tz, null) > at, `${tz} at ${new Date(at).toISOString()}`);
    }
  }
});
