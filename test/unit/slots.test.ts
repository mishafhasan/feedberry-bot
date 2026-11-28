import assert from 'node:assert/strict';
import { test } from 'node:test';
import { digestSlot, slotAfter } from '../../src/scheduler/slots.ts';

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

test('M4 slots: a nonexistent spring-forward hour resolves to the first valid local time', () => {
  assert.equal(digestSlot(utc(2026, 3, 7, 12), 'America/New_York', 2), utc(2026, 3, 8, 7), '02:00 EST never occurs, so the slot moves to 03:00 EDT');
  assert.equal(digestSlot(utc(2026, 3, 28, 12), 'Europe/Berlin', 2), utc(2026, 3, 29, 1), '02:00 CET never occurs, so the slot moves to 03:00 CEST');
});

test('M4 slots: a repeated fall-back hour uses the later instant', () => {
  assert.equal(digestSlot(utc(2026, 10, 31, 12), 'America/New_York', 1), utc(2026, 11, 1, 6), 'the second 01:00 is 06:00 UTC');
  assert.equal(digestSlot(utc(2026, 10, 24, 12), 'Europe/Berlin', 2), utc(2026, 10, 25, 1), 'the second 02:00 is 01:00 UTC');
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

test('M4 slots: a half-hour zone lands on its own wall clock', () => {
  // Colombo is UTC+5:30, so 08:00 local is 02:30 UTC - the case a fixed-offset shortcut would miss.
  assert.equal(slotAfter(utc(2026, 1, 15, 1), 'Asia/Colombo', null), utc(2026, 1, 15, 2) + 30 * 60_000);
  assert.equal(digestSlot(utc(2026, 1, 15, 1), 'Asia/Colombo', 8), utc(2026, 1, 15, 2) + 30 * 60_000);
});

test('M4 slots: an unknown zone degrades to UTC instead of throwing inside the tick', () => {
  // The tick swallows its own errors into a log line, so one bad users.tz would stop every schedule.
  assert.equal(slotAfter(utc(2025, 10, 24, 7), 'Mars/Base', null), utc(2025, 10, 24, 8));
  assert.equal(digestSlot(utc(2025, 10, 24, 7), 'Mars/Base', 9), utc(2025, 10, 24, 9));
});
