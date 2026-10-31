/**
 * The 8-item UX pass, in one place: menus and language, Instant View for blogs, one album per
 * post, no duplicate delivery, the source+time header, and the post-link chooser.
 */
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createBot } from '../../src/bot/index.ts';
import { parseConfig } from '../../src/config.ts';
import { openDb } from '../../src/db/index.ts';
import { ensurePrivateChat } from '../../src/db/repos/chats.ts';
import { markPendingDelivery } from '../../src/db/repos/deliveries.ts';
import { insertPosts } from '../../src/db/repos/posts.ts';
import { getSource, upsertSource } from '../../src/db/repos/sources.ts';
import { insertSubscription } from '../../src/db/repos/subscriptions.ts';
import { ensureUser } from '../../src/db/repos/users.ts';
import type { MediaEngine, MediaItem } from '../../src/media/cobalt.ts';
import type { Http } from '../../src/platform/http.ts';
import { deliverPending, runFetchSource } from '../../src/pipeline/run.ts';
import { TelegramSender } from '../../src/telegram/api.ts';
import { callbackUpdate, commandUpdate, fakeBotApi, startUpdate, textUpdate } from '../fake-api.ts';

const TOKEN = '123456:AAHfakeTokenForTestsOnly_1234567890abc';
const USER_ID = 555;
const PHOTO = fileURLToPath(new URL('../fixtures/media/photo.jpg', import.meta.url));
const VIDEO = fileURLToPath(new URL('../fixtures/media/video.mp4', import.meta.url));
const ARTICLE = fileURLToPath(new URL('../fixtures/wired.html', import.meta.url));

const photo = (): MediaItem => ({ kind: 'photo', url: 'https://cdn.test/p.jpg', picker: true });
const video = (): MediaItem => ({ kind: 'video', url: 'https://cdn.test/v.mp4', picker: false });

const MEDIA: Record<string, MediaItem[]> = {
  'https://blog.example.test/mixed': [photo(), video()],
  'https://blog.example.test/plain': [photo()],
};

const engine: MediaEngine = {
  async resolve(url) {
    return { items: MEDIA[url] ?? [], title: 'Cobalt post' };
  },
  async download(item, dir) {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${Date.now()}-${Math.random()}.${item.kind === 'video' ? 'mp4' : 'jpg'}`);
    copyFileSync(item.kind === 'video' ? VIDEO : PHOTO, path);
    return path;
  },
};

/** A website returns an article page; everything else fails so the media path runs. */
const http: Http = async (url) => {
  if (url === 'https://blog.example.test/article') {
    return { status: 200, url, contentType: 'text/html', body: await readFile(ARTICLE, 'utf8') };
  }
  throw new Error(`unexpected fetch ${url}`);
};

const cfgFor = (extra: Record<string, string> = {}) =>
  parseConfig({ BOT_TOKEN: TOKEN, ADMIN_CHAT_ID: '1', RSSHUB_BASE: 'http://rsshub.test', CALLBACK_INTERVAL_MS: '0', ADD_INTERVAL_MS: '0', ...extra });

function seedSource(db: ReturnType<typeof openDb>, platform: string, canonicalUrl: string, title: string) {
  const user = ensureUser(db, USER_ID);
  const chat = ensurePrivateChat(db, user.id, USER_ID);
  const source = upsertSource(db, {
    platform,
    canonicalUrl,
    externalId: 'blog',
    feedUrl: 'https://blog.example.test/rss',
    strategy: 'native_rss',
    title,
    avatarUrl: null,
  });
  insertSubscription(db, { userId: user.id, sourceId: source.id, chatId: chat.id, deliver: true, nextSlotAt: null });
  return { user, chat, source };
}

test('M10 menu: five buttons, /supported_sites and /language answer, language is stored and used', async () => {
  const api = await fakeBotApi();
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-m10-menu-'));
  const db = openDb(join(dir, 'bot.db'));

  try {
    const bot = createBot({ cfg: cfgFor(), db, apiRoot: api.apiRoot, http, media: engine });
    await bot.init();

    await bot.handleUpdate(startUpdate(1, USER_ID));
    const s1 = api.last('sendMessage');
    const rows = (s1?.body.reply_markup as { inline_keyboard: unknown[][] } | undefined)?.inline_keyboard ?? [];
    assert.equal(rows.length, 3, 'three rows: two pairs then the full-width Download Mode');
    assert.equal(rows.flat().length, 5, 'five buttons');

    await bot.handleUpdate(commandUpdate(2, USER_ID, 'supported_sites'));
    assert.match(String(api.last('sendMessage')?.body.text), /Supported sites/);

    await bot.handleUpdate(commandUpdate(3, USER_ID, 'language'));
    assert.match(String(api.last('sendMessage')?.body.text), /language/);

    await bot.handleUpdate(commandUpdate(4, USER_ID, 'about'));
    assert.match(String(api.last('sendMessage')?.body.text), /Your ID: 555/);

    await bot.handleUpdate(commandUpdate(5, USER_ID, 'download'));
    assert.match(String(api.last('sendMessage')?.body.text), /Send a post link/);

    await bot.handleUpdate(commandUpdate(6, USER_ID, 'my_sources'));
    assert.match(String(api.last('sendMessage')?.body.text), /Source list · Private messages/);

    // Switching to Russian stores the locale and repaints S1 in Russian.
    await bot.handleUpdate(callbackUpdate(7, USER_ID, 'lang:ru'));
    assert.equal(ensureUser(db, USER_ID).locale, 'ru');
    assert.match(String(api.last('editMessageText')?.body.text), /Источники:/);
    assert.match(String(api.last('editMessageText')?.body.text), /Ваш ID/);

    // A fresh bot on the same file still speaks Russian: the locale lives in the database.
    const restarted = createBot({ cfg: cfgFor(), db, apiRoot: api.apiRoot, http, media: engine });
    await restarted.init();
    await restarted.handleUpdate(startUpdate(8, USER_ID));
    assert.match(String(api.last('sendMessage')?.body.text), /Источники: 0 \/ 250/, 'the language survives a restart');
  } finally {
    db.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('M10 delivery: a website becomes Instant View, media keeps one album, and every post carries the header', async () => {
  const api = await fakeBotApi();
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-m10-deliver-'));
  const db = openDb(join(dir, 'bot.db'));

  try {
    const { chat, source } = seedSource(db, 'rss', 'https://blog.example.test/article', 'My Blog');
    const posts = insertPosts(db, source.id, [
      { guid: 'a-1', link: 'https://blog.example.test/article', title: 'A long read', summary: null, publishedAt: Date.parse('2026-10-25T09:30:00Z'), media: [] },
      { guid: 'm-1', link: 'https://blog.example.test/mixed', title: 'Photo and video', summary: 'Both kinds', publishedAt: Date.parse('2026-10-25T09:31:00Z'), media: [] },
      { guid: 'p-1', link: 'https://blog.example.test/plain', title: 'One photo', summary: null, publishedAt: Date.parse('2026-10-25T09:32:00Z'), media: [] },
    ]);
    for (const post of posts) markPendingDelivery(db, post.id, chat.id);

    const telegraph = { pages: 0, async createPage() { this.pages++; return 'https://telegra.ph/My-Blog-10-25'; } };
    const bot = createBot({ cfg: cfgFor(), db, apiRoot: api.apiRoot, http, media: engine });
    await bot.init();
    const result = await deliverPending(
      { db, http, cfg: cfgFor(), media: engine, thumbnail: async () => null, sender: new TelegramSender(bot.api), telegraph },
      source.id,
    );

    assert.equal(result.delivered, 3, `all three posts delivered (failed ${result.failed})`);
    assert.equal(telegraph.pages, 1, 'the article was published once');

    const methods = api.calls.map((call) => call.method);
    const articleMessage = api.calls.find((call) => call.method === 'sendMessage' && String(call.body.text).includes('telegra.ph'));
    assert.ok(articleMessage, 'the website post arrives as an Instant View link');
    assert.equal(api.calls.filter((call) => call.method === 'sendPhoto').length, 1, 'only the plain post is a photo; the article is not');

    const groups = api.calls.filter((call) => call.method === 'sendMediaGroup');
    assert.equal(groups.length, 1, 'photo+video is one album, not two messages');
    assert.equal((groups[0]?.body.media as unknown[]).length, 2, 'both items share the group');

    const bodies = [
      ...api.calls.filter((call) => call.method === 'sendMessage').map((call) => String(call.body.text)),
      ...api.calls.filter((call) => call.method === 'sendPhoto').map((call) => String(call.body.caption)),
      ...groups.map((call) => String((call.body.media as Array<{ caption?: string }>)[0]?.caption ?? '')),
    ].join('\n');
    assert.match(bodies, /🌐 /, 'every post opens with the source name');
    assert.match(bodies, /⏱️ Time: /, 'and the publish time');
    assert.ok(methods.includes('sendMediaGroup'));
  } finally {
    db.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('M10 dedupe: a new guid with the same link is not delivered twice', async () => {
  const api = await fakeBotApi();
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-m10-dedupe-'));
  const db = openDb(join(dir, 'bot.db'));

  try {
    const { source } = seedSource(db, 'rss', 'https://blog.example.test/rss', 'My Blog');
    const links = (guid: string, link: string) => `<item><title>Post</title><link>${link}</link><guid>${guid}</guid><pubDate>Sat, 25 Oct 2026 10:00:00 GMT</pubDate><description>Body</description></item>`;
    let feed = `<?xml version="1.0"?><rss version="2.0"><channel><title>My Blog</title>${links('g-1', 'https://blog.example.test/post?utm_source=rss')}</channel></rss>`;
    const fetchFeedOnly: Http = async (url) => {
      if (!url.includes('/rss')) throw new Error(`unexpected fetch ${url}`);
      return { status: 200, url, contentType: 'application/rss+xml', body: feed };
    };
    const depsBot = createBot({ cfg: cfgFor(), db, apiRoot: api.apiRoot, http: fetchFeedOnly, media: engine });
    await depsBot.init();
    const deps = { db, http: fetchFeedOnly, cfg: cfgFor(), media: engine, thumbnail: async () => null, sender: new TelegramSender(depsBot.api) };

    await runFetchSource(deps, source.id);
    const afterFirst = api.calls.filter((call) => call.method === 'sendMessage').length;
    assert.equal(afterFirst, 1, 'the first fetch delivers once');

    // Same post, regenerated guid and a different tracking parameter.
    feed = `<?xml version="1.0"?><rss version="2.0"><channel><title>My Blog</title>${links('g-2', 'https://www.blog.example.test/post/?fbclid=abc')}</channel></rss>`;
    await runFetchSource(deps, source.id);
    assert.equal(api.calls.filter((call) => call.method === 'sendMessage').length, afterFirst, 'the second fetch delivers nothing');
    assert.ok(getSource(db, source.id));
  } finally {
    db.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('M10 free text: a profile link goes straight to the source preview', async () => {
  const api = await fakeBotApi();
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-m10-profile-'));
  const db = openDb(join(dir, 'bot.db'));
  const feed = `<?xml version="1.0"?><rss version="2.0"><channel><title>Cristiano</title>
    <item><title>Latest post</title><link>https://instagram.com/p/1</link><guid>i-1</guid>
    <pubDate>Sat, 25 Oct 2026 10:00:00 GMT</pubDate><description>Body</description></item>
  </channel></rss>`;
  const httpProfile: Http = async (url) => {
    if (!url.includes('/instagram/user/cristiano')) throw new Error(`unexpected fetch ${url}`);
    return { status: 200, url, contentType: 'application/rss+xml', body: feed };
  };

  try {
    const bot = createBot({ cfg: cfgFor(), db, apiRoot: api.apiRoot, http: httpProfile, media: engine });
    await bot.init();

    await bot.handleUpdate(startUpdate(1, USER_ID));
    await bot.handleUpdate(textUpdate(2, USER_ID, 'https://www.instagram.com/cristiano/'));

    const preview = api.last('sendMessage');
    assert.match(String(preview?.body.text), /Latest post/, 'the profile preview lists the latest post');
    const buttons = (preview?.body.reply_markup as { inline_keyboard: Array<Array<{ callback_data?: string }>> }).inline_keyboard.flat();
    assert.ok(
      buttons.some((button) => String(button.callback_data ?? '').startsWith('add:dest:')),
      'and offers the destinations, so Add to My Sources is one tap away',
    );
  } finally {
    db.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('M10 free text: an unusable link is a one-line notice with Help, not a Retry screen', async () => {
  const api = await fakeBotApi();
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-m10-notice-'));
  const db = openDb(join(dir, 'bot.db'));

  try {
    const bot = createBot({ cfg: cfgFor(), db, apiRoot: api.apiRoot, http, media: engine });
    await bot.init();

    await bot.handleUpdate(startUpdate(1, USER_ID));
    await bot.handleUpdate(textUpdate(2, USER_ID, 'https://x.com/elonmusk'));

    const notice = api.last('sendMessage');
    assert.match(String(notice?.body.text), /login/, 'the reason is stated in one line');
    const buttons = (notice?.body.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> }).inline_keyboard.flat();
    assert.ok(buttons.some((button) => button.callback_data === 'menu:help'), 'Help is offered');
    assert.ok(!buttons.some((button) => button.callback_data === 'err:retry'), 'no Retry that would fail again');
  } finally {
    db.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('M10 download: a post link pasted in idle offers the choice, and a success offers another', async () => {
  const api = await fakeBotApi();
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-m10-dl-'));
  const db = openDb(join(dir, 'bot.db'));

  try {
    const bot = createBot({ cfg: cfgFor(), db, apiRoot: api.apiRoot, http, media: engine });
    await bot.init();

    await bot.handleUpdate(startUpdate(1, USER_ID));
    // A post link outside any flow: the chooser, with Download always offered.
    await bot.handleUpdate(textUpdate(2, USER_ID, 'https://www.instagram.com/p/C1/'));
    const chooser = api.last('sendMessage');
    assert.match(String(chooser?.body.text), /post link/);
    const buttons = ((chooser?.body.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> }).inline_keyboard).flat();
    assert.ok(buttons.some((button) => button.callback_data === 'dl:post'), 'the chooser offers the download');

    await bot.handleUpdate(callbackUpdate(3, USER_ID, 'dl:post'));
    assert.match(String(api.last('sendMessage')?.body.text), /Delivered/, 'a finished download says so');
    const resultButtons = ((api.last('sendMessage')?.body.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> }).inline_keyboard).flat();
    assert.ok(resultButtons.some((button) => button.callback_data === 'dl:more'), 'and offers the next one');
  } finally {
    db.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
