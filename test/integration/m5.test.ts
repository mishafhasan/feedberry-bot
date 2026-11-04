/**
 * M5 verification (IMPLEMENTATION_PLAN §4 M5): photo, album of 3, album of 11, a 1025-char
 * caption and a video — all through a fixture-backed media engine, never the network.
 * The 1 msg/s floor of §9.1 makes this test take a few seconds by design.
 */
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { test } from 'node:test';
import { createBot } from '../../src/bot/index.ts';
import type { TelegraphPage } from '../../src/article/telegraph.ts';
import { parseConfig } from '../../src/config.ts';
import { openDb } from '../../src/db/index.ts';
import { ensurePrivateChat } from '../../src/db/repos/chats.ts';
import { markPendingDelivery } from '../../src/db/repos/deliveries.ts';
import { insertPosts } from '../../src/db/repos/posts.ts';
import { upsertSource } from '../../src/db/repos/sources.ts';
import { insertSubscription } from '../../src/db/repos/subscriptions.ts';
import { ensureUser } from '../../src/db/repos/users.ts';
import type { MediaEngine, MediaItem } from '../../src/media/cobalt.ts';
import type { Http } from '../../src/platform/http.ts';
import { deliverPending } from '../../src/pipeline/run.ts';
import { TelegramSender } from '../../src/telegram/api.ts';
import { callbackUpdate, fakeBotApi, startUpdate, textUpdate } from '../fake-api.ts';
import { allowUser } from '../seed.ts';

const TOKEN = '123456:AAHfakeTokenForTestsOnly_1234567890abc';
const USER_ID = 555;
const PHOTO = fileURLToPath(new URL('../fixtures/media/photo.jpg', import.meta.url));
const VIDEO = fileURLToPath(new URL('../fixtures/media/video.mp4', import.meta.url));

const photo = (): MediaItem => ({ kind: 'photo', url: 'https://cdn.test/p.jpg', picker: true });
const video = (): MediaItem => ({ kind: 'video', url: 'https://cdn.test/v.mp4', picker: false });

/** URL → media list; anything else is a text post. */
const MEDIA: Record<string, MediaItem[]> = {
  'https://blog.example.test/photo': [photo()],
  'https://blog.example.test/album3': [photo(), photo(), photo()],
  'https://blog.example.test/album11': Array.from({ length: 11 }, photo),
  'https://blog.example.test/caption': [photo()],
  'https://blog.example.test/video': [video()],
  'https://instagram.com/p/C1': [photo()],
  'https://instagram.com/p/LONG': [photo()],
};

const engine: MediaEngine = {
  async resolve(url) {
    // A /LONG/ link stands for an Instagram post whose caption is past the 1024-char limit.
    const long = url.includes('LONG');
    return { items: MEDIA[url] ?? [], title: long ? LONG : 'Cobalt post', artist: long ? 'meyer' : null };
  },
  async download(item, dir) {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${Date.now()}-${Math.random()}.${item.kind === 'video' ? 'mp4' : 'jpg'}`);
    copyFileSync(item.kind === 'video' ? VIDEO : PHOTO, path);
    return path;
  },
};

const http: Http = async (url) => {
  throw new Error(`no feed fetch expected in M5, got ${url}`);
};

const LONG = `${'word '.repeat(205)}`.trim(); // 1025 characters

test('M5: photo, album 3, album 11, split caption, video', async () => {
  const api = await fakeBotApi();
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-m5-'));
  const cfg = parseConfig({ BOT_TOKEN: TOKEN, ADMIN_CHAT_ID: '1', RSSHUB_BASE: 'http://rsshub.test', CALLBACK_INTERVAL_MS: '0', ADD_INTERVAL_MS: '0' });
  const db = openDb(join(dir, 'bot.db'));

  try {
    const user = ensureUser(db, USER_ID);
    const chat = ensurePrivateChat(db, user.id, USER_ID);
    const source = upsertSource(db, {
      platform: 'rss',
      canonicalUrl: 'https://blog.example.test',
      externalId: 'blog',
      feedUrl: 'https://blog.example.test/rss',
      strategy: 'native_rss',
      title: 'Blog',
      avatarUrl: null,
    });
    insertSubscription(db, { userId: user.id, sourceId: source.id, chatId: chat.id, deliver: true, nextSlotAt: null });

    const posts = [
      { guid: 'p-photo', link: 'https://blog.example.test/photo', title: 'One photo', summary: null },
      { guid: 'p-a3', link: 'https://blog.example.test/album3', title: 'Three photos', summary: null },
      { guid: 'p-a11', link: 'https://blog.example.test/album11', title: 'Eleven photos', summary: null },
      { guid: 'p-long', link: 'https://blog.example.test/caption', title: 'Long caption', summary: LONG },
      { guid: 'p-video', link: 'https://blog.example.test/video', title: 'A video', summary: null },
    ].map((raw) => ({ ...raw, publishedAt: Date.parse('2025-10-24T10:00:00Z'), media: [] }));

    for (const entry of insertPosts(db, source.id, posts)) markPendingDelivery(db, entry.id, chat.id);

    const bot = createBot({ cfg, db, apiRoot: api.apiRoot, http, media: engine });
    await bot.init();
    const result = await deliverPending({ db, http, cfg, media: engine, thumbnail: async () => null, sender: new TelegramSender(bot.api) }, source.id);

    assert.equal(result.delivered, 5, 'all five posts delivered');
    assert.equal(result.failed, 0);

    const calls = api.calls;
    const photos = calls.filter((c) => c.method === 'sendPhoto');
    const groups = calls.filter((c) => c.method === 'sendMediaGroup');
    const videos = calls.filter((c) => c.method === 'sendVideo');

    assert.equal(photos.length, 2, 'single photo + the long-caption photo');
    assert.equal(videos.length, 1, 'the video goes out as sendVideo (R9, size ≤ 50 MB)');

    // album of 3 → one group of 3; album of 11 → 10 + 1 (R3/R4)
    assert.equal(groups.length, 3, 'one group for the 3-album, two for the 11-album');
    const groupSizes = groups.map((call) => (call.body.media as unknown[]).length).sort((a, b) => a - b);
    assert.deepEqual(groupSizes, [1, 3, 10], 'the 11-item album is chunked 10 + 1, never 11');

    // B1: the header rides on the media caption, and on the first item of an album.
    assert.match(String(photos[0]?.body.caption ?? ''), /🌐 <a href="[^"]+">Blog<\/a>/);
    const three = groups.find((call) => (call.body.media as unknown[]).length === 3);
    const albumCaption = String((three?.body.media as Array<{ caption?: string }>)[0]?.caption ?? '');
    assert.match(albumCaption, /⏱️ Time: \d{2}\/\d{2} \d{2}:\d{2}/, 'the album carries one caption, on its first item');

    // §8.2: without a Telegraph client this is the fallback — a 1025-character caption splits into
    // two numbered parts, the second as a reply. With one, the Read-more test below runs instead.
    const long = photos.find((call) => /\(1\/2\)$/.test(String(call.body.caption)));
    assert.ok(long, 'the first caption part ends with (1/2)');
    const continuation = calls.filter((c) => c.method === 'sendMessage').at(-1);
    assert.match(String(continuation?.body.text), /\(2\/2\)$/);
    assert.ok(continuation?.body.reply_parameters, 'parts 2..n are a reply chain');

    const sent = db.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE status = 'sent'").get() as { n: number };
    assert.equal(sent.n, 5);
  } finally {
    db.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('M5 read more: an over-long caption keeps the photo and links the rest to an Instant View page', async () => {
  const api = await fakeBotApi();
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-m5-more-'));
  const cfg = parseConfig({ BOT_TOKEN: TOKEN, ADMIN_CHAT_ID: '1', RSSHUB_BASE: 'http://rsshub.test', CALLBACK_INTERVAL_MS: '0', ADD_INTERVAL_MS: '0' });
  const db = openDb(join(dir, 'bot.db'));

  try {
    const user = ensureUser(db, USER_ID);
    const chat = ensurePrivateChat(db, user.id, USER_ID);
    const source = upsertSource(db, {
      platform: 'rss',
      canonicalUrl: 'https://blog.example.test',
      externalId: 'blog',
      feedUrl: 'https://blog.example.test/rss',
      strategy: 'native_rss',
      title: 'Blog',
      avatarUrl: null,
    });
    insertSubscription(db, { userId: user.id, sourceId: source.id, chatId: chat.id, deliver: true, nextSlotAt: null });

    const posts = insertPosts(db, source.id, [
      {
        guid: 'p-read-more',
        link: 'https://blog.example.test/caption',
        title: 'Long caption',
        summary: LONG,
        publishedAt: Date.parse('2025-10-24T10:00:00Z'),
        media: [{ url: 'https://cdn.test/one.jpg', type: 'photo' as const }],
      },
    ]);
    for (const entry of posts) markPendingDelivery(db, entry.id, chat.id);

    const pages: TelegraphPage[] = [];
    const telegraph = {
      async createPage(page: TelegraphPage): Promise<string> {
        pages.push(page);
        return `https://telegra.ph/page-${pages.length}`;
      },
    };
    const bot = createBot({ cfg, db, apiRoot: api.apiRoot, http, media: engine });
    await bot.init();
    const result = await deliverPending({ db, http, cfg, media: engine, thumbnail: async () => null, sender: new TelegramSender(bot.api), telegraph }, source.id);

    assert.equal(result.delivered, 1);
    const photoCall = api.calls.find((call) => call.method === 'sendPhoto');
    const caption = String(photoCall?.body.caption ?? '');
    assert.match(caption, /<a href="https:\/\/telegra\.ph\/page-1">👉🏻 Read more<\/a>$/, 'the caption ends in the Instant View link');
    assert.ok(caption.length <= 1024, `caption is ${caption.length} characters`);
    assert.ok(!api.calls.some((call) => call.method === 'sendMessage'), 'no (2/2) continuation is sent');
    assert.equal(pages.length, 1, 'one page, published once');
    assert.match(pages[0]?.content ?? '', /cdn\.test\/one\.jpg/, 'the post photo rides along');
  } finally {
    db.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('M5 download mode: post link delivers media with post_id NULL, profile link and quota are refused', async () => {
  const api = await fakeBotApi();
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-dl-'));
  const cfg = parseConfig({ BOT_TOKEN: TOKEN, ADMIN_CHAT_ID: '1', RSSHUB_BASE: 'http://rsshub.test', CALLBACK_INTERVAL_MS: '0', ADD_INTERVAL_MS: '0', MAX_DOWNLOADS_PER_DAY: '1' });
  const db = openDb(join(dir, 'bot.db'));
  allowUser(db, USER_ID);
  let updateId = 10;

  try {
    const bot = createBot({ cfg, db, apiRoot: api.apiRoot, http, media: engine });
    await bot.init();

    await bot.handleUpdate(startUpdate(1, USER_ID));
    await bot.handleUpdate(callbackUpdate(updateId++, USER_ID, 'menu:download'));
    assert.match(api.last('sendMessage')?.body.text ?? '', /Send a post link/);

    // A profile is not a post: one notice, and no Retry that would only fail again.
    await bot.handleUpdate(textUpdate(updateId++, USER_ID, 'https://www.instagram.com/cristiano/'));
    assert.match(api.last('sendMessage')?.body.text ?? '', /Send a post link, not a profile\./);
    const noticeButtons = (api.last('sendMessage')?.body.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> }).inline_keyboard.flat();
    assert.ok(!noticeButtons.some((button) => button.callback_data === 'err:retry'), 'no Retry that would fail again');

    // Download mode stays ready: the next post link goes through stages 1 and 3-7.
    await bot.handleUpdate(textUpdate(updateId++, USER_ID, 'https://www.instagram.com/p/C1/'));
    const methods = api.calls.map((c) => c.method).join(',');
    assert.ok(api.calls.some((c) => c.method === 'sendPhoto'), `the media is sent to the same chat (saw ${methods})`);

    const row = db.prepare('SELECT post_id, status FROM deliveries ORDER BY id DESC LIMIT 1').get() as { post_id: number | null; status: string };
    assert.equal(row.post_id, null, 'Download mode has no posts row');
    assert.equal(row.status, 'sent');

    // Second download in the same day trips MAX_DOWNLOADS_PER_DAY.
    await bot.handleUpdate(callbackUpdate(updateId++, USER_ID, 'menu:download'));
    await bot.handleUpdate(textUpdate(updateId++, USER_ID, 'https://www.instagram.com/p/C1/'));
    assert.match(api.last('sendMessage')?.body.text ?? '', /reached 1 downloads today/);
  } finally {
    db.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('M5 download mode: a long caption arrives as one photo with a Read more link', async () => {
  const api = await fakeBotApi();
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-dl-more-'));
  const cfg = parseConfig({ BOT_TOKEN: TOKEN, ADMIN_CHAT_ID: '1', RSSHUB_BASE: 'http://rsshub.test', CALLBACK_INTERVAL_MS: '0', ADD_INTERVAL_MS: '0', MAX_DOWNLOADS_PER_DAY: '5' });
  const db = openDb(join(dir, 'bot.db'));
  allowUser(db, USER_ID);
  const pages: TelegraphPage[] = [];
  const telegraph = {
    async createPage(page: TelegraphPage): Promise<string> {
      pages.push(page);
      return `https://telegra.ph/dl-${pages.length}`;
    },
  };

  try {
    const bot = createBot({ cfg, db, apiRoot: api.apiRoot, http, media: engine, telegraph });
    await bot.init();

    await bot.handleUpdate(startUpdate(1, USER_ID));
    await bot.handleUpdate(textUpdate(2, USER_ID, 'https://www.instagram.com/p/LONG/'));
    await bot.handleUpdate(callbackUpdate(3, USER_ID, 'dl:post'));

    const caption = String(api.calls.find((call) => call.method === 'sendPhoto')?.body.caption ?? '');
    assert.match(caption, /<a href="https:\/\/telegra\.ph\/dl-1">👉🏻 Read more<\/a>$/, 'the caption ends in the Instant View link');
    assert.ok(caption.length <= 1024, `caption is ${caption.length} characters`);
    assert.ok(!api.calls.some((call) => /\(2\/2\)$/.test(String(call.body.text ?? ''))), 'the rest is not sent as a second message');
    assert.equal(pages.length, 1, 'one page for the download');
    assert.match(pages[0]?.content ?? '', /word word/, 'the page carries the whole caption');
    assert.match(pages[0]?.content ?? '', /cdn\.test\/p\.jpg/, 'and the downloaded photo');
  } finally {
    db.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
