/**
 * YouTube is three kinds of content behind one link family. These tests pin the two things that
 * were wrong: a video or a Short downloads instead of being read as a community post, and a channel
 * sends only the kinds the chat picked.
 */
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { test } from 'node:test';
import { createBot } from '../../src/bot/index.ts';
import { parseConfig } from '../../src/config.ts';
import { openDb } from '../../src/db/index.ts';
import { ensurePrivateChat, personalChat, upsertChat } from '../../src/db/repos/chats.ts';
import { upsertSource } from '../../src/db/repos/sources.ts';
import { insertSubscription } from '../../src/db/repos/subscriptions.ts';
import { ensureUser } from '../../src/db/repos/users.ts';
import type { MediaEngine, MediaItem } from '../../src/media/cobalt.ts';
import type { Http } from '../../src/platform/http.ts';
import { runFetchSource } from '../../src/pipeline/run.ts';
import { TelegramSender } from '../../src/telegram/api.ts';
import { callbackUpdate, fakeBotApi, startUpdate, textUpdate, type Call } from '../fake-api.ts';
import { allowUser } from '../seed.ts';

const TOKEN = '123456:AAHfakeTokenForTestsOnly_1234567890abc';
const USER_ID = 555;
const VIDEO = fileURLToPath(new URL('../fixtures/media/video.mp4', import.meta.url));
const PHOTO = fileURLToPath(new URL('../fixtures/media/photo.jpg', import.meta.url));
const CHANNEL = 'https://youtube.com/@TestChannel';
const FEED = 'https://www.youtube.com/feeds/videos.xml?channel_id=UCTEST0000000000000000';
const POSTS = `${CHANNEL}/posts`;

/** The channel page carries its own RSS link; stage 2 discovers it exactly as it does in production. */
const CHANNEL_PAGE = `<html><head><link rel="alternate" type="application/rss+xml" title="RSS" href="${FEED}"></head><body></body></html>`;

const ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:yt="http://www.youtube.com/xml/schemas/2015">
  <title>Test Channel</title>
  <entry>
    <id>yt:video:VID00000001</id><yt:videoId>VID00000001</yt:videoId>
    <title>A long video</title>
    <link rel="alternate" href="https://www.youtube.com/watch?v=VID00000001"/>
    <published>2026-11-01T10:00:00+00:00</published>
  </entry>
  <entry>
    <id>yt:video:SHORT000001</id><yt:videoId>SHORT000001</yt:videoId>
    <title>A Short</title>
    <link rel="alternate" href="https://www.youtube.com/shorts/SHORT000001"/>
    <published>2026-11-02T10:00:00+00:00</published>
  </entry>
</feed>`;

/** One community post with a photo, in the shape the channel Posts tab renders. */
const POSTS_TAB = `<script>var ytInitialData = ${JSON.stringify({
  contents: {
    sectionListRenderer: {
      contents: [
        {
          backstagePostRenderer: {
            postId: 'UgkxCOMMUNITY_POST_1',
            contentText: { runs: [{ text: 'Community post words' }] },
            publishedTimeText: { runs: [{ text: '4 hours ago' }] },
            backstageAttachment: {
              backstageImageRenderer: { image: { thumbnails: [{ url: 'https://yt3.ggpht.com/post=s1600', width: 800, height: 800 }] } },
            },
          },
        },
      ],
    },
  },
})};</script>`;

const engine = (calls: { resolve: string[] }): MediaEngine => ({
  async resolve(url: string) {
    calls.resolve.push(url);
    // cobalt resolves a video URL; a community post has no extractor, which is the real behaviour.
    if (url.includes('/shorts/') || url.includes('/watch')) return { items: [{ kind: 'video', url: 'https://cdn.test/v.mp4', picker: false }], title: 'A clip', artist: 'Test Channel' };
    return { items: [], title: null, artist: null };
  },
  async download(item: MediaItem, dir: string) {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${Date.now()}-${Math.random()}.${item.kind === 'video' ? 'mp4' : 'jpg'}`);
    copyFileSync(item.kind === 'video' ? VIDEO : PHOTO, path);
    return path;
  },
});

const config = (): ReturnType<typeof parseConfig> =>
  parseConfig({ BOT_TOKEN: TOKEN, ADMIN_CHAT_ID: '1', RSSHUB_BASE: 'http://rsshub.test', CALLBACK_INTERVAL_MS: '0', ADD_INTERVAL_MS: '0', MAX_DOWNLOADS_PER_DAY: '5' });

const buttons = (call: Call | undefined): string[] =>
  (call?.body.reply_markup?.inline_keyboard ?? []).flat().map((button: { data?: string; callback_data?: string; text: string }) => button.data ?? button.callback_data ?? button.text);

/** A rich message travels as `rich_message.html`; the list is the last one the bot painted. */
const lastHtml = (api: { calls: Call[] }): string =>
  api.calls
    .filter((call) => typeof call.body.rich_message?.html === 'string')
    .map((call) => String(call.body.rich_message.html))
    .at(-1) ?? '';

test('youtube: a Shorts link downloads through cobalt instead of failing as an unsupported source', async () => {
  const api = await fakeBotApi();
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-yt-short-'));
  const db = openDb(join(dir, 'bot.db'));
  const seen: string[] = [];
  const http: Http = async (url) => {
    seen.push(url);
    // Only the post permalink is a page adapter; asking for it here is the bug this test pins.
    if (url.includes('/post/')) throw new Error(`a Short must never be read as a community post: ${url}`);
    // A real watch/Shorts page names its channel in the player state.
    return {
      status: 200,
      url,
      contentType: 'text/html; charset=utf-8',
      body: '<html><head><meta property="og:title" content="A clip"></head><body><script>{"channelId":"UCTEST000000000000000000","canonicalBaseUrl":"/@TestChannel/shorts"}</script></body></html>',
    };
  };
  const media = engine({ resolve: [] });

  try {
    allowUser(db, USER_ID);
    const bot = createBot({ cfg: config(), db, apiRoot: api.apiRoot, http, media });
    await bot.init();

    await bot.handleUpdate(startUpdate(1, USER_ID));
    await bot.handleUpdate(callbackUpdate(2, USER_ID, 'menu:download'));
    await bot.handleUpdate(textUpdate(3, USER_ID, 'https://youtube.com/shorts/ccIE0DwsH4I?si=RIOFlxJwTiwsKDf-'));

    assert.equal(api.calls.filter((call) => call.method === 'sendVideo').length, 1, 'the clip is delivered');
    const texts = api.calls.filter((call) => call.method === 'sendMessage').map((call) => String(call.body.text ?? ''));
    assert.ok(!texts.some((text) => /isn't a supported source/.test(text)), 'the link is never refused');
    assert.ok(seen.some((url) => url === 'https://youtube.com/shorts/ccIE0DwsH4I'), 'the page still names its words and date');

    // The result offers the channel behind the clip, which is the one-click path to monitoring it.
    const done = api.last('sendMessage');
    assert.match(String(done?.body.text), /Delivered/);
    assert.deepEqual(buttons(done), ['dl:more', 'add:post', 'nav:home'], 'the channel is offered as a source');
    assert.equal(done?.body.reply_markup?.inline_keyboard?.flat()[1]?.text, '➕ @TestChannel', 'the handle loses the tab it was read from');
  } finally {
    db.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('youtube: adding a channel asks what to send, and only the chosen kinds are recorded', async () => {
  const api = await fakeBotApi();
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-yt-add-'));
  const db = openDb(join(dir, 'bot.db'));
  const seen: string[] = [];
  const http: Http = async (url) => {
    seen.push(url);
    if (url === CHANNEL) return { status: 200, url, contentType: 'text/html; charset=utf-8', body: CHANNEL_PAGE };
    if (url === FEED) return { status: 200, url, contentType: 'application/atom+xml', body: ATOM };
    throw new Error(`unexpected fetch ${url}`);
  };
  const media = engine({ resolve: [] });

  try {
    allowUser(db, USER_ID);
    const bot = createBot({ cfg: config(), db, apiRoot: api.apiRoot, http, media });
    await bot.init();

    await bot.handleUpdate(startUpdate(1, USER_ID));
    await bot.handleUpdate(callbackUpdate(2, USER_ID, 'menu:add'));
    await bot.handleUpdate(textUpdate(3, USER_ID, 'https://www.youtube.com/@TestChannel'));

    const picker = api.last('sendMessage');
    assert.match(String(picker?.body.text), /What should @TestChannel send here\?/, 'the picker comes before any fetch');
    assert.deepEqual(seen, [], 'nothing is fetched until the user chooses');
    assert.ok(buttons(picker).includes('ct:t:video') && buttons(picker).includes('ct:t:short') && buttons(picker).includes('ct:t:post'));
    assert.ok(buttons(picker).includes('ct:done'));

    // Everything starts on: one tap turns Posts off, Done continues into stage 1.
    await bot.handleUpdate(callbackUpdate(4, USER_ID, 'ct:t:post'));
    assert.match(String(api.last('editMessageText')?.body.text), /▫️ Posts/, 'the toggle repaints the same message in place');
    await bot.handleUpdate(callbackUpdate(5, USER_ID, 'ct:done'));

    const preview = api.calls.filter((call) => call.method === 'sendMessage').at(-1);
    const lines = String(preview?.body.text ?? '').split('\n').filter((line) => line.startsWith('• '));
    assert.equal(lines.length, 2, 'the preview shows the video and the Short, and no post');
    assert.ok(buttons(preview).some((data) => data.startsWith('add:dest:')), 'the destination step still follows');

    const chatId = personalChat(db, ensureUser(db, USER_ID).id).id;
    await bot.handleUpdate(callbackUpdate(6, USER_ID, `add:dest:${chatId}`));
    await bot.handleUpdate(callbackUpdate(7, USER_ID, 'add:save_silent'));

    const row = db.prepare('SELECT content_types FROM subscriptions ORDER BY id DESC LIMIT 1').get() as { content_types: string | null };
    assert.equal(row.content_types, 'video,short', 'the choice reaches the subscription, not the shared source row');
  } finally {
    db.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('youtube: a pasted Short offers its channel first, and the picker has an All content preset', async () => {
  const api = await fakeBotApi();
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-yt-chooser-'));
  const db = openDb(join(dir, 'bot.db'));
  const short = 'https://youtube.com/shorts/ccIE0DwsH4I';
  const http: Http = async (url) => {
    // The watch/Shorts page is the only place such a link states its channel.
    if (url === short) {
      return { status: 200, url, contentType: 'text/html; charset=utf-8', body: '<html><body><script>{"channelId":"UCTEST000000000000000000","canonicalBaseUrl":"/@TestChannel/shorts"}</script></body></html>' };
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    allowUser(db, USER_ID);
    const bot = createBot({ cfg: config(), db, apiRoot: api.apiRoot, http, media: engine({ resolve: [] }) });
    await bot.init();

    await bot.handleUpdate(startUpdate(1, USER_ID));
    await bot.handleUpdate(textUpdate(2, USER_ID, `${short}?si=RIOFlxJwTiwsKDf-`));

    const chooser = api.last('sendMessage');
    assert.match(String(chooser?.body.text), /post link/);
    assert.deepEqual(buttons(chooser), ['dl:post', 'add:post', 'nav:home'], 'monitoring the channel is offered next to the download');

    await bot.handleUpdate(callbackUpdate(3, USER_ID, 'add:post'));
    const picker = api.last('editMessageText');
    assert.match(String(picker?.body.text), /What should @TestChannel send here\?/, 'the picker names the channel, not its UC id');
    assert.ok(buttons(picker).includes('ct:all'), 'the explicit All content preset is offered');

    await bot.handleUpdate(callbackUpdate(4, USER_ID, 'ct:t:post'));
    assert.match(String(api.last('editMessageText')?.body.text), /▫️ Posts/);
    await bot.handleUpdate(callbackUpdate(5, USER_ID, 'ct:all'));
    assert.match(String(api.last('editMessageText')?.body.text), /✅ Posts/, 'All content puts every kind back');
  } finally {
    db.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('youtube: a posts-only chat receives the community post and none of the uploads', async () => {
  const api = await fakeBotApi();
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-yt-posts-'));
  const db = openDb(join(dir, 'bot.db'));
  const http: Http = async (url) => {
    if (url === FEED) return { status: 200, url, contentType: 'application/atom+xml', body: ATOM };
    if (url === POSTS) return { status: 200, url, contentType: 'text/html; charset=utf-8', body: POSTS_TAB };
    throw new Error(`unexpected fetch ${url}`);
  };
  const media = engine({ resolve: [] });

  try {
    const cfg = config();
    const user = ensureUser(db, USER_ID);
    const chat = ensurePrivateChat(db, user.id, USER_ID);
    const source = upsertSource(db, { platform: 'youtube', canonicalUrl: CHANNEL, externalId: 'TestChannel', feedUrl: FEED, strategy: 'native_rss', title: 'Test Channel', avatarUrl: null });
    insertSubscription(db, { userId: user.id, sourceId: source.id, chatId: chat.id, deliver: true, nextSlotAt: null, contentTypes: ['post'] });

    const bot = createBot({ cfg, db, apiRoot: api.apiRoot, http, media });
    await bot.init();
    const result = await runFetchSource({ db, http, cfg, media, thumbnail: async () => null, sender: new TelegramSender(bot.api) }, source.id);

    assert.equal(result.fresh, 3, 'every item is recorded as seen, including the ones this chat did not pick');
    assert.equal(result.delivered, 1, 'only the community post is sent');
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM posts').get() as { n: number }).n, 3);

    const photo = api.calls.find((call) => call.method === 'sendPhoto');
    assert.ok(photo, 'the post ships its photo, not a bare link');
    assert.match(String(photo?.body.caption), /Community post words/);
    assert.match(String(photo?.body.caption), /youtube\.com\/post\/UgkxCOMMUNITY_POST_1/, 'the permalink is one tap away');
  } finally {
    db.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('youtube: two chats on one channel each receive only the kinds they picked', async () => {
  const api = await fakeBotApi();
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-yt-split-'));
  const db = openDb(join(dir, 'bot.db'));
  const http: Http = async (url) => {
    if (url === FEED) return { status: 200, url, contentType: 'application/atom+xml', body: ATOM };
    if (url === POSTS) return { status: 200, url, contentType: 'text/html; charset=utf-8', body: POSTS_TAB };
    throw new Error(`unexpected fetch ${url}`);
  };
  const media = engine({ resolve: [] });

  try {
    const cfg = config();
    const user = ensureUser(db, USER_ID);
    const personal = ensurePrivateChat(db, user.id, USER_ID);
    const channel = upsertChat(db, {
      ownerUserId: user.id,
      tgChatId: 1001,
      type: 'channel',
      title: 'Videos only',
      messageThreadId: null,
      canPost: true,
      verifiedAt: Date.now(),
      rightsJson: '{}',
    });
    const source = upsertSource(db, { platform: 'youtube', canonicalUrl: CHANNEL, externalId: 'TestChannel', feedUrl: FEED, strategy: 'native_rss', title: 'Test Channel', avatarUrl: null });
    // One row per (source, chat): the source is shared, the choice is not.
    insertSubscription(db, { userId: user.id, sourceId: source.id, chatId: personal.id, deliver: true, nextSlotAt: null, contentTypes: ['post'] });
    insertSubscription(db, { userId: user.id, sourceId: source.id, chatId: channel.id, deliver: true, nextSlotAt: null, contentTypes: ['video'] });

    const bot = createBot({ cfg, db, apiRoot: api.apiRoot, http, media });
    await bot.init();
    const result = await runFetchSource({ db, http, cfg, media, thumbnail: async () => null, sender: new TelegramSender(bot.api) }, source.id);

    assert.equal(result.fresh, 3, 'the whole feed is recorded once, for the shared source');
    assert.equal(result.delivered, 2, 'one message per chat, not one per kind');

    const to = (chatId: number) => api.calls.filter((call) => Number(call.body.chat_id) === chatId);
    assert.ok(to(USER_ID).some((call) => call.method === 'sendPhoto'), 'the post reaches the chat that asked for posts');
    assert.ok(!to(USER_ID).some((call) => call.method === 'sendVideo'), 'and no video follows it');
    assert.ok(to(1001).some((call) => call.method === 'sendVideo'), 'the video reaches the chat that asked for videos');
    assert.ok(!to(1001).some((call) => call.method === 'sendPhoto'), 'and no post follows it');
  } finally {
    db.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('youtube: the My Sources card changes the kinds without touching another chat', async () => {
  const api = await fakeBotApi();
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-yt-edit-'));
  const db = openDb(join(dir, 'bot.db'));
  const http: Http = async (url) => {
    throw new Error(`no fetch expected while editing, got ${url}`);
  };

  try {
    const cfg = config();
    allowUser(db, USER_ID);
    const user = ensureUser(db, USER_ID);
    const chat = ensurePrivateChat(db, user.id, USER_ID);
    const other = upsertChat(db, { ownerUserId: user.id, tgChatId: 1001, type: 'channel', title: 'Other chat', messageThreadId: null, canPost: true, verifiedAt: Date.now(), rightsJson: '{}' });
    const source = upsertSource(db, { platform: 'youtube', canonicalUrl: CHANNEL, externalId: 'TestChannel', feedUrl: FEED, strategy: 'native_rss', title: 'Test Channel', avatarUrl: null });
    const subscription = insertSubscription(db, { userId: user.id, sourceId: source.id, chatId: chat.id, deliver: true, nextSlotAt: null, contentTypes: ['video', 'short'] });
    // The same channel, followed from a second chat with its own choice.
    const sibling = insertSubscription(db, { userId: user.id, sourceId: source.id, chatId: other.id, deliver: true, nextSlotAt: null, contentTypes: ['short'] });

    const bot = createBot({ cfg, db, apiRoot: api.apiRoot, http, media: engine({ resolve: [] }) });
    await bot.init();

    await bot.handleUpdate(startUpdate(1, USER_ID));
    await bot.handleUpdate(callbackUpdate(2, USER_ID, 'menu:sources'));
    const list = lastHtml(api);
    assert.match(list, /ct:open:\d+/, 'a YouTube card carries its types button');
    assert.match(list, /receiving: Videos, Shorts/);

    await bot.handleUpdate(callbackUpdate(3, USER_ID, `ct:open:${subscription?.id}`));
    assert.match(String(api.last('sendMessage')?.body.text), /What should Test Channel send here\?/, 'the card opens the picker for its own channel');

    await bot.handleUpdate(callbackUpdate(4, USER_ID, 'ct:t:post'));
    await bot.handleUpdate(callbackUpdate(5, USER_ID, 'ct:done'));

    const row = db.prepare('SELECT content_types FROM subscriptions WHERE id = ?').get(subscription?.id ?? 0) as { content_types: string | null };
    assert.equal(row.content_types, 'video,short,post');
    const untouched = db.prepare('SELECT content_types FROM subscriptions WHERE id = ?').get(sibling?.id ?? 0) as { content_types: string | null };
    assert.equal(untouched.content_types, 'short', 'the other chat on the same channel keeps its own choice');
    assert.match(lastHtml(api), /receiving: Videos, Shorts, Posts/, 'the list shows the new choice');
  } finally {
    db.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
