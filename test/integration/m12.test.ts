/**
 * M12: the S16 schedule screen, and the post-text fallbacks of both delivery modes.
 * - `menu:schedule` → list → picker → `sched:set:*` rewrites `interval_minutes` and the slot at once.
 * - Download mode: an extractor without metadata (X/Twitter) keeps the page description as caption.
 * - Scheduled mode: a feed that ships no text keeps the page description as caption.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createBot } from '../../src/bot/index.ts';
import { parseConfig } from '../../src/config.ts';
import { openDb, type Db } from '../../src/db/index.ts';
import { ensurePrivateChat } from '../../src/db/repos/chats.ts';
import { upsertSource } from '../../src/db/repos/sources.ts';
import { insertSubscription } from '../../src/db/repos/subscriptions.ts';
import { ensureUser } from '../../src/db/repos/users.ts';
import { runOnce } from '../../src/jobs/worker.ts';
import type { MediaEngine } from '../../src/media/media-engine.ts';
import type { Http } from '../../src/platform/http.ts';
import { tick } from '../../src/scheduler/tick.ts';
import { TelegramSender } from '../../src/telegram/api.ts';
import { callbackUpdate, commandUpdate, fakeBotApi, startUpdate, textUpdate } from '../fake-api.ts';
import { allowUser } from '../seed.ts';

const TOKEN = '123456:AAHfakeTokenForTestsOnly_1234567890abc';
const USER_ID = 777;
const RSSHUB_BASE = 'http://rsshub.test';
const FEED = readFileSync(new URL('../fixtures/text-source.rss', import.meta.url), 'utf8');
const TIKTOK_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>TikTok Demo</title><link>https://tiktok.com/@demo</link><description>media only</description>
  <item>
    <title></title>
    <link>https://tiktok.com/@demo/video/1</link>
    <guid>v-1</guid>
    <pubDate>Wed, 22 Oct 2025 10:00:00 GMT</pubDate>
    <description></description>
  </item>
</channel></rss>`;

const count = (db: Db, sql: string, ...args: Array<string | number>): number => (db.prepare(sql).get(...args) as { n: number }).n;

const noMedia: MediaEngine = {
  async resolve() {
    return { items: [], title: null, artist: null };
  },
  async download() {
    throw new Error('no media');
  },
};

test('M12 S16: the schedule screen sets a cadence and moves the slot at once', async () => {
  const api = await fakeBotApi();
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-m12-'));
  const cfg = parseConfig({ BOT_TOKEN: TOKEN, ADMIN_CHAT_ID: '1', RSSHUB_BASE, CALLBACK_INTERVAL_MS: '0', ADD_INTERVAL_MS: '0' });
  const db = openDb(join(dir, 'bot.db'));
  allowUser(db, USER_ID);
  const http: Http = async (url) => {
    if (url === 'https://blog.example.test/' || url === 'https://blog.example.test') return { status: 200, url, contentType: 'application/rss+xml', body: FEED };
    throw new Error(`unexpected fetch ${url}`);
  };
  let updateId = 100;

  try {
    const bot = createBot({ cfg, db, apiRoot: api.apiRoot, http, media: noMedia });
    await bot.init();
    await bot.handleUpdate(startUpdate(1, USER_ID));
    assert.match(JSON.stringify(api.last('sendRichMessage')?.body ?? {}), /menu:schedule/, 'S1 carries the Schedule button');

    // Add a source silently so the schedule screen has something to list.
    await bot.handleUpdate(callbackUpdate(updateId++, USER_ID, 'menu:add'));
    await bot.handleUpdate(textUpdate(updateId++, USER_ID, 'https://blog.example.test/'));
    const personal = db.prepare("SELECT id FROM chats WHERE type = 'private'").get() as { id: number };
    await bot.handleUpdate(callbackUpdate(updateId++, USER_ID, `add:dest:${personal.id}`));
    await bot.handleUpdate(callbackUpdate(updateId++, USER_ID, 'add:save_silent'));
    const source = db.prepare("SELECT id FROM sources WHERE canonical_url = 'https://blog.example.test'").get() as { id: number };

    // S1 → S16: every source carries its cadence and opens the picker.
    await bot.handleUpdate(callbackUpdate(updateId++, USER_ID, 'menu:schedule'));
    const list = JSON.stringify(api.last('editMessageText')?.body ?? {});
    assert.match(list, /Check schedule/);
    assert.match(list, new RegExp(`src:sched:${source.id}`));
    assert.match(list, /08:00 & 20:00/, 'the default cadence is shown');

    await bot.handleUpdate(callbackUpdate(updateId++, USER_ID, `src:sched:${source.id}`));
    assert.equal(api.last('answerCallbackQuery')?.body.text, undefined, 'opening the picker answers silently');
    const picker = JSON.stringify(api.last('editMessageText')?.body ?? {});
    assert.match(picker, /How often should the bot check this source\?/);
    assert.match(picker, new RegExp(`sched:set:${source.id}:0`));
    assert.match(picker, new RegExp(`sched:set:${source.id}:360`));

    // One hour: the row and the subscription slot both change immediately.
    const mark = Date.now();
    await bot.handleUpdate(callbackUpdate(updateId++, USER_ID, `sched:set:${source.id}:60`));
    assert.equal(api.last('answerCallbackQuery')?.body.text, 'Schedule updated.');
    assert.equal((db.prepare('SELECT interval_minutes FROM sources WHERE id = ?').get(source.id) as { interval_minutes: number | null }).interval_minutes, 60);
    const slot = (db.prepare('SELECT next_slot_at FROM subscriptions WHERE source_id = ?').get(source.id) as { next_slot_at: number }).next_slot_at;
    assert.ok(slot >= mark + 3_590_000 && slot <= mark + 3_610_000, 'the slot moved to now + 1 h');
    assert.match(JSON.stringify(api.last('editMessageText')?.body ?? {}), /✅ Every 1 h/);

    // Default: interval cleared, slot back on the next 08:00/20:00.
    await bot.handleUpdate(callbackUpdate(updateId++, USER_ID, `sched:set:${source.id}:0`));
    assert.equal((db.prepare('SELECT interval_minutes FROM sources WHERE id = ?').get(source.id) as { interval_minutes: number | null }).interval_minutes, null);
    const next = (db.prepare('SELECT next_slot_at FROM subscriptions WHERE source_id = ?').get(source.id) as { next_slot_at: number }).next_slot_at;
    assert.ok(next > Date.now() && next <= Date.now() + 12 * 3_600_000, 'the default returns the next 08:00/20:00');

    // Only the owner may change a source, and only the offered values are legal.
    await bot.handleUpdate(callbackUpdate(updateId++, USER_ID + 1, `sched:set:${source.id}:15`));
    assert.equal((db.prepare('SELECT interval_minutes FROM sources WHERE id = ?').get(source.id) as { interval_minutes: number | null }).interval_minutes, null);
    await bot.handleUpdate(callbackUpdate(updateId++, USER_ID, `sched:set:${source.id}:7`));
    assert.equal((db.prepare('SELECT interval_minutes FROM sources WHERE id = ?').get(source.id) as { interval_minutes: number | null }).interval_minutes, null);

    // All sources at once: one cadence for the whole list, same immediate slot move.
    await bot.handleUpdate(callbackUpdate(updateId++, USER_ID, 'sched:all'));
    const allPicker = JSON.stringify(api.last('editMessageText')?.body ?? {});
    assert.match(allPicker, /All sources/);
    assert.match(allPicker, /sched:setall:360/);
    const markAll = Date.now();
    await bot.handleUpdate(callbackUpdate(updateId++, USER_ID, 'sched:setall:360'));
    assert.equal(api.last('answerCallbackQuery')?.body.text, 'Schedule updated.');
    assert.equal((db.prepare('SELECT interval_minutes FROM sources WHERE id = ?').get(source.id) as { interval_minutes: number | null }).interval_minutes, 360);
    const slotAll = (db.prepare('SELECT next_slot_at FROM subscriptions WHERE source_id = ?').get(source.id) as { next_slot_at: number }).next_slot_at;
    assert.ok(slotAll >= markAll + 6 * 3_600_000 - 5_000 && slotAll <= markAll + 6 * 3_600_000 + 5_000, 'the bulk cadence moves every slot to now + 6 h');

    // The command menu entry answers with its own message.
    await bot.handleUpdate(commandUpdate(updateId++, USER_ID, 'schedule'));
    assert.match(api.last('sendMessage')?.body.text ?? '', /Check schedule/);
  } finally {
    db.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('M12 Download: an extractor without metadata keeps the page description as the caption', async () => {
  const api = await fakeBotApi();
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-m12-dl-'));
  const cfg = parseConfig({ BOT_TOKEN: TOKEN, ADMIN_CHAT_ID: '1', RSSHUB_BASE, CALLBACK_INTERVAL_MS: '0', ADD_INTERVAL_MS: '0' });
  const db = openDb(join(dir, 'bot.db'));
  allowUser(db, USER_ID);
  const http: Http = async (url) => {
    if (url === 'https://x.com/blue/status/123') {
      return { status: 200, url, contentType: 'text/html; charset=utf-8', body: '<html><head><meta name="twitter:description" content="Hello from the post"></head><body></body></html>' };
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const media: MediaEngine = {
    async resolve() {
      return { items: [{ kind: 'photo', url: 'https://cdn.example.test/p.jpg', picker: false }], title: null, artist: null };
    },
    async download(_item, workDir) {
      mkdirSync(workDir, { recursive: true });
      const path = join(workDir, 'media-photo');
      writeFileSync(path, 'jpeg-bytes');
      return path;
    },
  };
  let updateId = 200;

  try {
    const bot = createBot({ cfg, db, apiRoot: api.apiRoot, http, media });
    await bot.init();
    await bot.handleUpdate(startUpdate(1, USER_ID));

    await bot.handleUpdate(textUpdate(updateId++, USER_ID, 'https://x.com/blue/status/123'));
    assert.match(api.last('sendMessage')?.body.text ?? '', /post link/i, 'a pasted post link is offered as a download');
    await bot.handleUpdate(callbackUpdate(updateId++, USER_ID, 'dl:post'));

    const rich = api.last('sendRichMessage');
    const html = String(rich?.body.rich_message?.html ?? '');
    assert.match(html, /Hello from the post/, 'the post text is kept, not dropped');
    assert.match(html, /<a href="https:\/\/x\.com\/blue\/status\/123">@blue<\/a> \| X/, 'the account the link names is the source, and the platform follows it');
    assert.equal(rich?.body.rich_message?.skip_entity_detection, true);
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM deliveries WHERE post_id IS NULL AND status = 'sent'"), 1);
    assert.doesNotMatch(JSON.stringify(api.last('sendMessage')?.body ?? {}), /add:post/, 'no profile is invented for a post-only platform');
  } finally {
    db.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('M12 Download: the page names the account and dates the post, like a scheduled delivery', async () => {
  const api = await fakeBotApi();
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-m12-meta-'));
  const cfg = parseConfig({ BOT_TOKEN: TOKEN, ADMIN_CHAT_ID: '1', RSSHUB_BASE, CALLBACK_INTERVAL_MS: '0', ADD_INTERVAL_MS: '0' });
  const db = openDb(join(dir, 'bot.db'));
  allowUser(db, USER_ID);
  // The extractor returns media only; the page carries the account, the date and the words.
  const http: Http = async (url) => {
    if (url === 'https://x.com/blue/status/123') {
      return {
        status: 200,
        url,
        contentType: 'text/html; charset=utf-8',
        body: '<html><head><meta property="og:title" content="The World Of Funny (@TheWorldOfFunny) on X">'
          + '<meta property="og:description" content="Bro turned the whole resort up!">'
          + '<meta property="article:published_time" content="2025-08-10T16:55:47.000Z"></head><body></body></html>',
      };
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const media: MediaEngine = {
    async resolve() {
      return { items: [{ kind: 'photo', url: 'https://cdn.example.test/p.jpg', picker: false }], title: null, artist: null };
    },
    async download(_item, workDir) {
      mkdirSync(workDir, { recursive: true });
      const path = join(workDir, 'media-photo');
      writeFileSync(path, 'jpeg-bytes');
      return path;
    },
  };

  try {
    const bot = createBot({ cfg, db, apiRoot: api.apiRoot, http, media });
    await bot.init();
    await bot.handleUpdate(startUpdate(1, USER_ID));
    await bot.handleUpdate(textUpdate(2, USER_ID, 'https://x.com/blue/status/123'));
    await bot.handleUpdate(callbackUpdate(3, USER_ID, 'dl:post'));

    const html = String(api.last('sendRichMessage')?.body.rich_message?.html ?? '');
    assert.match(
      html,
      /^<h3><tg-emoji emoji-id="\d+">✖️<\/tg-emoji> <a href="https:\/\/x\.com\/blue\/status\/123">The World Of Funny<\/a> \| X<\/h3><p>⏱️ <b>Time<\/b>: <tg-time unix="1754844947" format="r">/,
      `one heading source line, then the bold live time (saw ${html.slice(0, 160)}…)`,
    );
    assert.match(html, /<blockquote expandable>Bro turned the whole resort up!<\/blockquote>/);
  } finally {
    db.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('M12 Download: a Snapchat spotlight page delivers its clip in the same layout', async () => {
  const api = await fakeBotApi();
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-m12-snap-'));
  const cfg = parseConfig({ BOT_TOKEN: TOKEN, ADMIN_CHAT_ID: '1', RSSHUB_BASE, CALLBACK_INTERVAL_MS: '0', ADD_INTERVAL_MS: '0' });
  const db = openDb(join(dir, 'bot.db'));
  allowUser(db, USER_ID);
  const link = 'https://www.snapchat.com/@klipz96/spotlight/W7_EDlXWTBiXAEEniNoMPwAAYc3ZwZXdmdHdmAZGAhOJfAZGAhNupAAAAAQ';
  // cobalt has no Snapchat extractor; the head carries the account, the date and the clip.
  const http: Http = async (url) => {
    if (new URL(url).hostname.endsWith('snapchat.com')) {
      return {
        status: 200,
        url,
        contentType: 'text/html; charset=utf-8',
        body: '<html><head><meta property="og:title" content="22 likes and 5 shares | #meme | Funny Vidz (@klipz96) | Posted Aug 23">'
          + '<meta property="og:description" content="Watch as Funny Vidz captures another unsuspecting victim.">'
          + '<meta property="og:video" content="https://bolt-gcdn.sc-cdn.net/y/clip.mp4?mo=1">'
          + '<meta property="article:published_time" content="2024-08-23T18:34:36.329Z"></head><body></body></html>',
      };
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const downloaded: string[] = [];
  const media: MediaEngine = {
    async resolve() {
      throw new Error('cobalt must not be asked for a Snapchat link');
    },
    async download(item, workDir) {
      downloaded.push(item.url);
      mkdirSync(workDir, { recursive: true });
      const path = join(workDir, 'media-video');
      writeFileSync(path, 'mp4-bytes');
      return path;
    },
  };

  try {
    const bot = createBot({ cfg, db, apiRoot: api.apiRoot, http, media });
    await bot.init();
    await bot.handleUpdate(startUpdate(1, USER_ID));
    await bot.handleUpdate(textUpdate(2, USER_ID, link));
    await bot.handleUpdate(callbackUpdate(3, USER_ID, 'dl:post'));

    assert.deepEqual(downloaded, ['https://bolt-gcdn.sc-cdn.net/y/clip.mp4?mo=1'], 'the card video is the download');
    const html = String(api.last('sendRichMessage')?.body.rich_message?.html ?? '');
    assert.match(
      html,
      /^<h3><tg-emoji emoji-id="\d+">👻<\/tg-emoji> <a href="https:\/\/snapchat\.com\/@klipz96\/spotlight\/[^"]+">Funny Vidz<\/a> \| Snapchat<\/h3><p>⏱️ <b>Time<\/b>: <tg-time unix="1724438076" format="r">/,
      `one heading source line, then the bold live time (saw ${html.slice(0, 160)}…)`,
    );
    assert.match(html, /<blockquote expandable>Watch as Funny Vidz captures another unsuspecting victim\.<\/blockquote>/);
    assert.match(html, /<tg-slideshow><video src="tg:\/\/video\?id=m0"><\/video><\/tg-slideshow>/);
  } finally {
    db.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('M12 Download: an engine caption above 1024 chars rides whole in one rich message', async () => {
  const api = await fakeBotApi();
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-m12-long-'));
  const cfg = parseConfig({ BOT_TOKEN: TOKEN, ADMIN_CHAT_ID: '1', RSSHUB_BASE, CALLBACK_INTERVAL_MS: '0', ADD_INTERVAL_MS: '0' });
  const db = openDb(join(dir, 'bot.db'));
  allowUser(db, USER_ID);
  const pages: Array<{ title: string; content: string }> = [];
  const telegraph = {
    async createPage(page: { title: string; content: string }) {
      pages.push(page);
      return `https://telegra.ph/long-${pages.length}`;
    },
  };
  const http: Http = async () => {
    throw new Error('no page fetch is needed when the engine carries the text');
  };
  const long = 'word '.repeat(300).trim();
  const media: MediaEngine = {
    async resolve() {
      return { items: [{ kind: 'photo', url: 'https://cdn.example.test/p.jpg', picker: false }], title: long, artist: 'MissDelulu9' };
    },
    async download(_item, workDir) {
      mkdirSync(workDir, { recursive: true });
      const path = join(workDir, 'media-photo');
      writeFileSync(path, 'jpeg-bytes');
      return path;
    },
  };

  try {
    const bot = createBot({ cfg, db, apiRoot: api.apiRoot, http, media, telegraph });
    await bot.init();
    await bot.handleUpdate(startUpdate(1, USER_ID));
    await bot.handleUpdate(textUpdate(2, USER_ID, 'https://x.com/MissDelulu9/status/2116793013774975408'));
    await bot.handleUpdate(callbackUpdate(3, USER_ID, 'dl:post'));

    const html = String(api.last('sendRichMessage')?.body.rich_message?.html ?? '');
    // The fold between the preview and the quote eats one space, so count the words, not the string.
    assert.equal((html.match(/word/g) ?? []).length, 300, 'every word of the caption rides inside the rich message');
    assert.match(html, /<blockquote expandable>/, 'the whole caption sits in the quote');
    assert.match(html, /<tg-slideshow><img src="tg:\/\/photo\?id=m0"\/><\/tg-slideshow>/, 'the photo rides in the slideshow');
    assert.doesNotMatch(html, /Read more/, 'no Instant View link on the rich path');
    assert.equal(pages.length, 0, 'Download Mode never publishes a Telegraph page (ADR-023)');
  } finally {
    db.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('M12 Download: X long-form text comes from the full-text mirror, whole in the rich message', async () => {
  const api = await fakeBotApi();
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-m12-xlong-'));
  const cfg = parseConfig({ BOT_TOKEN: TOKEN, ADMIN_CHAT_ID: '1', RSSHUB_BASE, CALLBACK_INTERVAL_MS: '0', ADD_INTERVAL_MS: '0' });
  const db = openDb(join(dir, 'bot.db'));
  allowUser(db, USER_ID);
  const pages: Array<{ title: string; content: string }> = [];
  const telegraph = {
    async createPage(page: { title: string; content: string }) {
      pages.push(page);
      return `https://telegra.ph/x-${pages.length}`;
    },
  };
  const long = `${'word '.repeat(240).trim()} END-OF-POST`;
  const http: Http = async (url) => {
    if (url === 'https://api.fxtwitter.com/blue/status/123') {
      return { status: 200, url, contentType: 'application/json', body: JSON.stringify({ tweet: { text: long } }) };
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const media: MediaEngine = {
    async resolve() {
      return { items: [{ kind: 'photo', url: 'https://cdn.example.test/p.jpg', picker: false }], title: 'Short 280-char cut', artist: null };
    },
    async download(_item, workDir) {
      mkdirSync(workDir, { recursive: true });
      const path = join(workDir, 'media-photo');
      writeFileSync(path, 'jpeg-bytes');
      return path;
    },
  };

  try {
    const bot = createBot({ cfg, db, apiRoot: api.apiRoot, http, media, telegraph });
    await bot.init();
    await bot.handleUpdate(startUpdate(1, USER_ID));
    await bot.handleUpdate(textUpdate(2, USER_ID, 'https://x.com/blue/status/123'));
    await bot.handleUpdate(callbackUpdate(3, USER_ID, 'dl:post'));

    const html = String(api.last('sendRichMessage')?.body.rich_message?.html ?? '');
    assert.doesNotMatch(html, /Short 280-char cut/, 'the engine cut is replaced by the full post');
    assert.ok(html.includes('END-OF-POST'), 'the full mirror text rides inside the rich message');
    assert.ok(html.includes('word word word'));
    assert.equal(pages.length, 0, 'no Telegraph page on the rich path (ADR-023)');
  } finally {
    db.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('M12 Scheduled: a media-only feed item falls back to the page description', async () => {
  const api = await fakeBotApi();
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-m12-sch-'));
  const cfg = parseConfig({ BOT_TOKEN: TOKEN, ADMIN_CHAT_ID: '1', RSSHUB_BASE });
  const db = openDb(join(dir, 'bot.db'));
  const http: Http = async (url) => {
    if (url === 'http://rsshub.test/tiktok/user/demo') return { status: 200, url, contentType: 'application/rss+xml', body: TIKTOK_FEED };
    if (url === 'https://tiktok.com/@demo/video/1') {
      return { status: 200, url, contentType: 'text/html', body: '<html><head><meta property="og:description" content="Video caption from the page"></head></html>' };
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const bot = createBot({ cfg, db, apiRoot: api.apiRoot, http, media: noMedia });
    await bot.init();
    const user = ensureUser(db, USER_ID);
    const chat = ensurePrivateChat(db, user.id, USER_ID);
    const source = upsertSource(db, {
      platform: 'tiktok',
      canonicalUrl: 'https://tiktok.com/@demo',
      externalId: 'demo',
      feedUrl: 'http://rsshub.test/tiktok/user/demo',
      strategy: 'rsshub',
      title: 'TikTok Demo',
      avatarUrl: null,
    });
    insertSubscription(db, { userId: user.id, sourceId: source.id, chatId: chat.id, deliver: true, nextSlotAt: null });

    const deps = { db, http, cfg, media: noMedia, thumbnail: async () => null, sender: new TelegramSender(bot.api), workerConcurrency: 1 };
    tick(db, Date.now());
    assert.equal(await runOnce(deps, Date.now()), true, 'the fetch job is claimed');

    const text = api.calls.filter((call) => call.method === 'sendRichMessage').map((call) => String(call.body.rich_message?.html ?? '')).join('\n');
    assert.match(text, /Video caption from the page/, 'the caption comes from the page, not the link only');
    assert.match(text, /<a href="https:\/\/tiktok\.com\/@demo\/video\/1">TikTok Demo<\/a> \| TikTok/);
  } finally {
    db.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
