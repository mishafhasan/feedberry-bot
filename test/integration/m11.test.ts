/**
 * The second UX pass: the custom reply keyboard, a blog link working in Download Mode, the
 * post-link chooser for a website, and the stricter duplicate check.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createBot } from '../../src/bot/index.ts';
import { parseConfig } from '../../src/config.ts';
import { openDb } from '../../src/db/index.ts';
import { ensurePrivateChat } from '../../src/db/repos/chats.ts';
import { insertPosts } from '../../src/db/repos/posts.ts';
import { upsertSource } from '../../src/db/repos/sources.ts';
import { insertSubscription } from '../../src/db/repos/subscriptions.ts';
import { ensureUser } from '../../src/db/repos/users.ts';
import type { MediaEngine } from '../../src/media/cobalt.ts';
import type { Http } from '../../src/platform/http.ts';
import { unseenItems } from '../../src/pipeline/s4-dedupe.ts';
import { runFetchSource } from '../../src/pipeline/run.ts';
import { TelegramSender } from '../../src/telegram/api.ts';
import { commandUpdate, fakeBotApi, startUpdate, textUpdate } from '../fake-api.ts';
import { allowUser } from '../seed.ts';

const TOKEN = '123456:AAHfakeTokenForTestsOnly_1234567890abc';
const USER_ID = 555;
const WIRED = fileURLToPath(new URL('../fixtures/wired.html', import.meta.url));

const engine: MediaEngine = {
  async resolve() {
    return { items: [], title: 'Cobalt title', artist: null };
  },
  async download() {
    throw new Error('no download expected');
  },
};

const cfgFor = () =>
  parseConfig({ BOT_TOKEN: TOKEN, ADMIN_CHAT_ID: '1', RSSHUB_BASE: 'http://rsshub.test', CALLBACK_INTERVAL_MS: '0', ADD_INTERVAL_MS: '0' });

/** Any http(s) page returns the readable article fixture, with the publish date a real site declares. */
const articleHttp: Http = async (url) => {
  const html = await readFile(WIRED, 'utf8');
  const meta = '<meta property="article:published_time" content="2026-10-30T12:00:00Z">';
  const body = html.includes('</head>') ? html.replace('</head>', `${meta}</head>`) : `${meta}${html}`;
  return { status: 200, url, contentType: 'text/html', body };
};

const telegraph = (): { pages: string[]; createPage: () => Promise<string> } => ({
  pages: [],
  async createPage() {
    const url = `https://telegra.ph/Test-page-${this.pages.length + 1}`;
    this.pages.push(url);
    return url;
  },
});

function buttonData(call: { body: Record<string, any> } | undefined): string[] {
  const markup = call?.body.reply_markup as { inline_keyboard?: Array<Array<{ callback_data?: string }>>; keyboard?: unknown } | undefined;
  return (markup?.inline_keyboard ?? []).flat().map((button) => String(button.callback_data ?? ''));
}

test('reply keyboard: /start shows the custom keyboard and its labels act like the buttons', async () => {
  const api = await fakeBotApi();
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-m11-menu-'));
  const db = openDb(join(dir, 'bot.db'));
  allowUser(db, USER_ID);

  try {
    const bot = createBot({ cfg: cfgFor(), db, apiRoot: api.apiRoot, http: articleHttp, media: engine });
    await bot.init();

    await bot.handleUpdate(startUpdate(1, USER_ID));
    const withKeyboard = api.calls.find((call) => (call.body.reply_markup as { keyboard?: unknown } | undefined)?.keyboard !== undefined);
    assert.ok(withKeyboard, 'a ReplyKeyboardMarkup is sent, so the menu sits under the message box');
    const rows = (withKeyboard?.body.reply_markup as { keyboard: Array<Array<{ text: string }>> }).keyboard;
    const labels = rows.flat().map((button) => button.text);
    assert.ok(labels.includes('➕ Add Source'), 'the menu carries the same actions as S1');
    assert.ok(!labels.includes('✖️ Hide menu'), 'no dedicated hide row: Telegram\'s keyboard icon in the input area is the toggle');
    assert.ok(!(withKeyboard?.body.reply_markup as { is_persistent?: boolean }).is_persistent, 'a non-persistent keyboard is the one Telegram lets the user fold and reopen');

    // A tapped label is an action: it opens the add flow instead of being parsed as a link.
    await bot.handleUpdate(textUpdate(2, USER_ID, '➕ Add Source'));
    assert.match(String(api.last('sendMessage')?.body.text), /Adding a source/);

    // A chat still showing the old keyboard heals on the stale row: it gets the new foldable menu, never remove_keyboard.
    await bot.handleUpdate(textUpdate(3, USER_ID, '✖️ Hide menu'));
    const healed = api.last('sendMessage')?.body.reply_markup as { keyboard?: unknown; is_persistent?: boolean } | undefined;
    assert.ok(healed?.keyboard, 'the stale label installs the current menu');
    assert.ok(!healed?.is_persistent, 'and the menu it installs still carries the input-area toggle');
  } finally {
    db.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('download mode: a blog post is accepted and delivered as Instant View', async () => {
  const api = await fakeBotApi();
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-m11-blog-'));
  const db = openDb(join(dir, 'bot.db'));
  allowUser(db, USER_ID);
  const client = telegraph();

  try {
    const bot = createBot({ cfg: cfgFor(), db, apiRoot: api.apiRoot, http: articleHttp, media: engine, telegraph: client });
    await bot.init();

    await bot.handleUpdate(startUpdate(1, USER_ID));
    // Exactly the reported flow: Download Mode, then a blog post link.
    await bot.handleUpdate(commandUpdate(2, USER_ID, 'download'));
    await bot.handleUpdate(textUpdate(3, USER_ID, 'https://blog.example.test/story/a-quiet-return'));
    assert.equal(client.pages.length, 1, 'the page was published to Telegra.ph');
    const payload = api.calls.find((call) => call.method === 'sendMessage' && String(call.body.text).includes('telegra.ph'));
    assert.ok(payload, 'the article went out with its Instant View link');
    assert.match(String(payload?.body.text), /🌐 <a href="[^"]*blog\.example\.test[^"]*">WIRED<\/a> \| RSS/, 'the page names itself, not the host');
    assert.match(String(payload?.body.text), /⏱️ Time: 10\/30 12:00/, 'and the page\'s own publication time');
    assert.equal((payload?.body.link_preview_options as { url?: string } | undefined)?.url, 'https://telegra.ph/Test-page-1', 'the preview opens the Instant View copy');
    assert.match(String(payload?.body.text), /<b><a href="https:\/\/telegra\.ph\/Test-page-1">[^<]+<\/a><\/b>/, 'the headline itself carries the Instant View link');
    assert.doesNotMatch(String(payload?.body.text), /\n\nhttps:\/\/telegra\.ph\//, 'no bare Instant View URL left at the end');
    assert.doesNotMatch(String(api.last('sendMessage')?.body.text), /Send a post link, not a profile/, 'a blog link is a post link');
  } finally {
    db.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('a website link pasted in idle offers both download and subscribe', async () => {
  const api = await fakeBotApi();
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-m11-choose-'));
  const db = openDb(join(dir, 'bot.db'));
  allowUser(db, USER_ID);

  try {
    const bot = createBot({ cfg: cfgFor(), db, apiRoot: api.apiRoot, http: articleHttp, media: engine, telegraph: telegraph() });
    await bot.init();

    await bot.handleUpdate(startUpdate(1, USER_ID));
    await bot.handleUpdate(textUpdate(2, USER_ID, 'https://blog.example.test/story/a-quiet-return'));

    const chooser = api.last('sendMessage');
    assert.match(String(chooser?.body.text), /post link/);
    const actions = buttonData(chooser);
    assert.ok(actions.includes('dl:post'), 'download it once');
    assert.ok(actions.includes('add:post'), 'or follow the site, because the URL names it');
  } finally {
    db.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('a long post body reaches Telegram whole, not cut at 400 characters', async () => {
  const api = await fakeBotApi();
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-m11-body-'));
  const db = openDb(join(dir, 'bot.db'));
  const marker = 'END-OF-THE-POST-BODY';
  const body = `${'sentence '.repeat(150)}${marker}`;
  const feed = `<?xml version="1.0"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>Blog</title>
    <item><title>Long read</title><link>https://blog.example.test/long</link><guid>l-1</guid>
    <description>Short teaser</description>
    <content:encoded><![CDATA[${body}]]></content:encoded>
    <pubDate>Sat, 25 Oct 2026 10:00:00Z</pubDate></item></channel></rss>`;
  const httpFeed: Http = async (url) => ({ status: 200, url, contentType: 'application/rss+xml', body: feed });

  try {
    const user = ensureUser(db, USER_ID);
    const chat = ensurePrivateChat(db, user.id, USER_ID);
    const source = upsertSource(db, {
      // A social source: no article extraction, so the feed body is what the reader sees.
      platform: 'instagram',
      canonicalUrl: 'https://instagram.com/longreads',
      externalId: 'longreads',
      feedUrl: 'http://rsshub.test/instagram/user/longreads',
      strategy: 'rsshub',
      title: 'Long Reads',
      avatarUrl: null,
    });
    insertSubscription(db, { userId: user.id, sourceId: source.id, chatId: chat.id, deliver: true, nextSlotAt: Date.now() - 1000 });

    const bot = createBot({ cfg: cfgFor(), db, apiRoot: api.apiRoot, http: httpFeed, media: engine, telegraph: telegraph() });
    await bot.init();
    await runFetchSource({ db, http: httpFeed, cfg: cfgFor(), media: engine, thumbnail: async () => null, sender: new TelegramSender(bot.api) }, source.id);

    const sent = [...api.calls.filter((call) => call.method === 'sendMessage').map((call) => String(call.body.text)), ...api.calls.filter((call) => call.method === 'sendPhoto').map((call) => String(call.body.caption))].join('\n');
    assert.ok(sent.includes(marker), `the whole body arrived, not the 400-character preview (saw ${sent.slice(0, 120)}…)`);
  } finally {
    db.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('dedupe: a republished item with a new guid, new link and same title stays unseen', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-m11-dedupe-'));
  const db = openDb(join(dir, 'bot.db'));

  try {
    const source = upsertSource(db, {
      platform: 'instagram',
      canonicalUrl: 'https://instagram.com/someone',
      externalId: 'someone',
      feedUrl: 'http://rsshub.test/instagram/user/someone',
      strategy: 'rsshub',
      title: 'Someone',
      avatarUrl: null,
    });

    const publishedAt = Date.parse('2026-10-30T12:00:00Z');
    insertPosts(db, source.id, [{ guid: 'ig-1', link: 'https://instagram.com/p/AAA', title: 'Same shot', summary: null, publishedAt, media: [] }]);

    // RSSHub regenerated both identifiers for the same post.
    const again = [{ guid: 'ig-1-cache-2', link: 'https://instagram.com/p/AAA/?utm_source=feed', title: 'Same shot', summary: null, publishedAt, media: [] }];
    assert.equal(unseenItems(db, source.id, again as never).length, 0, 'the fingerprint catches it');

    // A genuinely new post still passes.
    const fresh = [{ guid: 'ig-2', link: 'https://instagram.com/p/BBB', title: 'Another shot', summary: null, publishedAt: publishedAt + 1000, media: [] }];
    assert.equal(unseenItems(db, source.id, fresh as never).length, 1);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
