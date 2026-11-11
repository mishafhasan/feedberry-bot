/**
 * Access control: the closed allowlist and the admin panel. Every other milestone test seeds its
 * user through test/seed.ts; this file is the one that proves the gate itself, including the
 * v2 → v3 migration, where pre-existing users start as 'pending' and must be approved.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { Update } from 'grammy/types';
import { createBot } from '../../src/bot/index.ts';
import { getSession, setSession } from '../../src/bot/session.ts';
import { parseConfig } from '../../src/config.ts';
import { openDb, SCHEMA_VERSION, schemaVersion, type Db } from '../../src/db/index.ts';
import { allowUser } from '../seed.ts';
import { callbackUpdate, commandUpdate, fakeBotApi, startUpdate, textUpdate, type FakeApi, type FakeChat } from '../fake-api.ts';

const TOKEN = '123456:AAHfakeTokenForTestsOnly_1234567890abc';
const ADMIN_ID = 1;
const STRANGER = 555;
const MENTION = 556;
const OLD_USER = 557;
const APPROVED = 777;
const OTHER = 888;

const chats: Record<number, FakeChat> = Object.fromEntries(
  [STRANGER, MENTION, OLD_USER, APPROVED, OTHER].map((id) => [id, { chat: { id, type: 'private', first_name: `User${id}` }, member: {} }]),
);

const cfg = parseConfig({ BOT_TOKEN: TOKEN, ADMIN_CHAT_ID: String(ADMIN_ID), RSSHUB_BASE: 'http://rsshub.test', CALLBACK_INTERVAL_MS: '0', ADD_INTERVAL_MS: '0' });

const count = (db: Db, sql: string, ...args: Array<string | number>): number => (db.prepare(sql).get(...args) as { n: number }).n;

async function setup(options: Parameters<typeof fakeBotApi>[1] = {}) {
  const api = await fakeBotApi(chats, options);
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-access-'));
  const db = openDb(join(dir, 'bot.db'));
  // Any source work for a denied user would hit this and fail the test.
  const http = async () => {
    throw new Error('no network work is expected in access tests');
  };
  const bot = createBot({ cfg, db, apiRoot: api.apiRoot, http });
  await bot.init();
  return { api, dir, db, bot };
}

function cleanup(api: FakeApi, dir: string, db: Db): Promise<void> {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  return api.close();
}

/** A /start that carries the @username the access event must record. */
function strangerStart(updateId: number, userId: number, username: string): Update {
  return {
    update_id: updateId,
    message: {
      message_id: 1,
      date: 0,
      chat: { id: userId, type: 'private', first_name: 'Stranger' },
      from: { id: userId, is_bot: false, first_name: 'Stranger', username },
      text: '/start',
      entities: [{ type: 'bot_command', offset: 0, length: 6 }],
    },
  };
}

const notices = (api: FakeApi): string[] => api.calls.filter((call) => call.method === 'sendMessage' && /access request/i.test(String(call.body.text))).map((call) => String(call.body.text));

test('a stranger gets one notice, an events row, and no user row or session', async () => {
  const { api, dir, db, bot } = await setup();
  try {
    await bot.handleUpdate(strangerStart(1, STRANGER, 'stranger'));
    assert.equal(notices(api).length, 1, 'one notice');
    assert.equal(api.calls.filter((call) => call.method === 'sendRichMessage').length, 0, 'no main menu');
    assert.equal(count(db, 'SELECT COUNT(*) AS n FROM users'), 0, 'the gate creates no user row');
    assert.equal(getSession(STRANGER).state, 'idle', 'the denied user gets no session');

    const event = db.prepare("SELECT chat_id, detail FROM events WHERE code = 'access_requested'").get() as { chat_id: number; detail: string };
    assert.equal(event.chat_id, STRANGER);
    assert.equal(event.detail, '@stranger', 'the @username is recorded for the admin');

    // Every later tap is answered, but the stranger is not spammed.
    const before = api.calls.length;
    await bot.handleUpdate(callbackUpdate(2, STRANGER, 'menu:add'));
    await bot.handleUpdate(textUpdate(3, STRANGER, 'https://www.instagram.com/cristiano/'));
    assert.equal(api.callsSince(before).filter((call) => call.method === 'sendMessage').length, 0, 'no second notice');
    assert.equal(api.callsSince(before)[0]?.method, 'answerCallbackQuery', 'the tap is still answered');
    assert.equal(count(db, 'SELECT COUNT(*) AS n FROM users'), 0);
  } finally {
    await cleanup(api, dir, db);
  }
});

test('the admin opens the panel; a non-admin gets the closed door', async () => {
  const { api, dir, db, bot } = await setup();
  try {
    await bot.handleUpdate(commandUpdate(1, ADMIN_ID, 'admin_panel'));
    const overview = String(api.last('sendMessage')?.body.text ?? '');
    assert.match(overview, /Admin panel/);
    assert.match(overview, /Users: 0/);
    assert.match(overview, /none yet/);

    allowUser(db, APPROVED);
    const before = api.calls.length;
    await bot.handleUpdate(commandUpdate(2, APPROVED, 'admin_panel'));
    const denied = api.callsSince(before);
    assert.equal(denied.filter((call) => /Admin panel/.test(String(call.body.text ?? ''))).length, 0, 'no panel contents');
    assert.ok(denied.some((call) => call.method === 'sendMessage' && /access request/i.test(String(call.body.text))), 'the same notice as any denied action');
  } finally {
    await cleanup(api, dir, db);
  }
});

test('the admin adds a user by numeric id and that user can /start', async () => {
  const { api, dir, db, bot } = await setup();
  try {
    await bot.handleUpdate(commandUpdate(1, ADMIN_ID, 'admin_panel'));
    await bot.handleUpdate(callbackUpdate(2, ADMIN_ID, 'adm:add'));
    assert.match(String(api.last('editMessageText')?.body.text), /Telegram user ID/);

    await bot.handleUpdate(textUpdate(3, ADMIN_ID, String(APPROVED)));
    const row = db.prepare('SELECT status FROM users WHERE tg_user_id = ?').get(APPROVED) as { status: string };
    assert.equal(row.status, 'allowed');
    assert.ok(
      api.calls.some((call) => call.method === 'sendMessage' && Number(call.body.chat_id) === APPROVED && /approved/i.test(String(call.body.text))),
      'the new user is told about the approval',
    );
    assert.match(String(api.last('sendMessage')?.body.text), /User 777[\s\S]*Status: allowed/, 'details open after the add');

    const before = api.calls.length;
    await bot.handleUpdate(startUpdate(4, APPROVED));
    const html = api.callsSince(before).map((call) => String(call.body.rich_message?.html ?? '')).join('');
    assert.match(html, /Sources: 0 \/ 250/, 'the allowed user sees the main menu');
  } finally {
    await cleanup(api, dir, db);
  }
});

test('an unknown id is an error the admin can retry, and an @mention resolves from the request', async () => {
  const { api, dir, db, bot } = await setup();
  try {
    await bot.handleUpdate(strangerStart(1, MENTION, 'stranger'));
    await bot.handleUpdate(commandUpdate(2, ADMIN_ID, 'admin_panel'));
    await bot.handleUpdate(callbackUpdate(3, ADMIN_ID, 'adm:add'));

    await bot.handleUpdate(textUpdate(4, ADMIN_ID, '999999'));
    assert.match(String(api.last('sendMessage')?.body.text), /Could not find that Telegram user/);
    assert.equal(count(db, 'SELECT COUNT(*) AS n FROM users'), 0, 'a failed lookup creates nothing');

    // The state survived the failure, so the retry is just another message.
    await bot.handleUpdate(textUpdate(5, ADMIN_ID, '@stranger'));
    assert.equal((db.prepare('SELECT status FROM users WHERE tg_user_id = ?').get(MENTION) as { status: string }).status, 'allowed');

    const before = api.calls.length;
    await bot.handleUpdate(startUpdate(6, MENTION));
    assert.match(api.callsSince(before).map((call) => String(call.body.rich_message?.html ?? '')).join(''), /Sources: 0 \/ 250/);
  } finally {
    await cleanup(api, dir, db);
  }
});

test('blocking cuts the user off on the next update and resets their session', async () => {
  const { api, dir, db, bot } = await setup();
  try {
    allowUser(db, OTHER);
    setSession(OTHER, { state: 'awaiting_source_link' });

    await bot.handleUpdate(callbackUpdate(1, ADMIN_ID, `adm:block:${OTHER}`));
    assert.equal(api.last('answerCallbackQuery')?.body.text, 'User blocked.');
    assert.equal((db.prepare('SELECT status FROM users WHERE tg_user_id = ?').get(OTHER) as { status: string }).status, 'blocked');
    assert.equal(getSession(OTHER).state, 'idle', 'the pending flow is dropped at once');
    assert.ok(
      api.calls.some((call) => call.method === 'sendMessage' && Number(call.body.chat_id) === OTHER && /revoked/i.test(String(call.body.text))),
      'the blocked user is told',
    );

    const before = api.calls.length;
    await bot.handleUpdate(startUpdate(2, OTHER));
    assert.equal(api.callsSince(before).filter((call) => call.method === 'sendRichMessage').length, 0, 'no main menu after a block');
    assert.equal(api.callsSince(before).filter((call) => call.method === 'sendMessage' && /access request/i.test(String(call.body.text))).length, 1);
  } finally {
    await cleanup(api, dir, db);
  }
});

test('unblocking opens the bot again', async () => {
  const { api, dir, db, bot } = await setup();
  try {
    allowUser(db, OTHER);
    await bot.handleUpdate(callbackUpdate(1, ADMIN_ID, `adm:block:${OTHER}`));
    await bot.handleUpdate(callbackUpdate(2, ADMIN_ID, `adm:unblock:${OTHER}`));
    assert.equal((db.prepare('SELECT status FROM users WHERE tg_user_id = ?').get(OTHER) as { status: string }).status, 'allowed');
    assert.ok(
      api.calls.some((call) => call.method === 'sendMessage' && Number(call.body.chat_id) === OTHER && /restored/i.test(String(call.body.text))),
      'the unblocked user is told',
    );

    const before = api.calls.length;
    await bot.handleUpdate(startUpdate(3, OTHER));
    assert.match(api.callsSince(before).map((call) => String(call.body.rich_message?.html ?? '')).join(''), /Sources: 0 \/ 250/);
  } finally {
    await cleanup(api, dir, db);
  }
});

test('notify user: pick from the list, type a message, confirm, then send', async () => {
  const { api, dir, db, bot } = await setup();
  try {
    allowUser(db, APPROVED);
    await bot.handleUpdate(commandUpdate(1, ADMIN_ID, 'admin_panel'));
    await bot.handleUpdate(callbackUpdate(2, ADMIN_ID, 'adm:msg'));

    const picker = api.last('editMessageText');
    assert.match(String(picker?.body.text), /Choose a user to message/);
    const pickButtons = (picker?.body.reply_markup as { inline_keyboard: Array<Array<{ callback_data?: string }>> }).inline_keyboard.flat();
    assert.ok(pickButtons.some((button) => button.callback_data === `adm:msg:${APPROVED}`), 'the picker lists users');

    await bot.handleUpdate(callbackUpdate(3, ADMIN_ID, `adm:msg:${APPROVED}`));
    assert.match(String(api.last('editMessageText')?.body.text), /Send the message for user 777/);

    const before = api.calls.length;
    await bot.handleUpdate(textUpdate(4, ADMIN_ID, 'hello from the admin'));
    assert.match(
      String(api.last('sendMessage')?.body.text),
      /Send this message to user 777\?[\s\S]*hello from the admin/,
      'the exact message is shown for confirmation',
    );
    assert.equal(
      api.callsSince(before).filter((call) => call.method === 'sendMessage' && Number(call.body.chat_id) === APPROVED).length,
      0,
      'nothing is sent before the confirmation',
    );

    await bot.handleUpdate(callbackUpdate(5, ADMIN_ID, 'adm:msgsend'));
    const sent = api.calls.find((call) => call.method === 'sendMessage' && Number(call.body.chat_id) === APPROVED && String(call.body.text).includes('hello from the admin'));
    assert.ok(sent, 'the user received the message after the confirmation');
    const event = db.prepare("SELECT chat_id, detail FROM events WHERE code = 'admin_notify' ORDER BY id DESC LIMIT 1").get() as { chat_id: number; detail: string };
    assert.equal(event.chat_id, APPROVED);
    assert.equal(event.detail, 'sent');
    assert.match(String(api.last('sendMessage')?.body.text), /Admin panel/, 'the panel comes back');
  } finally {
    await cleanup(api, dir, db);
  }
});

test('notify all: type the message, confirm, then send to every allowed user', async () => {
  const { api, dir, db, bot } = await setup();
  try {
    allowUser(db, APPROVED);
    allowUser(db, OTHER);
    await bot.handleUpdate(commandUpdate(1, ADMIN_ID, 'admin_panel'));
    await bot.handleUpdate(callbackUpdate(2, ADMIN_ID, 'adm:all'));
    assert.match(String(api.last('editMessageText')?.body.text), /Send the message for all allowed users/);

    const before = api.calls.length;
    await bot.handleUpdate(textUpdate(3, ADMIN_ID, 'broadcast'));
    assert.match(
      String(api.last('sendMessage')?.body.text),
      /Send this message to all allowed users\?[\s\S]*broadcast/,
      'the exact message is shown for confirmation',
    );
    assert.equal(
      api.callsSince(before).filter((call) => call.method === 'sendMessage' && [APPROVED, OTHER].includes(Number(call.body.chat_id))).length,
      0,
      'nothing is sent before the confirmation',
    );

    await bot.handleUpdate(callbackUpdate(4, ADMIN_ID, 'adm:all:yes'));
    for (const id of [APPROVED, OTHER]) {
      assert.ok(
        api.calls.some((call) => call.method === 'sendMessage' && Number(call.body.chat_id) === id && String(call.body.text).includes('broadcast')),
        `user ${id} got the broadcast`,
      );
    }
    assert.match(String(api.last('sendMessage')?.body.text), /Admin panel/);
  } finally {
    await cleanup(api, dir, db);
  }
});

test('cancelling a notification disarms its stale Send button', async () => {
  const { api, dir, db, bot } = await setup();
  try {
    allowUser(db, APPROVED);
    allowUser(db, OTHER);
    await bot.handleUpdate(commandUpdate(1, ADMIN_ID, 'admin_panel'));

    // Notify user: draft -> confirmation -> cancel -> stale Send.
    await bot.handleUpdate(callbackUpdate(2, ADMIN_ID, 'adm:msg'));
    await bot.handleUpdate(callbackUpdate(3, ADMIN_ID, `adm:msg:${APPROVED}`));
    await bot.handleUpdate(textUpdate(4, ADMIN_ID, 'should never be sent'));
    await bot.handleUpdate(callbackUpdate(5, ADMIN_ID, 'adm:home'));
    const beforeUser = api.calls.length;
    await bot.handleUpdate(callbackUpdate(6, ADMIN_ID, 'adm:msgsend'));
    assert.equal(
      api.callsSince(beforeUser).filter((call) => call.method === 'sendMessage' && Number(call.body.chat_id) === APPROVED).length,
      0,
      'a cancelled user draft cannot be sent',
    );

    // Notify all: same draft -> confirm -> cancel -> stale send.
    await bot.handleUpdate(callbackUpdate(7, ADMIN_ID, 'adm:all'));
    await bot.handleUpdate(textUpdate(8, ADMIN_ID, 'broadcast that should not go'));
    await bot.handleUpdate(callbackUpdate(9, ADMIN_ID, 'adm:home'));
    const beforeAll = api.calls.length;
    await bot.handleUpdate(callbackUpdate(10, ADMIN_ID, 'adm:all:yes'));
    assert.equal(
      api.callsSince(beforeAll).filter((call) => call.method === 'sendMessage' && [APPROVED, OTHER].includes(Number(call.body.chat_id))).length,
      0,
      'a cancelled broadcast cannot be sent',
    );
  } finally {
    await cleanup(api, dir, db);
  }
});

test('a forged admin callback from another user changes nothing', async () => {
  const { api, dir, db, bot } = await setup();
  try {
    allowUser(db, APPROVED);
    allowUser(db, OTHER);
    const before = api.calls.length;
    await bot.handleUpdate(callbackUpdate(1, APPROVED, `adm:block:${OTHER}`));

    assert.equal((db.prepare('SELECT status FROM users WHERE tg_user_id = ?').get(OTHER) as { status: string }).status, 'allowed');
    assert.equal(api.last('answerCallbackQuery')?.body.text, 'That button is not available.');
    assert.equal(api.callsSince(before).filter((call) => call.method === 'editMessageText').length, 0, 'no panel is painted for a non-admin');
    assert.equal(api.callsSince(before).filter((call) => call.method === 'sendMessage' && Number(call.body.chat_id) === OTHER).length, 0, 'no notice is sent');
  } finally {
    await cleanup(api, dir, db);
  }
});

test('migration v2 → v4 keeps old users but sets them to pending, so they need approval', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-access-v2-'));
  const dbPath = join(dir, 'bot.db');

  // A real v2 file: the users table without `status`, one user who used the bot before the upgrade.
  const raw = new DatabaseSync(dbPath);
  raw.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      tg_user_id INTEGER NOT NULL UNIQUE,
      tz TEXT NOT NULL DEFAULT 'UTC',
      locale TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE events (
      id INTEGER PRIMARY KEY, at INTEGER NOT NULL, level TEXT NOT NULL, code TEXT NOT NULL,
      source_id INTEGER, chat_id INTEGER, detail TEXT
    );
    -- v4 adds a column to this table, so a v2 file must carry it, exactly as it did in production.
    CREATE TABLE subscriptions (
      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, source_id INTEGER NOT NULL, chat_id INTEGER NOT NULL,
      deliver INTEGER NOT NULL DEFAULT 1, next_slot_at INTEGER, created_at INTEGER NOT NULL,
      UNIQUE (source_id, chat_id)
    );
    INSERT INTO users (tg_user_id, created_at) VALUES (${OLD_USER}, 1);
    PRAGMA user_version = 2;
  `);
  raw.close();

  const api = await fakeBotApi();
  const db = openDb(dbPath);
  try {
    assert.equal(schemaVersion(db), SCHEMA_VERSION);
    assert.equal(count(db, 'SELECT COUNT(*) AS n FROM users'), 1, 'the migration keeps rows');
    // Decision: a v2 row was auto-approved by the old open model; granting it silently after the
    // upgrade would keep that model. It starts pending and the admin approves it explicitly.
    assert.equal((db.prepare('SELECT status FROM users WHERE tg_user_id = ?').get(OLD_USER) as { status: string }).status, 'pending');

    const bot = createBot({ cfg, db, apiRoot: api.apiRoot });
    await bot.init();
    await bot.handleUpdate(startUpdate(1, OLD_USER));
    assert.equal(api.calls.filter((call) => call.method === 'sendRichMessage').length, 0, 'a pending old user is denied');
    assert.equal(notices(api).length, 1);
  } finally {
    await cleanup(api, dir, db);
  }
});
