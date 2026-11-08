/**
 * ADR-020 end to end: the keywords a user types on S5 reach the subscription row, and the delivery
 * pass then drops every post that says none of them — before cobalt or the Bot API is asked for
 * anything. The user-level default is exercised through `/filter` and covers a row with no list.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createBot } from '../../src/bot/index.ts';
import { parseConfig } from '../../src/config.ts';
import { openDb, SCHEMA_VERSION, schemaVersion, type Db } from '../../src/db/index.ts';
import { ensurePrivateChat, upsertChat } from '../../src/db/repos/chats.ts';
import { markPendingDelivery } from '../../src/db/repos/deliveries.ts';
import { insertPosts } from '../../src/db/repos/posts.ts';
import { upsertSource } from '../../src/db/repos/sources.ts';
import { insertSubscription } from '../../src/db/repos/subscriptions.ts';
import { ensureUser } from '../../src/db/repos/users.ts';
import type { MediaEngine } from '../../src/media/cobalt.ts';
import type { Http } from '../../src/platform/http.ts';
import { parseFeed } from '../../src/platform/feed/native.ts';
import { deliverPending } from '../../src/pipeline/run.ts';
import { TelegramSender } from '../../src/telegram/api.ts';
import { callbackUpdate, commandUpdate, fakeBotApi, startUpdate, textUpdate } from '../fake-api.ts';
import { allowUser } from '../seed.ts';

const TOKEN = '123456:AAHfakeTokenForTestsOnly_1234567890abc';
const USER_ID = 555;
const RSSHUB_BASE = 'http://rsshub.test';
const FEED_URL = 'https://keyword.test/feed';
const fixture = readFileSync(new URL('../fixtures/keyword-feed.rss', import.meta.url), 'utf8');

/** The feed answers; every other URL is a page the article reader may fetch and fail on. */
const http: Http = async (url) => {
  if (url === FEED_URL) return { status: 200, url, contentType: 'application/rss+xml', body: fixture };
  throw new Error(`unexpected fetch ${url}`);
};

const cfg = () => parseConfig({ BOT_TOKEN: TOKEN, ADMIN_CHAT_ID: '1', RSSHUB_BASE, CALLBACK_INTERVAL_MS: '0', ADD_INTERVAL_MS: '0' });

/** A media engine that only records what it was asked to resolve; it never downloads. */
function recordingEngine(): { engine: MediaEngine; urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    engine: {
      async resolve(url) {
        urls.push(url);
        return { items: [], title: null };
      },
      async download() {
        throw new Error('a filtered post must never reach the downloader');
      },
    },
  };
}

const count = (db: Db, sql: string, ...args: Array<string | number>): number => (db.prepare(sql).get(...args) as { n: number }).n;

test('keywords typed on S5 are stored and filter the backfill before any download', async () => {
  const api = await fakeBotApi();
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-kw-'));
  const config = cfg();
  const db = openDb(join(dir, 'bot.db'));
  allowUser(db, USER_ID);
  let updateId = 10;

  try {
    const bot = createBot({ cfg: config, db, apiRoot: api.apiRoot, http });
    await bot.init();

    await bot.handleUpdate(startUpdate(1, USER_ID));
    await bot.handleUpdate(callbackUpdate(updateId++, USER_ID, 'menu:add'));
    await bot.handleUpdate(textUpdate(updateId++, USER_ID, FEED_URL));

    const personal = db.prepare("SELECT id FROM chats WHERE type = 'private'").get() as { id: number };
    await bot.handleUpdate(callbackUpdate(updateId++, USER_ID, `add:dest:${personal.id}`));
    assert.match(String(api.last('editMessageText')?.body.text ?? ''), /🔑 Keywords: none — every post/, 'S5 says what will happen by default');

    // The keyword question rides on S5: the answer comes back as text and repaints that message.
    await bot.handleUpdate(callbackUpdate(updateId++, USER_ID, 'add:kw'));
    assert.match(String(api.last('sendMessage')?.body.text ?? ''), /keywords or tags for «Keyword Blog»/);
    await bot.handleUpdate(textUpdate(updateId++, USER_ID, 'Sport'));
    assert.match(String(api.last('editMessageText')?.body.text ?? ''), /🔑 Keywords: Sport/, 'S5 shows the list it will save');

    await bot.handleUpdate(callbackUpdate(updateId++, USER_ID, 'add:save'));
    const row = db.prepare('SELECT keywords FROM subscriptions').get() as { keywords: string };
    assert.equal(row.keywords, 'Sport');
    assert.equal(count(db, 'SELECT COUNT(*) AS n FROM posts'), 3);
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM deliveries WHERE status = 'pending'"), 3, 'every post is queued and only delivery decides');

    const source = db.prepare('SELECT id FROM sources').get() as { id: number };
    const { engine, urls } = recordingEngine();
    const result = await deliverPending({ db, http, cfg: config, media: engine, thumbnail: async () => null, sender: new TelegramSender(bot.api) }, source.id);

    assert.equal(result.delivered, 1, 'only the tagged post arrives');
    assert.equal(result.failed, 0);
    assert.deepEqual(urls, ['https://keyword.test/football'], 'the two dropped posts cost no media resolve');
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM deliveries WHERE status = 'skipped'"), 2);
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM deliveries WHERE status = 'pending'"), 0, 'a skipped post is final, not retried');
  } finally {
    db.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('a prompt never eats a menu tap, a link, or another row\'s tap', async () => {
  const api = await fakeBotApi();
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-kw-'));
  const config = cfg();
  const db = openDb(join(dir, 'bot.db'));
  allowUser(db, USER_ID);
  let updateId = 70;

  try {
    const user = ensureUser(db, USER_ID);
    const chat = ensurePrivateChat(db, user.id, USER_ID);
    const [first, second] = ['https://a.test', 'https://b.test'].map((url) =>
      upsertSource(db, { platform: 'rss', canonicalUrl: url, externalId: url, feedUrl: `${url}/feed`, strategy: 'native_rss', title: url, avatarUrl: null }),
    );
    for (const source of [first, second]) {
      insertSubscription(db, { userId: user.id, sourceId: source.id, chatId: chat.id, deliver: true, nextSlotAt: null });
    }
    const keywordsOf = (): Array<string | null> =>
      (db.prepare('SELECT keywords FROM subscriptions ORDER BY id').all() as Array<{ keywords: string | null }>).map((row) => row.keywords);

    const bot = createBot({ cfg: config, db, apiRoot: api.apiRoot, http });
    await bot.init();

    // The S1 button and the reply-keyboard label land on the same screen as the command.
    await bot.handleUpdate(callbackUpdate(updateId++, USER_ID, 'menu:filter'));
    assert.match(String(api.last('editMessageText')?.body.text ?? ''), /Keyword filters/);
    await bot.handleUpdate(textUpdate(updateId++, USER_ID, '🔑 Filter'));
    assert.match(String(api.last('sendMessage')?.body.text ?? ''), /Keyword filters/);

    await bot.handleUpdate(commandUpdate(updateId++, USER_ID, 'filter'));

    // 1. A reply-keyboard tap is an action, not a keyword list.
    const cards = db.prepare('SELECT id FROM subscriptions ORDER BY id').all() as Array<{ id: number }>;
    await bot.handleUpdate(callbackUpdate(updateId++, USER_ID, `kw:edit:${cards[0]?.id}`));
    await bot.handleUpdate(textUpdate(updateId++, USER_ID, '📁 My Sources'));
    assert.match(String(api.last('sendRichMessage')?.body.rich_message?.html ?? ''), /Source list/, 'the tap opened the sources list');
    assert.deepEqual(keywordsOf(), [null, null], 'and wrote no keywords');

    // 2. Another tap on the list cancels the prompt instead of leaving it armed.
    await bot.handleUpdate(commandUpdate(updateId++, USER_ID, 'filter'));
    await bot.handleUpdate(callbackUpdate(updateId++, USER_ID, `kw:edit:${cards[0]?.id}`));
    await bot.handleUpdate(callbackUpdate(updateId++, USER_ID, `kw:clear:${cards[1]?.id}`));
    await bot.handleUpdate(textUpdate(updateId++, USER_ID, 'stale'));
    assert.deepEqual(keywordsOf(), [null, null], 'the cancelled prompt wrote nothing');
  } finally {
    db.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('the filter is per chat, and a skipped post stays skipped', async () => {
  const api = await fakeBotApi();
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-kw-'));
  const config = cfg();
  const db = openDb(join(dir, 'bot.db'));
  allowUser(db, USER_ID);

  try {
    const user = ensureUser(db, USER_ID);
    const mine = ensurePrivateChat(db, user.id, USER_ID);
    const channel = upsertChat(db, { ownerUserId: user.id, tgChatId: -100123, type: 'channel', title: 'Feed', messageThreadId: null, canPost: true, verifiedAt: Date.now(), rightsJson: null });
    const source = upsertSource(db, {
      platform: 'rss',
      canonicalUrl: 'https://c.test',
      externalId: 'c.test',
      feedUrl: 'https://c.test/feed',
      strategy: 'native_rss',
      title: 'Keyword Blog',
      avatarUrl: null,
    });
    insertSubscription(db, { userId: user.id, sourceId: source.id, chatId: mine.id, deliver: true, nextSlotAt: null, keywords: 'Sport' });
    insertSubscription(db, { userId: user.id, sourceId: source.id, chatId: channel.id, deliver: true, nextSlotAt: null });
    for (const post of insertPosts(db, source.id, parseFeed(fixture, FEED_URL).items)) {
      markPendingDelivery(db, post.id, mine.id);
      markPendingDelivery(db, post.id, channel.id);
    }

    const bot = createBot({ cfg: config, db, apiRoot: api.apiRoot, http });
    await bot.init();
    const { engine } = recordingEngine();
    const deps = { db, http, cfg: config, media: engine, thumbnail: async () => null, sender: new TelegramSender(bot.api) };

    const first = await deliverPending(deps, source.id);
    assert.equal(first.delivered, 4, 'one chat takes the tagged post, the other takes all three');
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM deliveries WHERE status = 'skipped'"), 2, 'only the filtered chat drops two');

    // Broadening the list later does not resurrect what was already decided.
    db.prepare('UPDATE subscriptions SET keywords = NULL').run();
    const second = await deliverPending(deps, source.id);
    assert.equal(second.delivered, 0);
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM deliveries WHERE status = 'skipped'"), 2, 'skipped is final');
  } finally {
    db.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('a v4 file migrates to v5 with every row intact', () => {
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-kw-'));
  const path = join(dir, 'v4.db');

  try {
    const raw = new DatabaseSync(path);
    raw.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, tg_user_id INTEGER NOT NULL UNIQUE, tz TEXT NOT NULL DEFAULT 'UTC',
        locale TEXT, created_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending');
      CREATE TABLE subscriptions (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, source_id INTEGER NOT NULL, chat_id INTEGER NOT NULL,
        deliver INTEGER NOT NULL DEFAULT 1, next_slot_at INTEGER, created_at INTEGER NOT NULL, content_types TEXT, UNIQUE (source_id, chat_id));
      INSERT INTO users (tg_user_id, created_at, status) VALUES (777, 1, 'allowed');
      INSERT INTO subscriptions (user_id, source_id, chat_id, created_at, content_types) VALUES (1, 3, 4, 1, 'video');
      PRAGMA user_version = 4;
    `);
    raw.close();

    const db = openDb(path);
    try {
      assert.equal(schemaVersion(db), SCHEMA_VERSION);
      assert.equal((db.prepare('SELECT content_types AS c FROM subscriptions').get() as { c: string }).c, 'video', 'the existing choice survives');
      assert.equal(count(db, 'SELECT COUNT(*) AS n FROM subscriptions WHERE keywords IS NULL'), 1, 'a v4 row starts unfiltered');
      assert.equal(count(db, 'SELECT COUNT(*) AS n FROM users WHERE default_keywords IS NULL'), 1, 'and has no default');
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('/filter sets the user default, which covers a subscription with no list of its own', async () => {
  const api = await fakeBotApi();
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-kw-'));
  const config = cfg();
  const db = openDb(join(dir, 'bot.db'));
  allowUser(db, USER_ID);
  let updateId = 40;

  try {
    const user = ensureUser(db, USER_ID);
    const chat = ensurePrivateChat(db, user.id, USER_ID);
    const source = upsertSource(db, {
      platform: 'rss',
      canonicalUrl: 'https://other.test',
      externalId: 'other.test',
      feedUrl: 'https://other.test/feed',
      strategy: 'native_rss',
      title: 'Keyword Blog',
      avatarUrl: null,
    });
    insertSubscription(db, { userId: user.id, sourceId: source.id, chatId: chat.id, deliver: true, nextSlotAt: null });
    for (const post of insertPosts(db, source.id, parseFeed(fixture, FEED_URL).items)) markPendingDelivery(db, post.id, chat.id);

    const bot = createBot({ cfg: config, db, apiRoot: api.apiRoot, http });
    await bot.init();

    await bot.handleUpdate(commandUpdate(updateId++, USER_ID, 'filter'));
    const screen = String(api.last('sendMessage')?.body.text ?? '');
    assert.match(screen, /Default keywords: none — every post/);
    assert.match(screen, /Keyword Blog — none — every post/, 'the row says it follows the default');

    await bot.handleUpdate(callbackUpdate(updateId++, USER_ID, 'kw:def'));
    assert.match(String(api.last('sendMessage')?.body.text ?? ''), /default keywords/i);
    await bot.handleUpdate(textUpdate(updateId++, USER_ID, 'roundup'));
    assert.equal((db.prepare('SELECT default_keywords AS k FROM users WHERE tg_user_id = ?').get(USER_ID) as { k: string }).k, 'roundup');
    assert.match(String(api.last('editMessageText')?.body.text ?? ''), /Default keywords: roundup/, 'the list is repainted in place');

    const { engine, urls } = recordingEngine();
    const result = await deliverPending({ db, http, cfg: config, media: engine, thumbnail: async () => null, sender: new TelegramSender(bot.api) }, source.id);
    assert.equal(result.delivered, 1, 'the default is applied to a row that has no list');
    assert.deepEqual(urls, ['https://keyword.test/roundup']);

    // `/skip` on the same prompt clears the fallback, and the list says so.
    await bot.handleUpdate(callbackUpdate(updateId++, USER_ID, 'kw:def'));
    await bot.handleUpdate(textUpdate(updateId++, USER_ID, '/skip'));
    assert.equal((db.prepare('SELECT default_keywords AS k FROM users WHERE tg_user_id = ?').get(USER_ID) as { k: string | null }).k, null);
    assert.match(String(api.last('editMessageText')?.body.text ?? ''), /Default keywords: none — every post/);
  } finally {
    db.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
