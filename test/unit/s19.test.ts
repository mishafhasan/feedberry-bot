/**
 * S19 is the `/filter` rich screen (ADR-020). These cases pin the parts a user reads: the fallback
 * card first, one card per source with its pills, no dead 🗑, and a pager that belongs to this list.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SourceCard } from '../../src/db/repos/subscriptions.ts';
import { s19View } from '../../src/bot/screens/s19.ts';

const card = (over: Partial<SourceCard> = {}): SourceCard => ({
  subscription_id: 1,
  source_id: 10,
  platform: 'rss',
  canonical_url: 'https://wired.com',
  title: 'WIRED',
  avatar_url: null,
  enabled: 1,
  last_check_at: null,
  last_ok_at: null,
  last_error_code: null,
  consecutive_failures: 0,
  interval_minutes: null,
  content_types: null,
  keywords: null,
  ...over,
});

test('s19: the fallback is the first card and its copy explains itself', () => {
  const view = s19View({ cards: [], offset: 0, total: 0, page: 0, defaults: null });
  assert.match(view.html, /^<p><b>🔑 Keyword filters<\/b><br\/><i>Only the posts/);
  assert.match(view.html, /<b>Default<\/b><br\/>🏷 no filter — every post<br\/><i>Every source without a list/);
  assert.match(view.html, /No sources yet/, 'the empty state still offers the fallback');
});

test('s19: a source carries its own pills, and only a real list gets the trash', () => {
  const view = s19View({ cards: [card({ keywords: 'ai,security' }), card({ subscription_id: 2, keywords: null })], offset: 0, total: 2, page: 0, defaults: 'sport' });
  assert.match(view.html, /<b><a href="https:\/\/wired\.com">WIRED<\/a><\/b> \| RSS<br\/>🏷 ai, security/);
  assert.match(view.html, /data="kw:edit:1">✏️<\/tg-button><tg-button type="callback_data" style="danger" data="kw:clear:1">🗑/, 'a list can be cleared');
  assert.match(view.html, /🏷 follows the default \(sport\)/, 'a row without its own list says which default it uses');
  assert.match(view.html, /data="kw:edit:2">✏️<\/tg-button><\/tg-button-row>/, 'and offers no dead 🗑');
  assert.doesNotMatch(view.html, /kw:clear:2/);
});

test('s19: the pager belongs to this list, and the keyboard keeps only Back', () => {
  const view = s19View({ cards: [card()], offset: 5, total: 12, page: 1, defaults: null });
  assert.match(view.html, /data="kw:page:0">‹/);
  assert.match(view.html, /data="kw:page:2">›/);
  assert.doesNotMatch(view.html, /src:page:/, 'the source list pager is not reused by accident');
  assert.match(view.html, /<i>Showing 6–6 of 12<\/i>/);
  assert.deepEqual(view.keyboard.inline_keyboard.flat().map((button) => button.callback_data), ['nav:back']);
});

test('s19: a page with one card has no arrows', () => {
  const view = s19View({ cards: [card()], offset: 0, total: 1, page: 0, defaults: null });
  assert.doesNotMatch(view.html, /kw:page:/);
});
