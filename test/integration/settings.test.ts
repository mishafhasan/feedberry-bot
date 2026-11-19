/**
 * The user-facing half of the timezone fix: `users.tz` had no writer at all, so every slot was UTC.
 * These tests drive the real handlers and assert the stored epochs, not just the screen text.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createBot } from '../../src/bot/index.ts';
import { helpText } from '../../src/bot/texts.ts';
import { parseConfig, type Config } from '../../src/config.ts';
import { openDb, type Db } from '../../src/db/index.ts';
import { ensurePrivateChat, upsertChat } from '../../src/db/repos/chats.ts';
import { ensureDigest, setDigestEnabled, setDigestHour } from '../../src/db/repos/digests.ts';
import { setSourceInterval, upsertSource } from '../../src/db/repos/sources.ts';
import { insertSubscription } from '../../src/db/repos/subscriptions.ts';
import { ensureUser } from '../../src/db/repos/users.ts';
import type { Http } from '../../src/platform/http.ts';
import { digestSlot, slotAfter } from '../../src/scheduler/slots.ts';
import { callbackUpdate, commandUpdate, fakeBotApi, startUpdate, type Call } from '../fake-api.ts';
import { allowUser } from '../seed.ts';

const TOKEN = '123456:AAHfakeTokenForTestsOnly_1234567890abc';
const USER_ID = 861;
const OTHER_ID = 862;

const http: Http = async (url) => {
  throw new Error(`offline: ${url}`);
};

const cfgFor = (): Config =>
  parseConfig({
    BOT_TOKEN: TOKEN,
    ADMIN_CHAT_ID: '1',
    RSSHUB_BASE: 'http://rsshub.test',
    CALLBACK_INTERVAL_MS: '0',
    ADD_INTERVAL_MS: '0',
  });

const rowsOf = (call: Call | undefined): string[][] => {
  const rows = (call?.body.reply_markup?.inline_keyboard ?? []) as Array<Array<{ callback_data?: string }>>;
  return rows.map((row) => row.map((button) => button.callback_data ?? '').filter((data) => data !== ''));
};

const callbacksOf = (call: Call | undefined): string[] => rowsOf(call).flat();

const row = <T>(db: Db, sql: string, ...args: Array<string | number>): T => db.prepare(sql).get(...args) as T;

/**
 * One source on the default 08:00/20:00 slots, one on a fixed interval, one digest on and one off.
 * The two subscriptions and the two digests are what a zone change must treat differently.
 */
function seed(db: Db, tgUserId: number, tag: string): { userId: number; timedSub: number; intervalSub: number; digestOn: number; digestOff: number } {
  const user = ensureUser(db, tgUserId);
  const chat = ensurePrivateChat(db, user.id, tgUserId);
  const channel = upsertChat(db, {
    ownerUserId: user.id,
    tgChatId: -(1_000_000 + tgUserId),
    type: 'channel',
    title: 'Channel',
    messageThreadId: null,
    canPost: true,
    verifiedAt: Date.now(),
    rightsJson: null,
  });

  const timed = upsertSource(db, { platform: 'rss', canonicalUrl: `https://${tag}-timed.test`, externalId: `${tag}-timed`, feedUrl: `https://${tag}-timed.test/feed`, strategy: 'native_rss', title: 'Timed', avatarUrl: null });
  const hourly = upsertSource(db, { platform: 'rss', canonicalUrl: `https://${tag}-hourly.test`, externalId: `${tag}-hourly`, feedUrl: `https://${tag}-hourly.test/feed`, strategy: 'native_rss', title: 'Hourly', avatarUrl: null });
  setSourceInterval(db, hourly.id, 60);

  const now = Date.now();
  const timedSub = insertSubscription(db, { userId: user.id, sourceId: timed.id, chatId: chat.id, deliver: true, nextSlotAt: now + 3 * 3_600_000 });
  const intervalSub = insertSubscription(db, { userId: user.id, sourceId: hourly.id, chatId: chat.id, deliver: true, nextSlotAt: now + 600_000 });
  assert.ok(timedSub && intervalSub);

  const digestOn = ensureDigest(db, user.id, chat.id);
  setDigestHour(db, digestOn.id, 8, now + 3 * 3_600_000);
  setDigestEnabled(db, digestOn.id, true, now + 3 * 3_600_000);

  const digestOff = ensureDigest(db, user.id, channel.id);
  setDigestEnabled(db, digestOff.id, false, null);

  return { userId: user.id, timedSub: timedSub.id, intervalSub: intervalSub.id, digestOn: digestOn.id, digestOff: digestOff.id };
}

test('settings: S1 offers it, /settings opens the hub, and Help and About reuse their own text', async () => {
  const api = await fakeBotApi();
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-settings-'));
  const db = openDb(join(dir, 'bot.db'));
  allowUser(db, USER_ID);

  try {
    const bot = createBot({ cfg: cfgFor(), db, apiRoot: api.apiRoot, http });
    await bot.init();

    await bot.handleUpdate(startUpdate(1, USER_ID));
    const menu = api.last('sendRichMessage');
    assert.ok(callbacksOf(menu).includes('menu:settings'), 'Settings is on the main menu');
    assert.ok(!callbacksOf(menu).includes('menu:help'), 'Help is one step deeper now');
    assert.equal(rowsOf(menu).length, 4, 'the layout did not grow a row');

    await bot.handleUpdate(commandUpdate(2, USER_ID, 'settings'));
    const hub = api.last('sendMessage');
    assert.match(String(hub?.body.text), /🌍 Timezone: UTC/, 'the hub names the live zone');
    assert.deepEqual(callbacksOf(hub), ['set:help', 'set:about', 'set:tz', 'nav:home']);

    await bot.handleUpdate(callbackUpdate(3, USER_ID, 'set:help'));
    const help = api.last('editMessageText');
    assert.equal(String(help?.body.text), helpText('en'), 'the Help body is the existing one, verbatim');
    assert.deepEqual(callbacksOf(help), ['menu:settings'], 'Back returns to the hub, not the main menu');

    await bot.handleUpdate(callbackUpdate(4, USER_ID, 'set:about'));
    const about = api.last('editMessageText');
    assert.match(String(about?.body.text), new RegExp(`Your ID: ${USER_ID}`));
    assert.deepEqual(callbacksOf(about), ['menu:settings']);

    await bot.handleUpdate(callbackUpdate(5, USER_ID, 'set:tz'));
    const picker = api.last('editMessageText');
    assert.ok(callbacksOf(picker).includes('tz:Asia/Colombo'), 'Sri Lanka is one tap away');
    const marks = ((picker?.body.reply_markup?.inline_keyboard ?? []) as Array<Array<{ text: string }>>)
      .flatMap((row) => row.map((button) => button.text))
      .filter((text) => text.startsWith('✅'));
    assert.equal(marks.length, 1, 'the zone the user is on is the marked one');
    assert.match(marks[0] ?? '', /UTC/, 'which is UTC until the picker is used');

    // The notice route still works: only the main menu lost its Help button.
    await bot.handleUpdate(callbackUpdate(6, USER_ID, 'menu:help'));
    assert.equal(String(api.last('editMessageText')?.body.text), helpText('en'));
  } finally {
    db.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('settings: a new zone writes users.tz and re-plans every absolute slot', async () => {
  const api = await fakeBotApi();
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-settings-tz-'));
  const db = openDb(join(dir, 'bot.db'));
  allowUser(db, USER_ID);

  try {
    const seeded = seed(db, USER_ID, 'mine');
    const bot = createBot({ cfg: cfgFor(), db, apiRoot: api.apiRoot, http });
    await bot.init();

    const intervalBefore = row<{ next_slot_at: number }>(db, 'SELECT next_slot_at FROM subscriptions WHERE id = ?', seeded.intervalSub).next_slot_at;
    const before = Date.now();
    const mark = api.calls.length;
    await bot.handleUpdate(callbackUpdate(1, USER_ID, 'tz:Asia/Colombo'));
    const after = Date.now();

    assert.equal(ensureUser(db, USER_ID).tz, 'Asia/Colombo', 'the picker is the writer users.tz never had');
    assert.match(String(api.last('answerCallbackQuery')?.body.text), /Asia\/Colombo/, 'the toast confirms before the repaint');

    // The handler's own `now` sits inside [before, after], so its slot is one of these; nothing else is.
    const postSlots = new Set([before, after].map((at) => slotAfter(at, 'Asia/Colombo', null)));
    const moved = row<{ next_slot_at: number }>(db, 'SELECT next_slot_at FROM subscriptions WHERE id = ?', seeded.timedSub).next_slot_at;
    assert.ok(postSlots.has(moved), `a stored post slot moved to the Colombo clock, got ${new Date(moved).toISOString()}`);

    const kept = row<{ next_slot_at: number }>(db, 'SELECT next_slot_at FROM subscriptions WHERE id = ?', seeded.intervalSub).next_slot_at;
    assert.equal(kept, intervalBefore, 'a fixed interval is zone-independent and keeps its cadence');

    const digestSlots = new Set([before, after].map((at) => digestSlot(at, 'Asia/Colombo', 8)));
    const on = row<{ next_run_at: number }>(db, 'SELECT next_run_at FROM digests WHERE id = ?', seeded.digestOn).next_run_at;
    assert.ok(digestSlots.has(on), `the digest moved to 08:00 Colombo, got ${new Date(on).toISOString()}`);

    const off = row<{ next_run_at: number | null }>(db, 'SELECT next_run_at FROM digests WHERE id = ?', seeded.digestOff).next_run_at;
    assert.equal(off, null, 'a disabled digest still waits for the switch');

    assert.match(String(api.last('editMessageText')?.body.text), /Timezone: Asia\/Colombo/, 'the hub repaints on the new zone');
    assert.ok(!api.callsSince(mark).some((call) => call.method === 'sendMessage'), 'a zone change sends nothing new');
  } finally {
    db.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('settings: an unlisted zone writes nothing and gets no confirmation', async () => {
  const api = await fakeBotApi();
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-settings-forged-'));
  const db = openDb(join(dir, 'bot.db'));
  allowUser(db, USER_ID);

  try {
    const bot = createBot({ cfg: cfgFor(), db, apiRoot: api.apiRoot, http });
    await bot.init();

    await bot.handleUpdate(callbackUpdate(1, USER_ID, 'tz:Mars/Base'));
    assert.equal(ensureUser(db, USER_ID).tz, 'UTC', 'a forged tap never reaches the users row');
    assert.equal(api.last('answerCallbackQuery')?.body.text, undefined, 'and is not confirmed either');
  } finally {
    db.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("settings: a zone change re-plans only the caller's own rows", async () => {
  const api = await fakeBotApi();
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-settings-scope-'));
  const db = openDb(join(dir, 'bot.db'));
  allowUser(db, USER_ID);
  allowUser(db, OTHER_ID);

  try {
    seed(db, USER_ID, 'mine');
    const theirs = seed(db, OTHER_ID, 'theirs');
    const bot = createBot({ cfg: cfgFor(), db, apiRoot: api.apiRoot, http });
    await bot.init();

    const theirSlot = row<{ next_slot_at: number }>(db, 'SELECT next_slot_at FROM subscriptions WHERE id = ?', theirs.timedSub).next_slot_at;
    const theirDigest = row<{ next_run_at: number }>(db, 'SELECT next_run_at FROM digests WHERE id = ?', theirs.digestOn).next_run_at;

    await bot.handleUpdate(callbackUpdate(1, USER_ID, 'tz:Asia/Colombo'));

    assert.equal(ensureUser(db, OTHER_ID).tz, 'UTC', 'the other user keeps their zone');
    assert.equal(row<{ next_slot_at: number }>(db, 'SELECT next_slot_at FROM subscriptions WHERE id = ?', theirs.timedSub).next_slot_at, theirSlot, 'and their post slot');
    assert.equal(row<{ next_run_at: number }>(db, 'SELECT next_run_at FROM digests WHERE id = ?', theirs.digestOn).next_run_at, theirDigest, 'and their digest slot');
  } finally {
    db.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
