/**
 * The header's clock: one helper, the reader's zone, and an explicit AM/PM. The two zones chosen are
 * the ones a fixed offset would get wrong — Colombo's half hour and New York's UTC-5 in winter — and
 * the dial edges catch a 12-hour formatter that prints 00:05 or 24:00.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { postHeader, postTime } from '../../src/render/caption.ts';

test('post time: the same instant reads as the reader’s wall clock, 12-hour with AM/PM', () => {
  const at = Date.UTC(2026, 10, 24, 9, 0); // 09:00 UTC
  assert.equal(postTime(at, 'Asia/Colombo'), 'Nov 24 02:30 PM', '+5:30, so a half-hour offset lands on :30');
  assert.equal(postTime(at, 'America/New_York'), 'Nov 24 04:00 AM', '-5 in November');
  assert.equal(postTime(at, 'UTC'), 'Nov 24 09:00 AM', 'UTC stays the default zone');
});

test('post time: the dial reads 12 at both ends, never 00 and never 24', () => {
  assert.equal(postTime(Date.UTC(2026, 10, 24, 0, 5), 'UTC'), 'Nov 24 12:05 AM');
  assert.equal(postTime(Date.UTC(2026, 10, 24, 12, 0), 'UTC'), 'Nov 24 12:00 PM');
  assert.equal(postTime(Date.UTC(2026, 10, 24, 13, 0), 'UTC'), 'Nov 24 01:00 PM');
});

test('post time: the day follows the reader’s zone, not the server’s', () => {
  // 19:30 UTC is already the 25th in Colombo and still the 24th in New York.
  const at = Date.UTC(2026, 10, 24, 19, 30);
  assert.equal(postTime(at, 'Asia/Colombo'), 'Nov 25 01:00 AM');
  assert.equal(postTime(at, 'America/New_York'), 'Nov 24 02:30 PM');
});

test('post header: both layouts print the same 12-hour clock in the reader’s zone', () => {
  const at = Date.UTC(2026, 10, 24, 9, 0);
  const params = { sourceTitle: 'WIRED', url: null, publishedAt: at, platform: 'rss', tz: 'Asia/Colombo' };

  const classic = postHeader(params);
  assert.match(classic, /⏱️ Time: Nov 24 02:30 PM$/, 'the classic layout ends with the reader’s clock');
  assert.doesNotMatch(classic, /14:30/, 'a 24-hour clock is what the reader complained about');

  const rich = postHeader({ ...params, rich: true });
  assert.match(rich, /^<h5>.*<\/h5><p>⏱️ <b>Time<\/b>: Nov 24 02:30 PM<\/p>$/, 'the rich layout prints the same string');
});
