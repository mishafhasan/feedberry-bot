import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SourceCard } from '../../src/db/repos/subscriptions.ts';
import { PAGE_SIZE, s7View } from '../../src/bot/screens/s7.ts';

const NOW = Date.UTC(2026, 0, 1, 12);

/** The reference card: icon + linked title, then `id: #<id>, source checked: <age>`. */
const card = (overrides: Partial<SourceCard>): SourceCard => ({
  subscription_id: 1,
  source_id: 538644,
  platform: 'instagram',
  canonical_url: 'https://instagram.com/cristiano',
  title: 'Cristiano Ronaldo',
  avatar_url: null,
  enabled: 1,
  last_check_at: NOW - 41_000,
  last_ok_at: null,
  last_error_code: null,
  consecutive_failures: 0,
  interval_minutes: null,
  ...overrides,
});

const cristiano = card({});
const godly = card({
  subscription_id: 2,
  source_id: 637556,
  platform: 'x',
  canonical_url: 'https://x.com/godly',
  title: 'godly',
  enabled: 0,
  last_check_at: NOW - 600_000,
});

test('S7 rich message: a rule, then each card with its pills directly under it', () => {
  const view = s7View({ cards: [cristiano, godly], offset: 0, total: 2, platforms: ['instagram', 'x'], active: null, page: 0, now: NOW });

  assert.equal(
    view.html,
    [
      '<p><b>Source list · Private messages</b><br/>Showing 1–2 of 2</p>',
      '<hr/>',
      '<p><tg-emoji emoji-id="5355097780228470775">📸</tg-emoji> <b><a href="https://instagram.com/cristiano">Cristiano Ronaldo</a></b><br/>id: #538644, source checked: 41s</p>',
      '<tg-button-row align="left"><tg-button type="callback_data" style="danger" data="src:off:538644">Off</tg-button><tg-button type="callback_data" data="src:check:538644">⟳</tg-button><tg-button type="callback_data" style="danger" data="src:del:538644">🗑</tg-button></tg-button-row>',
      '<hr/>',
      '<p><tg-emoji emoji-id="5355148941878900494">✖️</tg-emoji> <b><a href="https://x.com/godly">godly</a></b><br/>id: #637556, source checked: 10m</p>',
      '<tg-button-row align="left"><tg-button type="callback_data" style="success" data="src:on:637556">On</tg-button><tg-button type="callback_data" data="src:check:637556">⟳</tg-button><tg-button type="callback_data" style="danger" data="src:del:637556">🗑</tg-button></tg-button-row>',
      '<hr/>',
      '<tg-button-row align="left"><tg-button type="callback_data" style="primary" data="src:filter:all">All</tg-button><tg-button type="callback_data" data="src:filter:instagram"><tg-emoji emoji-id="5355097780228470775">📸</tg-emoji> IG</tg-button><tg-button type="callback_data" data="src:filter:x"><tg-emoji emoji-id="5355148941878900494">✖️</tg-emoji> X</tg-button></tg-button-row>',
    ].join(''),
  );
});

test('S7 keeps Back — and nothing else — in the keyboard', () => {
  const view = s7View({ cards: [cristiano], offset: 0, total: 1, platforms: ['instagram'], active: null, page: 0, now: NOW });

  assert.deepEqual(view.keyboard.inline_keyboard, [[{ text: '← Back', callback_data: 'nav:back' }]]);
  assert.doesNotMatch(view.html, /nav:back/, 'Back is not repeated inside the message');
});

test('S7 filters wrap four per row and drop no platform', () => {
  const platforms = ['bluesky', 'facebook', 'instagram', 'pinterest', 'rss', 'threads', 'x'];
  const view = s7View({ cards: [cristiano], offset: 0, total: 1, platforms, active: null, page: 0, now: NOW });
  const chipRows = view.html.split('<hr/>').at(-1) ?? '';

  assert.equal(chipRows.match(/<tg-button-row align="left">/g)?.length, 2, 'All plus seven platforms fill two rows of four');
  assert.match(chipRows.split('<tg-button-row align="left">').at(-1) ?? '', /src:filter:x/, 'the eighth chip stays reachable');
});

test('S7 marks the active filter and puts the pager after the chips', () => {
  const view = s7View({
    cards: [cristiano],
    offset: PAGE_SIZE,
    total: PAGE_SIZE * 3,
    platforms: ['instagram', 'x'],
    active: 'instagram',
    page: 1,
    now: NOW,
  });
  const tail = view.html.split('<hr/>').at(-1) ?? '';

  assert.match(tail, /style="primary" data="src:filter:instagram"/);
  assert.doesNotMatch(tail, /style="primary" data="src:filter:all"/);
  assert.match(
    tail,
    /<tg-button-row align="center"><tg-button type="callback_data" data="src:page:0">‹<\/tg-button><tg-button type="callback_data" data="src:page:2">›<\/tg-button><\/tg-button-row>$/,
    'the pager closes the body',
  );
});
