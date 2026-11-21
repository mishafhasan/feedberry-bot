/**
 * M8 verification (IMPLEMENTATION_PLAN §4 M8): an RSSHub 502 three times in a row, then a 429
 * with retry_after=7. The source health, the events trail and the alert fan-out are asserted;
 * the sender sleeps 8 s and succeeds without spending a job attempt.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createBot } from '../../src/bot/index.ts';
import { parseConfig } from '../../src/config.ts';
import { openDb, type Db } from '../../src/db/index.ts';
import { ensurePrivateChat } from '../../src/db/repos/chats.ts';
import { markPendingDelivery } from '../../src/db/repos/deliveries.ts';
import { insertPosts } from '../../src/db/repos/posts.ts';
import { upsertSource } from '../../src/db/repos/sources.ts';
import { insertSubscription } from '../../src/db/repos/subscriptions.ts';
import { ensureUser } from '../../src/db/repos/users.ts';
import { runOnce } from '../../src/jobs/worker.ts';
import { enqueue, PRIORITY } from '../../src/jobs/queue.ts';
import type { MediaEngine } from '../../src/media/media-engine.ts';
import type { Notifier } from '../../src/obs/alerts.ts';
import { Coded, E } from '../../src/platform/errors.ts';
import type { FeedMedia } from '../../src/platform/feed/native.ts';
import type { Http } from '../../src/platform/http.ts';
import { tick } from '../../src/scheduler/tick.ts';
import { TelegramSender } from '../../src/telegram/api.ts';
import { fakeBotApi } from '../fake-api.ts';
import { allowUser } from '../seed.ts';

const TOKEN = '123456:AAHfakeTokenForTestsOnly_1234567890abc';
const USER_ID = 555;
const RSSHUB_BASE = 'http://rsshub.test';
const FEED_URL = `${RSSHUB_BASE}/instagram/user/cristiano`;

const count = (db: Db, sql: string, ...args: Array<string | number>): number => (db.prepare(sql).get(...args) as { n: number }).n;

/** rsshub-502.json: every feed request answers 502. */
const http: Http = async (url) => {
  if (url === FEED_URL) return { status: 502, url, contentType: 'text/plain', body: 'Bad Gateway' };
  throw new Error(`unexpected fetch ${url}`);
};

const noMedia: MediaEngine = {
  async resolve() {
    return { items: [], title: null, artist: null };
  },
  async download() {
    throw new Error('no media');
  },
};

function setUp(db: Db) {
  const user = ensureUser(db, USER_ID);
  const chat = ensurePrivateChat(db, user.id, USER_ID);
  const source = upsertSource(db, {
    platform: 'instagram',
    canonicalUrl: 'https://instagram.com/cristiano',
    externalId: 'cristiano',
    feedUrl: FEED_URL,
    strategy: 'rsshub',
    title: 'Cristiano Ronaldo',
    avatarUrl: null,
  });
  insertSubscription(db, { userId: user.id, sourceId: source.id, chatId: chat.id, deliver: true, nextSlotAt: Date.now() });
  return { user, chat, source };
}

test('M8: three 502s mark the source failing, log one event each and alert the operator once', async () => {
  const api = await fakeBotApi();
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-m8-'));
  const cfg = parseConfig({ BOT_TOKEN: TOKEN, ADMIN_CHAT_ID: '1', RSSHUB_BASE });
  const db = openDb(join(dir, 'bot.db'));
  const sent: string[] = [];
  const notifier: Notifier = {
    async notify(text) {
      sent.push(text);
    },
  };

  try {
    const { source } = setUp(db);
    const bot = createBot({ cfg, db, apiRoot: api.apiRoot, http, media: noMedia });
    await bot.init();
    const deps = { db, http, cfg, media: noMedia, thumbnail: async () => null, notifier, sender: new TelegramSender(bot.api), workerConcurrency: 1 };

    let now = Date.now();
    for (let round = 0; round < 3; round++) {
      tick(db, now);
      await runOnce(deps, now);
      now += 6 * 60 * 1000; // past the current backoff step
    }

    assert.equal((db.prepare('SELECT consecutive_failures AS n FROM sources WHERE id = ?').get(source.id) as { n: number }).n, 3);
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM events WHERE code = 'fetch_fail' AND source_id = ?", source.id), 3, 'one event per tick');
    assert.equal((db.prepare('SELECT last_error_code AS c FROM sources WHERE id = ?').get(source.id) as { c: string | null }).c, 'E_FEED_DOWN');
    assert.equal(sent.length, 1, 'exactly one operator DM, not one per failure');
    assert.match(sent[0] ?? '', /failed 3 times/);

    // A fourth attempt inside the same day must not alert again.
    tick(db, now);
    await runOnce(deps, now);
    assert.equal(sent.length, 1, 'the 24 h window suppresses repeats');
  } finally {
    db.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('M8: a 429 waits retry_after + 1 s and succeeds without spending a job attempt', async () => {
  const api = await fakeBotApi({}, { fail429Once: 7 });
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-m8b-'));
  const cfg = parseConfig({ BOT_TOKEN: TOKEN, ADMIN_CHAT_ID: '1', RSSHUB_BASE });
  const db = openDb(join(dir, 'bot.db'));

  try {
    // The feed is fine here; only the Bot API is throttled.
    const feedHttp: Http = async (url) => {
      if (url !== FEED_URL) throw new Error(`unexpected fetch ${url}`);
      return {
        status: 200,
        url,
        contentType: 'application/rss+xml',
        body: '<?xml version="1.0"?><rss version="2.0"><channel><title>Cristiano Ronaldo</title><item><title>One post</title><link>https://instagram.com/p/1</link><guid>g1</guid><pubDate>Fri, 24 Oct 2025 10:00:00 GMT</pubDate></item></channel></rss>',
      };
    };

    const { source, chat } = setUp(db);
    const post = insertPosts(db, source.id, [
      { guid: 'g0', link: 'https://instagram.com/p/0', title: 'Seeded', publishedAt: Date.parse('2025-10-23T10:00:00Z'), summary: null, media: [] },
    ])[0];
    assert.ok(post);
    markPendingDelivery(db, post.id, chat.id);
    enqueue(db, { kind: 'deliver_post', targetId: source.id, priority: PRIORITY.manual });

    const bot = createBot({ cfg, db, apiRoot: api.apiRoot, http: feedHttp, media: noMedia });
    await bot.init();
    const deps = { db, http: feedHttp, cfg, media: noMedia, thumbnail: async () => null, sender: new TelegramSender(bot.api), workerConcurrency: 1 };

    const started = Date.now();
    await runOnce(deps, Date.now());
    const waited = Date.now() - started;

    assert.ok(waited >= 8000, `the sender must wait retry_after + 1 s, waited ${waited} ms`);
    const delivery = db.prepare('SELECT status, attempts FROM deliveries WHERE post_id = ?').get(post.id) as { status: string; attempts: number };
    assert.equal(delivery.status, 'sent');
    assert.equal(delivery.attempts, 1, 'a flood wait is not a pipeline failure');

    const sends = api.calls.filter((c) => c.method === 'sendRichMessage');
    assert.equal(sends.length, 2, 'one rejected attempt and one retry');
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM jobs WHERE state = 'done'"), 1, 'the job finished on its first attempt');
  } finally {
    db.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('M8: /status answers the admin only', async () => {
  const api = await fakeBotApi();
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-status-'));
  const cfg = parseConfig({ BOT_TOKEN: TOKEN, ADMIN_CHAT_ID: '1', RSSHUB_BASE });
  const db = openDb(join(dir, 'bot.db'));
  allowUser(db, USER_ID);

  try {
    const bot = createBot({ cfg, db, apiRoot: api.apiRoot, http, media: noMedia });
    await bot.init();

    await bot.handleUpdate({ update_id: 1, message: { message_id: 1, date: 0, chat: { id: USER_ID, type: 'private' }, from: { id: USER_ID, is_bot: false, first_name: 'T' }, text: '/status', entities: [{ type: 'bot_command', offset: 0, length: 7 }] } } as never);
    assert.equal(api.last('sendMessage'), undefined, 'a normal user gets nothing');

    await bot.handleUpdate({ update_id: 2, message: { message_id: 2, date: 0, chat: { id: 1, type: 'private' }, from: { id: 1, is_bot: false, first_name: 'Admin' }, text: '/status', entities: [{ type: 'bot_command', offset: 0, length: 7 }] } } as never);
    assert.match(api.last('sendMessage')?.body.text ?? '', /FeedBerry status[\s\S]*Jobs:/);
  } finally {
    db.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

/** A post the extractor cannot read, delivered once on a source whose feed carries the media itself. */
async function deliverWithoutExtractor(
  platform: string,
  media: FeedMedia[],
  resolve: MediaEngine['resolve'] = async () => { throw new Coded(E.NO_MEDIA, 'login wall'); },
): Promise<{ html: string; media: number }> {
  const api = await fakeBotApi();
  const dir = mkdtempSync(join(tmpdir(), `feedberry-walled-${platform}-`));
  const db = openDb(join(dir, 'bot.db'));
  const link = `https://${platform}.test/p/Walled`;
  const walled: MediaEngine = {
    resolve,
    async download(_item, into) {
      mkdirSync(into, { recursive: true });
      const path = join(into, 'photo.jpg');
      writeFileSync(path, Buffer.alloc(1024, 1));
      return path;
    },
  };

  try {
    const cfg = parseConfig({ BOT_TOKEN: TOKEN, ADMIN_CHAT_ID: '1', RSSHUB_BASE });
    const user = ensureUser(db, USER_ID);
    const chat = ensurePrivateChat(db, user.id, USER_ID);
    const source = upsertSource(db, { platform, canonicalUrl: link, externalId: 'walled', feedUrl: null, strategy: 'native_rss', title: 'Walled', avatarUrl: null });
    insertSubscription(db, { userId: user.id, sourceId: source.id, chatId: chat.id, deliver: true, nextSlotAt: null });
    const post = insertPosts(db, source.id, [{ guid: 'walled', link, title: 'A walled post', publishedAt: Date.parse('2025-10-24T10:00:00Z'), summary: null, media }])[0];
    assert.ok(post);
    markPendingDelivery(db, post.id, chat.id);
    enqueue(db, { kind: 'deliver_post', targetId: source.id, priority: PRIORITY.manual });

    const bot = createBot({ cfg, db, apiRoot: api.apiRoot, http, media: walled });
    await bot.init();
    await runOnce({ db, http, cfg, media: walled, thumbnail: async () => null, sender: new TelegramSender(bot.api), workerConcurrency: 1 }, Date.now());

    const rich = api.last('sendRichMessage')?.body.rich_message as { html?: string; media?: unknown[] } | undefined;
    return { html: String(rich?.html ?? ''), media: (rich?.media ?? []).length };
  } finally {
    db.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

test('M8: an Instagram or Facebook post the extractor walls still ships the photos its feed carries', async () => {
  const photo: FeedMedia = { url: 'https://cdn.example.test/C4.jpg', type: 'photo' };

  const instagram = await deliverWithoutExtractor('instagram', [photo]);
  assert.match(instagram.html, /tg:\/\/photo\?id=m0/, 'the feed photo rides in the slideshow');
  assert.equal(instagram.media, 1);

  const facebook = await deliverWithoutExtractor('facebook', [photo]);
  assert.match(facebook.html, /tg:\/\/photo\?id=m0/, 'ADR-032 reaches Facebook too');
  assert.equal(facebook.media, 1);

  const x = await deliverWithoutExtractor('x', [photo]);
  assert.equal(x.media, 0, 'elsewhere a feed photo is only a clip\'s thumbnail and stays dropped (R14)');
});

test('M8: the feed album beats the single picture the page stated', async () => {
  const cover = {
    items: [{ kind: 'photo' as const, url: 'https://cdn.example.test/cover.jpg', picker: false }],
    title: null,
    artist: null,
  };
  const album: FeedMedia[] = [
    { url: 'https://cdn.example.test/A1.jpg', type: 'photo' },
    { url: 'https://cdn.example.test/A2.jpg', type: 'photo' },
  ];

  const facebook = await deliverWithoutExtractor('facebook', album, async () => cover);
  assert.equal(facebook.media, 2, 'the whole album, not the og:image the generic extractor read');

  const instagram = await deliverWithoutExtractor('instagram', album, async () => cover);
  assert.equal(instagram.media, 2, 'one rule for both doors');
});

test('M8: an unparseable post is resent as plain text, not dropped', async () => {
  const api = await fakeBotApi({}, { failParseOnce: true });
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-parse-'));
  const cfg = parseConfig({ BOT_TOKEN: TOKEN, ADMIN_CHAT_ID: '1', RSSHUB_BASE });
  const db = openDb(join(dir, 'bot.db'));

  try {
    const { source, chat } = setUp(db);
    const post = insertPosts(db, source.id, [
      { guid: 'p-1', link: 'https://instagram.com/p/1', title: 'Bold <title>', publishedAt: Date.parse('2025-10-24T10:00:00Z'), summary: null, media: [] },
    ])[0];
    assert.ok(post);
    markPendingDelivery(db, post.id, chat.id);
    enqueue(db, { kind: 'deliver_post', targetId: source.id, priority: PRIORITY.manual });

    const bot = createBot({ cfg, db, apiRoot: api.apiRoot, http, media: noMedia });
    await bot.init();
    await runOnce({ db, http, cfg, media: noMedia, thumbnail: async () => null, sender: new TelegramSender(bot.api), workerConcurrency: 1 }, Date.now());

    const rich = api.calls.filter((c) => c.method === 'sendRichMessage');
    assert.equal(rich.length, 1, 'the rejected rich attempt');
    const sends = api.calls.filter((c) => c.method === 'sendMessage');
    assert.equal(sends.length, 1, 'one plain-text resend');
    assert.equal(sends[0]?.body.parse_mode, undefined, 'the retry drops parse_mode');
    assert.doesNotMatch(String(sends[0]?.body.text), /&lt;|&gt;|&amp;/, 'HTML entities are undone for the plain resend');
    assert.match(String(sends[0]?.body.text), /Bold <title>/, 'the literal text survives the round trip');

    const delivery = db.prepare('SELECT status FROM deliveries WHERE post_id = ?').get(post.id) as { status: string };
    assert.equal(delivery.status, 'sent');
  } finally {
    db.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
