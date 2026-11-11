/**
 * Regression: a post reaches a chat once, however many paths lead to it — the backfill job, a
 * fetch job running at the same time, or a feed that lists the same item twice in one response.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createBot } from '../../src/bot/index.ts';
import { parseConfig } from '../../src/config.ts';
import { runOnce } from '../../src/jobs/worker.ts';
import { openDb, type Db } from '../../src/db/index.ts';
import { getSource } from '../../src/db/repos/sources.ts';
import type { MediaEngine } from '../../src/media/media-engine.ts';
import type { Http } from '../../src/platform/http.ts';
import { deliverPending, runFetchSource } from '../../src/pipeline/run.ts';
import { tick } from '../../src/scheduler/tick.ts';
import { TelegramSender } from '../../src/telegram/api.ts';
import { callbackUpdate, fakeBotApi, startUpdate, textUpdate } from '../fake-api.ts';
import { allowUser } from '../seed.ts';

const TOKEN = '123456:AAHfakeTokenForTestsOnly_1234567890abc';
const USER_ID = 555;
const RSSHUB_BASE = 'http://rsshub.test';

const noMedia: MediaEngine = {
  async resolve() {
    return { items: [], title: null, artist: null };
  },
  async download() {
    throw new Error('no media');
  },
};

const item = (guid: string, link: string, title: string, day: number): string =>
  `<item><title>${title}</title><link>${link}</link><guid>${guid}</guid><pubDate>Sat, ${day} Oct 2026 10:00:00 GMT</pubDate></item>`;

/** RSSHub answers the same post twice: a pinned copy and its timeline copy, different guids. */
const duplicatedFeed = `<?xml version="1.0"?><rss version="2.0"><channel><title>Cristiano</title>
  ${item('pin-1', 'https://www.instagram.com/p/PIN/', 'Pinned post', 25)}
  ${item('ig-2', 'https://www.instagram.com/p/B/', 'Second post', 24)}
  ${item('ig-3', 'https://www.instagram.com/p/C/', 'Third post', 23)}
  ${item('ig-1', 'https://www.instagram.com/p/PIN/?utm_source=ig_web', 'Pinned post', 25)}
</channel></rss>`;

const feed = `<?xml version="1.0"?><rss version="2.0"><channel><title>Cristiano</title>
  ${item('ig-1', 'https://www.instagram.com/p/A/', 'First post', 25)}
  ${item('ig-2', 'https://www.instagram.com/p/B/', 'Second post', 24)}
</channel></rss>`;

const count = (db: Db, sql: string, ...args: Array<string | number>): number => (db.prepare(sql).get(...args) as { n: number }).n;

async function addHeadless(http: Http) {
  const api = await fakeBotApi();
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-dup-'));
  const cfg = parseConfig({ BOT_TOKEN: TOKEN, ADMIN_CHAT_ID: '1', RSSHUB_BASE, CALLBACK_INTERVAL_MS: '0', ADD_INTERVAL_MS: '0' });
  const db = openDb(join(dir, 'bot.db'));
  allowUser(db, USER_ID);
  const bot = createBot({ cfg, db, apiRoot: api.apiRoot, http, media: noMedia });
  await bot.init();
  return { api, dir, cfg, db, bot };
}

async function addSource(bot: Awaited<ReturnType<typeof addHeadless>>['bot'], db: Db, updateId: number): Promise<void> {
  await bot.handleUpdate(startUpdate(1, USER_ID));
  const personal = db.prepare("SELECT id FROM chats WHERE type = 'private'").get() as { id: number };
  await bot.handleUpdate(callbackUpdate(updateId++, USER_ID, 'menu:add'));
  await bot.handleUpdate(textUpdate(updateId++, USER_ID, 'https://www.instagram.com/cristiano/'));
  await bot.handleUpdate(callbackUpdate(updateId++, USER_ID, `add:dest:${personal.id}`));
  await bot.handleUpdate(callbackUpdate(updateId++, USER_ID, 'add:save'));
}

const deliveredTexts = (api: Awaited<ReturnType<typeof fakeBotApi>>, from: number): string[] =>
  api.callsSince(from).filter((call) => call.method === 'sendMessage' || call.method === 'sendPhoto').map((call) => String(call.body.text ?? call.body.caption ?? ''));

test('duplicate: a feed that lists one post twice delivers it once', async () => {
  const http: Http = async (url) => ({ status: 200, url, contentType: 'application/rss+xml', body: duplicatedFeed });
  const { api, dir, cfg, db, bot } = await addHeadless(http);

  try {
    await addSource(bot, db, 10);
    const source = db.prepare('SELECT id FROM sources LIMIT 1').get() as { id: number };
    const mark = api.calls.length;
    await deliverPending({ db, http, cfg, media: noMedia, thumbnail: async () => null, sender: new TelegramSender(bot.api) }, source.id);

    const pinned = deliveredTexts(api, mark).filter((text) => text.includes('Pinned post'));
    assert.equal(pinned.length, 1, `the pinned post arrives once, saw ${pinned.length}`);
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM posts WHERE url LIKE '%/p/PIN/%'"), 1, 'one row for one post');
  } finally {
    db.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('duplicate: a scheduled fetch stores and delivers a repeated item once', async () => {
  let body = feed;
  const http: Http = async (url) => ({ status: 200, url, contentType: 'application/rss+xml', body });
  const { api, dir, cfg, db, bot } = await addHeadless(http);

  try {
    await addSource(bot, db, 30);
    const source = db.prepare('SELECT id FROM sources LIMIT 1').get() as { id: number };
    const mark = api.calls.length;
    body = duplicatedFeed;

    await runFetchSource({ db, http, cfg, media: noMedia, thumbnail: async () => null, sender: new TelegramSender(bot.api) }, source.id);

    const pinned = deliveredTexts(api, mark).filter((text) => text.includes('Pinned post'));
    assert.equal(pinned.length, 1, `the pinned post arrives once, saw ${pinned.length}`);
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM posts WHERE url LIKE '%/p/PIN/%'"), 1, 'the repeated item is not stored twice');
  } finally {
    db.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('duplicate: the real scheduler and worker deliver the backfill once', async () => {
  const http: Http = async (url) => ({ status: 200, url, contentType: 'application/rss+xml', body: feed });
  const { api, dir, cfg, db, bot } = await addHeadless(http);

  try {
    await addSource(bot, db, 40);
    const mark = api.calls.length;
    const deps = { db, http, cfg, media: noMedia, thumbnail: async () => null, sender: new TelegramSender(bot.api), workerConcurrency: 2 };

    // The new subscription is due at once, so the tick queues a fetch beside the backfill job.
    tick(db, Date.now() + 1000);
    for (let round = 0; round < 5; round++) await Promise.all([runOnce(deps), runOnce(deps)]);

    const texts = deliveredTexts(api, mark);
    assert.equal(texts.filter((text) => text.includes('First post')).length, 1, 'First post once');
    assert.equal(texts.filter((text) => text.includes('Second post')).length, 1, 'Second post once');
  } finally {
    db.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('duplicate: the backfill job and a fetch job running together deliver each post once', async () => {
  const http: Http = async (url) => ({ status: 200, url, contentType: 'application/rss+xml', body: feed });
  const { api, dir, cfg, db, bot } = await addHeadless(http);

  try {
    await addSource(bot, db, 20);
    const source = getSource(db, (db.prepare('SELECT id FROM sources LIMIT 1').get() as { id: number }).id);
    assert.ok(source);
    const deps = { db, http, cfg, media: noMedia, thumbnail: async () => null, sender: new TelegramSender(bot.api) };

    // A scheduled fetch delivers everything pending at its end, exactly like the backfill job.
    const mark = api.calls.length;
    await Promise.all([runFetchSource(deps, source.id), deliverPending(deps, source.id)]);

    const texts = deliveredTexts(api, mark);
    assert.equal(texts.filter((text) => text.includes('First post')).length, 1, 'First post once');
    assert.equal(texts.filter((text) => text.includes('Second post')).length, 1, 'Second post once');
  } finally {
    db.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
