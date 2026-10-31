/**
 * M9 verification (IMPLEMENTATION_PLAN §4 M9): the parts a machine can prove — retention, the 403
 * demotion, and a 20-source × 2-chat smoke that drains the queue. The compose/restore drill is
 * operator-only and lives in docs/RUNBOOK.md.
 */
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createBot } from '../../src/bot/index.ts';
import { parseConfig } from '../../src/config.ts';
import { openDb, schemaVersion, type Db } from '../../src/db/index.ts';
import { ensurePrivateChat } from '../../src/db/repos/chats.ts';
import { markPendingDelivery } from '../../src/db/repos/deliveries.ts';
import { recordEvent } from '../../src/db/repos/events.ts';
import { insertPosts } from '../../src/db/repos/posts.ts';
import { upsertSource } from '../../src/db/repos/sources.ts';
import { insertSubscription } from '../../src/db/repos/subscriptions.ts';
import { ensureUser } from '../../src/db/repos/users.ts';
import { runOnce } from '../../src/jobs/worker.ts';
import type { MediaEngine } from '../../src/media/cobalt.ts';
import type { Http } from '../../src/platform/http.ts';
import { deliverPending } from '../../src/pipeline/run.ts';
import { runRetention } from '../../src/pipeline/s9-cleanup.ts';
import { tick } from '../../src/scheduler/tick.ts';
import { TelegramSender } from '../../src/telegram/api.ts';
import { fakeBotApi } from '../fake-api.ts';

const TOKEN = '123456:AAHfakeTokenForTestsOnly_1234567890abc';
const USER_ID = 555;

const count = (db: Db, sql: string, ...args: Array<string | number>): number => (db.prepare(sql).get(...args) as { n: number }).n;

const noMedia: MediaEngine = {
  async resolve() {
    return { items: [], title: null };
  },
  async download() {
    throw new Error('no media');
  },
};

const noFetch: Http = async (url) => {
  throw new Error(`unexpected fetch ${url}`);
};

test('M9: retention prunes old posts and old events, keeps fresh rows', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-ret-'));
  const db = openDb(join(dir, 'bot.db'));
  const now = Date.now();
  try {
    const source = upsertSource(db, {
      platform: 'rss',
      canonicalUrl: 'https://blog.example.test',
      externalId: 'blog',
      feedUrl: null,
      strategy: 'native_rss',
      title: 'Blog',
      avatarUrl: null,
    });
    db.prepare('INSERT INTO posts (source_id, guid, url, first_seen_at) VALUES (?, ?, ?, ?)').run(source.id, 'old', 'https://blog.example.test/old', now - 40 * 86_400_000);
    db.prepare('INSERT INTO posts (source_id, guid, url, first_seen_at) VALUES (?, ?, ?, ?)').run(source.id, 'new', 'https://blog.example.test/new', now);
    recordEvent(db, { level: 'info', code: 'ancient', at: now - 31 * 86_400_000 });
    recordEvent(db, { level: 'info', code: 'recent', at: now });

    const result = runRetention(db, 30, now);

    assert.equal(result.posts, 1, 'the 40-day-old post is gone');
    assert.equal(count(db, 'SELECT COUNT(*) AS n FROM posts'), 1);
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM events WHERE code = 'ancient'"), 0);
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM events WHERE code = 'recent'"), 1);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('M9: a 403 at delivery demotes the chat instead of retrying forever', async () => {
  const CHANNEL_ID = -1001234567890;
  const api = await fakeBotApi({}, { forbidChat: CHANNEL_ID });
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-403-'));
  const cfg = parseConfig({ BOT_TOKEN: TOKEN, ADMIN_CHAT_ID: '1', RSSHUB_BASE: 'http://rsshub.test' });
  const db = openDb(join(dir, 'bot.db'));

  try {
    const user = ensureUser(db, USER_ID);
    const channel = db
      .prepare("INSERT INTO chats (owner_user_id, tg_chat_id, type, title, can_post) VALUES (?, ?, 'channel', 'Channel', 1) RETURNING *")
      .get(user.id, CHANNEL_ID) as { id: number };
    const source = upsertSource(db, {
      platform: 'rss',
      canonicalUrl: 'https://blog.example.test',
      externalId: 'blog',
      feedUrl: null,
      strategy: 'native_rss',
      title: 'Blog',
      avatarUrl: null,
    });
    insertSubscription(db, { userId: user.id, sourceId: source.id, chatId: channel.id, deliver: true, nextSlotAt: null });
    const post = insertPosts(db, source.id, [
      { guid: 'k-1', link: 'https://blog.example.test/1', title: 'One', publishedAt: Date.parse('2025-10-24T10:00:00Z'), summary: null, media: [] },
    ])[0];
    assert.ok(post);
    markPendingDelivery(db, post.id, channel.id);

    const bot = createBot({ cfg, db, apiRoot: api.apiRoot, http: noFetch, media: noMedia });
    await bot.init();
    const result = await deliverPending(
      { db, http: noFetch, cfg, media: noMedia, thumbnail: async () => null, sender: new TelegramSender(bot.api) },
      source.id,
    );

    assert.equal(result.failed, 1);
    assert.equal(
      (db.prepare('SELECT error_code AS c FROM deliveries WHERE post_id = ?').get(post.id) as { c: string | null }).c,
      'E_TG_FORBIDDEN',
    );
    assert.equal((db.prepare('SELECT can_post AS n FROM chats WHERE id = ?').get(channel.id) as { n: number }).n, 0, 'the chat is demoted, not deleted');
  } finally {
    db.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('M9: 20 sources × 2 chats drain without a failure', async () => {
  const api = await fakeBotApi();
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-load-'));
  const cfg = parseConfig({ BOT_TOKEN: TOKEN, ADMIN_CHAT_ID: '1', RSSHUB_BASE: 'http://rsshub.test' });
  const db = openDb(join(dir, 'bot.db'));
  const SOURCES = 20;

  try {
    const user = ensureUser(db, USER_ID);
    const chatA = ensurePrivateChat(db, user.id, USER_ID);
    const chatB = db
      .prepare("INSERT INTO chats (owner_user_id, tg_chat_id, type, title, can_post) VALUES (?, ?, 'group', 'Group', 1) RETURNING *")
      .get(user.id, -100) as { id: number };

    for (let i = 0; i < SOURCES; i++) {
      const canonical = `https://blog${i}.example.test`;
      const source = upsertSource(db, {
        platform: 'rss',
        canonicalUrl: canonical,
        externalId: `blog${i}`,
        feedUrl: `${canonical}/feed`,
        strategy: 'native_rss',
        title: `Blog ${i}`,
        avatarUrl: null,
      });
      insertSubscription(db, { userId: user.id, sourceId: source.id, chatId: chatA.id, deliver: true, nextSlotAt: Date.now() - 1000 });
      insertSubscription(db, { userId: user.id, sourceId: source.id, chatId: chatB.id, deliver: true, nextSlotAt: Date.now() - 1000 });
      // Everything the feed will return is already seen, so this run is fetch-only.
      insertPosts(db, source.id, [
        { guid: `g-${i}`, link: `${canonical}/post`, title: `Post ${i}`, publishedAt: Date.parse('2025-10-24T10:00:00Z'), summary: 'body', media: [] },
      ]);
      db.prepare('UPDATE sources SET interval_minutes = 1 WHERE id = ?').run(source.id);
    }

    const feedHttp: Http = async (url) => {
      const match = /https:\/\/blog(\d+)\.example\.test\/feed/.exec(url);
      if (!match) throw new Error(`unexpected fetch ${url}`);
      const index = match[1];
      return {
        status: 200,
        url,
        contentType: 'application/rss+xml',
        body: `<?xml version="1.0"?><rss version="2.0"><channel><title>Blog ${index}</title><item><title>Post ${index}</title><link>https://blog${index}.example.test/post</link><guid>g-${index}</guid><pubDate>Fri, 24 Oct 2025 10:00:00 GMT</pubDate><description>body</description></item></channel></rss>`,
      };
    };

    const bot = createBot({ cfg, db, apiRoot: api.apiRoot, http: feedHttp, media: noMedia });
    await bot.init();
    const deps = { db, http: feedHttp, cfg, media: noMedia, thumbnail: async () => null, sender: new TelegramSender(bot.api), workerConcurrency: 2 };

    const now = Date.now();
    const ticked = tick(db, now);
    assert.equal(ticked.enqueued, SOURCES, 'one fetch job per due source');
    assert.equal(ticked.advanced, SOURCES * 2, 'every subscription slot advanced');

    let drained = 0;
    while (await runOnce(deps, Date.now())) drained++;
    assert.equal(drained, SOURCES + 1, 'fetch jobs plus the daily cleanup');

    assert.equal(count(db, "SELECT COUNT(*) AS n FROM jobs WHERE kind = 'fetch_source' AND state = 'done'"), SOURCES);
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM jobs WHERE state = 'failed'"), 0);
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM events WHERE code = 'fetch_ok'"), SOURCES);
    assert.equal(count(db, 'SELECT COUNT(*) AS n FROM deliveries'), 0, 'no new items, so nothing was sent');
  } finally {
    db.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('M9 restore drill: an online backup restores to the same state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-restore-'));
  const livePath = join(dir, 'bot.db');
  const backupPath = join(dir, 'backup.db');
  const live = openDb(livePath);

  try {
    const user = ensureUser(live, USER_ID);
    const chat = ensurePrivateChat(live, user.id, USER_ID);
    const source = upsertSource(live, {
      platform: 'rss',
      canonicalUrl: 'https://blog.example.test',
      externalId: 'blog',
      feedUrl: 'https://blog.example.test/feed',
      strategy: 'native_rss',
      title: 'Blog',
      avatarUrl: null,
    });
    insertSubscription(live, { userId: user.id, sourceId: source.id, chatId: chat.id, deliver: true, nextSlotAt: null });
    insertPosts(live, source.id, [
      { guid: 'r-1', link: 'https://blog.example.test/1', title: 'One', publishedAt: 1, summary: 'body', media: [] },
    ]);

    // VACUUM INTO is the in-process equivalent of `sqlite3 .backup`: a consistent snapshot of a live file.
    live.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
    const before = {
      users: count(live, 'SELECT COUNT(*) AS n FROM users'),
      sources: count(live, 'SELECT COUNT(*) AS n FROM sources'),
      subscriptions: count(live, 'SELECT COUNT(*) AS n FROM subscriptions'),
      posts: count(live, 'SELECT COUNT(*) AS n FROM posts'),
    };
    live.close();

    // Restore = copy the file back; the schema version travels inside it.
    copyFileSync(backupPath, livePath);
    const restored = openDb(livePath);
    const after = {
      users: count(restored, 'SELECT COUNT(*) AS n FROM users'),
      sources: count(restored, 'SELECT COUNT(*) AS n FROM sources'),
      subscriptions: count(restored, 'SELECT COUNT(*) AS n FROM subscriptions'),
      posts: count(restored, 'SELECT COUNT(*) AS n FROM posts'),
    };
    assert.equal(schemaVersion(restored), 2, 'the restored file keeps its schema version');
    assert.deepEqual(after, before, '/status would report the same counts after the restore');
    restored.close();
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
