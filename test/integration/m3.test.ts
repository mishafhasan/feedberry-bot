/**
 * M3 verification (IMPLEMENTATION_PLAN §4 M3): MAX_SOURCES_PER_USER=2, duplicate, toggle, delete.
 * Everything runs on the fake Bot API and the fixture feed; no network, no live social URLs.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createBot } from '../../src/bot/index.ts';
import { parseConfig } from '../../src/config.ts';
import { openDb, type Db } from '../../src/db/index.ts';
import type { Http } from '../../src/platform/http.ts';
import { callbackUpdate, fakeBotApi, startUpdate, textUpdate } from '../fake-api.ts';

const TOKEN = '123456:AAHfakeTokenForTestsOnly_1234567890abc';
const USER_ID = 555;
const RSSHUB_BASE = 'http://rsshub.test';
const fixture = readFileSync(new URL('../fixtures/ig-profile.rss', import.meta.url), 'utf8');

const http: Http = async (url) => {
  if (/\/instagram\/user\/[a-z]+$/.test(url)) return { status: 200, url, contentType: 'application/rss+xml', body: fixture };
  throw new Error(`unexpected fetch ${url}`);
};

const count = (db: Db, sql: string, ...args: Array<string | number>): number => (db.prepare(sql).get(...args) as { n: number }).n;

test('M3: add, E_DUPLICATE, E_SOURCE_LIMIT, toggle, cascade delete', async () => {
  const api = await fakeBotApi();
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-m3-'));
  const cfg = parseConfig({ BOT_TOKEN: TOKEN, ADMIN_CHAT_ID: '1', RSSHUB_BASE, CALLBACK_INTERVAL_MS: '0', ADD_INTERVAL_MS: '0', MAX_SOURCES_PER_USER: '2' });
  const db = openDb(join(dir, 'bot.db'));
  let updateId = 10;

  try {
    const bot = createBot({ cfg, db, apiRoot: api.apiRoot, http });
    await bot.init();
    await bot.handleUpdate(startUpdate(1, USER_ID));

    const personal = db.prepare("SELECT id FROM chats WHERE type = 'private'").get() as { id: number };
    const add = async (user: string): Promise<void> => {
      await bot.handleUpdate(callbackUpdate(updateId++, USER_ID, 'menu:add'));
      await bot.handleUpdate(textUpdate(updateId++, USER_ID, `https://www.instagram.com/${user}/`));
      await bot.handleUpdate(callbackUpdate(updateId++, USER_ID, `add:dest:${personal.id}`));
      await bot.handleUpdate(callbackUpdate(updateId++, USER_ID, 'add:save'));
    };

    await add('cristiano');
    assert.match(api.last('editMessageCaption')?.body.caption ?? '', /is added to your feed/, 'S6 confirms the add');
    assert.equal(count(db, 'SELECT COUNT(*) AS n FROM sources'), 1);
    assert.equal(count(db, 'SELECT COUNT(*) AS n FROM subscriptions'), 1);
    assert.equal(count(db, 'SELECT COUNT(*) AS n FROM posts'), 7, 'every item is recorded as seen');
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM deliveries WHERE status = 'pending'"), 5, 'the newest five are the backfill');
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM jobs WHERE kind = 'deliver_post' AND state = 'queued'"), 1, 'backfill job queued');
    const firstPosts = count(db, "SELECT COUNT(*) AS n FROM posts p JOIN sources s ON s.id = p.source_id WHERE s.canonical_url = 'https://instagram.com/cristiano'");
    assert.equal(firstPosts, 7);

    // A duplicate is recognised the moment the link arrives, before any preview or save.
    await bot.handleUpdate(callbackUpdate(updateId++, USER_ID, 'menu:add'));
    await bot.handleUpdate(textUpdate(updateId++, USER_ID, 'https://www.instagram.com/cristiano/'));
    assert.match(api.last('sendMessage')?.body.text ?? '', /already in your sources/, 'E_DUPLICATE');
    assert.equal(count(db, 'SELECT COUNT(*) AS n FROM subscriptions'), 1, 'a duplicate writes nothing');

    await add('messi');
    assert.equal(count(db, 'SELECT COUNT(*) AS n FROM subscriptions'), 2);

    await add('neymar');
    assert.match(api.last('sendMessage')?.body.text ?? '', /reached 2 sources/, 'E_SOURCE_LIMIT names the configured limit');
    assert.equal(count(db, 'SELECT COUNT(*) AS n FROM subscriptions'), 2, 'the refused add writes nothing');
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM sources WHERE canonical_url LIKE '%neymar%'"), 0);

    // S7: one message holds the header, both cards and their actions.
    await bot.handleUpdate(callbackUpdate(updateId++, USER_ID, 'menu:sources'));
    const list = api.last('editMessageText');
    assert.match(list?.body.text ?? '', /Source list · Private messages\nShowing 1–2 of 2/);
    assert.match(list?.body.text ?? '', /id: #\d+, source checked: never/, 'every source is listed in the same message');
    const listButtons = (list?.body.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> }).inline_keyboard.flat();
    assert.ok(listButtons.some((button) => button.callback_data.startsWith('src:off:')), 'the actions live in that message too');

    // S8: the toggle flips the flag and the toast is answered before the list is rewritten.
    const cristiano = db.prepare("SELECT id FROM sources WHERE canonical_url = 'https://instagram.com/cristiano'").get() as { id: number };
    const mark = api.calls.length;
    await bot.handleUpdate(callbackUpdate(updateId++, USER_ID, `src:off:${cristiano.id}`));
    const toggleCalls = api.callsSince(mark);
    assert.equal(toggleCalls[0]?.method, 'answerCallbackQuery');
    assert.equal(toggleCalls[0]?.body.text, 'Source disabled — new posts will not arrive.');
    assert.equal((db.prepare('SELECT enabled FROM sources WHERE id = ?').get(cristiano.id) as { enabled: number }).enabled, 0);
    assert.equal(api.last('editMessageText')?.body.text?.includes('Source list'), true, 'the same message was refreshed, not duplicated');

    // S10 → S11: confirm in its own message, then cascade.
    await bot.handleUpdate(callbackUpdate(updateId++, USER_ID, `src:del:${cristiano.id}`));
    assert.match(api.last('sendMessage')?.body.text ?? '', /Delete the source «Cristiano Ronaldo»\?/);
    await bot.handleUpdate(callbackUpdate(updateId++, USER_ID, `src:delok:${cristiano.id}`));
    assert.equal(api.last('answerCallbackQuery')?.body.text, 'Source deleted.');

    assert.equal(count(db, 'SELECT COUNT(*) AS n FROM subscriptions WHERE source_id = ?', cristiano.id), 0, 'subscription gone');
    assert.equal(count(db, 'SELECT COUNT(*) AS n FROM posts WHERE source_id = ?', cristiano.id), 0, 'posts gone');
    assert.equal(count(db, 'SELECT COUNT(*) AS n FROM sources WHERE id = ?', cristiano.id), 0, 'orphan source gone');
    assert.equal(count(db, 'SELECT COUNT(*) AS n FROM subscriptions'), 1, 'the other source is untouched');

    // S7 shows the remaining card.
    const header = api.calls.filter((c) => c.method === 'editMessageText' && /Source list/.test(c.body.text ?? '')).at(-1);
    assert.match(header?.body.text ?? '', /Showing 1–1 of 1/);
  } finally {
    db.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
