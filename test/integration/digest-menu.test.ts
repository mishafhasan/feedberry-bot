/**
 * ADR-029's settings flow through the real handlers: the menu button appears only with a key, the
 * digest screen reaches sources/language/time/on-off, and every `dg:*` tap is refused when the digest
 * or the subscription belongs to someone else.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createBot } from '../../src/bot/index.ts';
import { parseConfig, type Config } from '../../src/config.ts';
import { openDb, type Db } from '../../src/db/index.ts';
import { ensurePrivateChat, upsertChat } from '../../src/db/repos/chats.ts';
import { ensureDigest } from '../../src/db/repos/digests.ts';
import { upsertSource } from '../../src/db/repos/sources.ts';
import { insertSubscription } from '../../src/db/repos/subscriptions.ts';
import { ensureUser } from '../../src/db/repos/users.ts';
import type { Http } from '../../src/platform/http.ts';
import { callbackUpdate, fakeBotApi, startUpdate, type Call } from '../fake-api.ts';
import { allowUser } from '../seed.ts';

const TOKEN = '123456:AAHfakeTokenForTestsOnly_1234567890abc';
const USER_ID = 731;
const OTHER_ID = 732;

const http: Http = async (url) => {
  throw new Error(`offline: ${url}`);
};

const config = (gemini: boolean): Config =>
  parseConfig({
    BOT_TOKEN: TOKEN,
    ADMIN_CHAT_ID: '1',
    RSSHUB_BASE: 'http://rsshub.test',
    CALLBACK_INTERVAL_MS: '0',
    ADD_INTERVAL_MS: '0',
    ...(gemini ? { GEMINI_API_KEY: 'test-key' } : {}),
  });

/** Every callback_data in the inline keyboard of one recorded call. */
const callbacksOf = (call: Call | undefined): string[] => {
  const rows = (call?.body.reply_markup?.inline_keyboard ?? []) as Array<Array<{ callback_data?: string }>>;
  return rows.flatMap((row) => row.map((button) => button.callback_data ?? '')).filter((data) => data !== '');
};

/** Every button label of one recorded call; the ✅ marks live here, not in the message text. */
const labelsOf = (call: Call | undefined): string[] => {
  const rows = (call?.body.reply_markup?.inline_keyboard ?? []) as Array<Array<{ text?: string }>>;
  return rows.flatMap((row) => row.map((button) => button.text ?? ''));
};

/** callback_data grouped by keyboard row, so a layout can be asserted without guessing order. */
const rowsOf = (call: Call | undefined): string[][] => {
  const rows = (call?.body.reply_markup?.inline_keyboard ?? []) as Array<Array<{ callback_data?: string }>>;
  return rows.map((row) => row.map((button) => button.callback_data ?? '').filter((data) => data !== ''));
};

const row = <T>(db: Db, sql: string, ...args: Array<string | number>): T => db.prepare(sql).get(...args) as T;

/** One RSS source and one Instagram source, so "only RSS can join" has something to exclude. */
function seedSources(db: Db, userId: number, chatId: number, tag: string): { rssSub: number; igSub: number } {
  const rss = upsertSource(db, {
    platform: 'rss',
    canonicalUrl: `https://${tag}-blog.test`,
    externalId: `${tag}-blog.test`,
    feedUrl: `https://${tag}-blog.test/feed`,
    strategy: 'native_rss',
    title: 'Blog',
    avatarUrl: null,
  });
  const ig = upsertSource(db, {
    platform: 'instagram',
    canonicalUrl: `https://instagram.com/${tag}`,
    externalId: tag,
    feedUrl: null,
    strategy: 'rsshub',
    title: 'InstaGram',
    avatarUrl: null,
  });
  const rssSub = insertSubscription(db, { userId, sourceId: rss.id, chatId, deliver: true, nextSlotAt: null });
  const igSub = insertSubscription(db, { userId, sourceId: ig.id, chatId, deliver: true, nextSlotAt: null });
  assert.ok(rssSub);
  assert.ok(igSub);
  return { rssSub: rssSub.id, igSub: igSub.id };
}

test('digest: without a Gemini key the main menu has no digest button', async () => {
  const api = await fakeBotApi();
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-digest-menu-'));
  const db = openDb(join(dir, 'bot.db'));
  allowUser(db, USER_ID);

  try {
    const bot = createBot({ cfg: config(false), db, apiRoot: api.apiRoot, http });
    await bot.init();
    await bot.handleUpdate(startUpdate(1, USER_ID));
    assert.ok(!callbacksOf(api.last('sendRichMessage')).includes('menu:digest'), 'the feature is off');
    assert.ok(!callbacksOf(api.last('sendRichMessage')).some((data) => data.startsWith('menu:digest')), 'no shortcut leaks either');
  } finally {
    db.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('digest: sources, language, time and the switch, with ownership on every tap', async () => {
  const api = await fakeBotApi();
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-digest-menu-'));
  const db = openDb(join(dir, 'bot.db'));
  allowUser(db, USER_ID);
  allowUser(db, OTHER_ID);

  try {
    const user = ensureUser(db, USER_ID);
    const chat = ensurePrivateChat(db, user.id, USER_ID);
    const { rssSub, igSub } = seedSources(db, user.id, chat.id, 'mine');

    const other = ensureUser(db, OTHER_ID);
    const otherChat = ensurePrivateChat(db, other.id, OTHER_ID);
    const foreign = seedSources(db, other.id, otherChat.id, 'theirs');
    const foreignDigest = ensureDigest(db, other.id, otherChat.id);

    const bot = createBot({ cfg: config(true), db, apiRoot: api.apiRoot, http });
    await bot.init();
    let updateId = 10;

    await bot.handleUpdate(startUpdate(1, USER_ID));
    assert.ok(callbacksOf(api.last('sendRichMessage')).includes('menu:digest'), 'the button is there with a key');
    const menuRows = rowsOf(api.last('sendRichMessage'));
    assert.ok(labelsOf(api.last('sendRichMessage')).some((label) => label.includes('Daily AI Summary')), 'the button carries the new name');
    assert.ok(menuRows.some((row) => row.includes('menu:digest') && row.includes('menu:schedule')), 'the summary and Schedule share a row');
    assert.ok(menuRows.some((row) => row.includes('menu:digest:time') && row.includes('menu:digest:on')), 'Time and the switch share a row');
    assert.ok(menuRows.some((row) => row.includes('menu:digest:chat')), 'Deliver to sits under them');

    await bot.handleUpdate(callbackUpdate(updateId++, USER_ID, 'menu:digest'));
    assert.match(String(api.last('editMessageText')?.body.text ?? ''), /Daily AI Summary/);
    const screenRows = rowsOf(api.last('editMessageText'));
    assert.ok(
      screenRows.some((row) => row.some((data) => data.startsWith('dg:time:')) && row.some((data) => data.startsWith('dg:on:'))),
      'the digest screen pairs Time with the switch',
    );
    assert.ok(screenRows.some((row) => row.includes('menu:digest:chat')), 'and puts Deliver to below them');
    const digest = row<{ id: number; lang: string; hour: number; enabled: number; next_run_at: number | null }>(db, 'SELECT id, lang, hour, enabled, next_run_at FROM digests WHERE chat_id = ?', chat.id);
    assert.match(String(api.last('editMessageText')?.body.text ?? ''), /Status: Off/);

    // Sources: RSS only, and the tap writes the choice.
    await bot.handleUpdate(callbackUpdate(updateId++, USER_ID, `dg:src:${digest.id}:0`));
    const sourceLabels = labelsOf(api.last('editMessageText'));
    assert.ok(sourceLabels.some((label) => label.includes('Blog')));
    assert.ok(!sourceLabels.some((label) => label.includes('InstaGram')), 'a social source cannot join the digest');
    assert.ok(sourceLabels.every((label) => !label.includes('<') && !label.includes('tg-emoji')), 'an inline button shows plain text, never markup');
    assert.ok(sourceLabels.some((label) => label.includes('📡')), 'the RSS icon is the bare emoji');
    const sourceButtons = callbacksOf(api.last('editMessageText'));
    assert.ok(sourceButtons.includes(`dg:tg:${digest.id}:${rssSub}`));
    assert.ok(!sourceButtons.includes(`dg:tg:${digest.id}:${igSub}`), 'the Instagram row has no toggle');

    await bot.handleUpdate(callbackUpdate(updateId++, USER_ID, `dg:tg:${digest.id}:${rssSub}`));
    assert.equal(row<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM digest_sources WHERE digest_id = ?', digest.id).n, 1);
    assert.ok(labelsOf(api.last('editMessageText')).some((label) => label.startsWith('✅') && label.includes('Blog')), 'the row repaints as chosen');

    // Language: Tamil is stored on the digest, not on the user.
    await bot.handleUpdate(callbackUpdate(updateId++, USER_ID, `dg:lang:${digest.id}`));
    await bot.handleUpdate(callbackUpdate(updateId++, USER_ID, `dg:setlang:${digest.id}:ta`));
    assert.equal(row<{ lang: string }>(db, 'SELECT lang FROM digests WHERE id = ?', digest.id).lang, 'ta');
    assert.ok(labelsOf(api.last('editMessageText')).includes('✅ தமிழ்'));

    // Time: an hour, and a disabled digest gets no slot yet.
    await bot.handleUpdate(callbackUpdate(updateId++, USER_ID, `dg:time:${digest.id}`));
    assert.ok(callbacksOf(api.last('editMessageText')).includes(`dg:sethour:${digest.id}:7`));
    await bot.handleUpdate(callbackUpdate(updateId++, USER_ID, `dg:sethour:${digest.id}:7`));
    assert.equal(row<{ hour: number }>(db, 'SELECT hour FROM digests WHERE id = ?', digest.id).hour, 7);
    assert.equal(row<{ next_run_at: number | null }>(db, 'SELECT next_run_at FROM digests WHERE id = ?', digest.id).next_run_at, null);

    // On: the slot appears; off clears it.
    await bot.handleUpdate(callbackUpdate(updateId++, USER_ID, `dg:open:${digest.id}`));
    await bot.handleUpdate(callbackUpdate(updateId++, USER_ID, `dg:on:${digest.id}`));
    const on = row<{ enabled: number; next_run_at: number | null }>(db, 'SELECT enabled, next_run_at FROM digests WHERE id = ?', digest.id);
    assert.equal(on.enabled, 1);
    assert.ok((on.next_run_at ?? 0) > Date.now(), 'the next run is in the future');
    assert.match(String(api.last('editMessageText')?.body.text ?? ''), /Status: On/);

    await bot.handleUpdate(callbackUpdate(updateId++, USER_ID, `dg:on:${digest.id}`));
    const off = row<{ enabled: number; next_run_at: number | null }>(db, 'SELECT enabled, next_run_at FROM digests WHERE id = ?', digest.id);
    assert.equal(off.enabled, 0);
    assert.equal(off.next_run_at, null);

    // The menu shortcuts drive the same digest without opening its screen.
    await bot.handleUpdate(callbackUpdate(updateId++, USER_ID, 'menu:digest:on'));
    assert.equal(row<{ enabled: number }>(db, 'SELECT enabled FROM digests WHERE id = ?', digest.id).enabled, 1, 'the menu switch turns it on');
    assert.ok(labelsOf(api.last('editMessageText')).some((label) => label.includes('Turn off')), 'the menu repaints with the other label');
    await bot.handleUpdate(callbackUpdate(updateId++, USER_ID, 'menu:digest:on'));
    assert.equal(row<{ enabled: number }>(db, 'SELECT enabled FROM digests WHERE id = ?', digest.id).enabled, 0);

    await bot.handleUpdate(callbackUpdate(updateId++, USER_ID, 'menu:digest:time'));
    assert.ok(callbacksOf(api.last('editMessageText')).includes(`dg:sethour:${digest.id}:7`), 'the menu opens the hour picker');

    await bot.handleUpdate(callbackUpdate(updateId++, USER_ID, 'menu:digest:chat'));
    assert.ok(callbacksOf(api.last('editMessageText')).includes(`dg:chat:${chat.id}`), 'Deliver to lists the destinations');

    // Another user's digest and subscription are refused without a word.
    const mark = api.calls.length;
    await bot.handleUpdate(callbackUpdate(updateId++, USER_ID, `dg:open:${foreignDigest.id}`));
    assert.equal(api.callsSince(mark).filter((call) => call.method === 'editMessageText').length, 0, 'no screen for a foreign digest');
    await bot.handleUpdate(callbackUpdate(updateId++, USER_ID, `dg:tg:${digest.id}:${foreign.rssSub}`));
    assert.equal(row<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM digest_sources WHERE digest_id = ?', digest.id).n, 1, 'a foreign subscription is not toggled');

    // The other user cannot toggle onto our digest either.
    await bot.handleUpdate(callbackUpdate(updateId++, OTHER_ID, `dg:tg:${digest.id}:${rssSub}`));
    assert.equal(row<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM digest_sources WHERE digest_id = ?', digest.id).n, 1);

    // A second destination starts empty: turning it on answers with the notice and stays off.
    const channel = upsertChat(db, { ownerUserId: user.id, tgChatId: -100777, type: 'channel', title: 'Digest Channel', messageThreadId: null, canPost: true, verifiedAt: Date.now(), rightsJson: null });
    const empty = ensureDigest(db, user.id, channel.id);
    await bot.handleUpdate(callbackUpdate(updateId++, USER_ID, `dg:on:${empty.id}`));
    assert.equal(row<{ enabled: number }>(db, 'SELECT enabled FROM digests WHERE id = ?', empty.id).enabled, 0);
    assert.match(String(api.last('editMessageText')?.body.text ?? ''), /Pick at least one source/);

    // With one source it turns on; removing that last source switches the digest off again.
    await bot.handleUpdate(callbackUpdate(updateId++, USER_ID, `dg:tg:${empty.id}:${rssSub}`));
    await bot.handleUpdate(callbackUpdate(updateId++, USER_ID, `dg:on:${empty.id}`));
    assert.equal(row<{ enabled: number }>(db, 'SELECT enabled FROM digests WHERE id = ?', empty.id).enabled, 1);
    await bot.handleUpdate(callbackUpdate(updateId++, USER_ID, `dg:tg:${empty.id}:${rssSub}`));
    const emptied = row<{ enabled: number; next_run_at: number | null }>(db, 'SELECT enabled, next_run_at FROM digests WHERE id = ?', empty.id);
    assert.equal(emptied.enabled, 0, 'a digest with no source switches itself off');
    assert.equal(emptied.next_run_at, null);
  } finally {
    db.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
