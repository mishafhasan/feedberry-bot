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
import type { MediaEngine, MediaItem } from '../../src/media/media-engine.ts';
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
const FEED = 'https://www.youtube.com/feeds/videos.xml?channel_id=UCTEST000000000000000000';
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
    if (url.startsWith('https://www.youtube.com/oembed')) return { status: 200, url, contentType: 'application/json', body: JSON.stringify({ author_url: 'https://www.youtube.com/@TestChannel' }) };
    return { status: 200, url, contentType: 'text/html; charset=utf-8', body: '<html><head><meta property="og:title" content="A clip"></head><body></body></html>' };
  };
  const media = engine({ resolve: [] });

  try {
    allowUser(db, USER_ID);
    const bot = createBot({ cfg: config(), db, apiRoot: api.apiRoot, http, media });
    await bot.init();

    await bot.handleUpdate(startUpdate(1, USER_ID));
    await bot.handleUpdate(callbackUpdate(2, USER_ID, 'menu:download'));
    await bot.handleUpdate(textUpdate(3, USER_ID, 'https://youtube.com/shorts/ccIE0DwsH4I?si=RIOFlxJwTiwsKDf-'));

    const rich = api.calls.filter((call) => call.method === 'sendRichMessage' && /<video src="tg:\/\/video/.test(String(call.body.rich_message?.html ?? '')));
    assert.equal(rich.length, 1, 'the clip is delivered as one rich message');
    assert.match(String(rich[0]?.body.rich_message?.html ?? ''), /<video src="tg:\/\/video\?id=m0">/, 'the clip rides in the slideshow');
    const texts = api.calls.filter((call) => call.method === 'sendMessage').map((call) => String(call.body.text ?? ''));
    assert.ok(!texts.some((text) => /isn't a supported source/.test(text)), 'the link is never refused');
    assert.ok(seen.some((url) => url === 'https://youtube.com/shorts/ccIE0DwsH4I'), 'the page still names its words and date');

    // The result offers the channel behind the clip, which is the one-click path to monitoring it.
    const done = api.last('sendMessage');
    assert.match(String(done?.body.text), /Delivered/);
    assert.deepEqual(buttons(done), ['dl:more', 'add:post', 'nav:home'], 'the channel is offered as a source');
    assert.equal(done?.body.reply_markup?.inline_keyboard?.flat()[1]?.text, '➕ @TestChannel', 'the oEmbed card names the handle');
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

    // The picker is a rich message and replaces the Add Source screen: no extra message is sent.
    const picker = lastHtml(api);
    assert.match(picker, /What should @TestChannel send here\?/, 'the picker comes before any fetch');
    assert.deepEqual(seen, [], 'nothing is fetched until the user chooses');
    for (const kind of ['video', 'short', 'post']) assert.match(picker, new RegExp(`data="ct:t:${kind}"`), `${kind} is a chip on the screen`);
    assert.deepEqual(buttons(api.last('sendRichMessage')), ['ct:done', 'ct:back'], 'Done sits at the bottom, above Back');

    // Everything starts on: one tap turns Posts off, Done continues into stage 1.
    await bot.handleUpdate(callbackUpdate(4, USER_ID, 'ct:t:post'));
    const toggled = lastHtml(api);
    assert.doesNotMatch(toggled, /style="primary" data="ct:t:post"/, 'the toggle repaints in place, without the accent');
    assert.match(toggled, /Sends: Videos, Shorts/, 'the summary is the one place the state is spelled out');
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

test('youtube: a pasted Short offers its channel from the oEmbed card, before any heavy page fetch', async () => {
  const api = await fakeBotApi();
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-yt-chooser-'));
  const db = openDb(join(dir, 'bot.db'));
  const short = 'https://youtube.com/shorts/ccIE0DwsH4I';
  const http: Http = async (url) => {
    if (url.startsWith('https://www.youtube.com/oembed')) return { status: 200, url, contentType: 'application/json', body: JSON.stringify({ author_url: 'https://www.youtube.com/@TestChannel' }) };
    // The handle the card named, then the feed its page names (refused), then the RSSHub route.
    if (url === CHANNEL) return { status: 200, url, contentType: 'text/html; charset=utf-8', body: CHANNEL_PAGE };
    if (url === FEED) return { status: 404, url, contentType: 'text/html; charset=UTF-8', body: '<html>not found</html>' };
    if (url === POSTS) return { status: 200, url, contentType: 'text/html; charset=utf-8', body: POSTS_TAB };
    if (url === 'http://rsshub.test/youtube/channel/UCTEST000000000000000000') return { status: 200, url, contentType: 'application/atom+xml', body: ATOM };
    // A real watch page outlived the page budget (11 s here), so reaching it at all is the bug.
    throw new Error(`unexpected fetch: ${url}`);
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
    const picker = lastHtml(api);
    assert.match(picker, /What should @TestChannel send here\?/, 'the picker names the channel, not its UC id');
    assert.match(picker, /data="ct:all"/, 'the explicit All content preset is offered');

    await bot.handleUpdate(callbackUpdate(4, USER_ID, 'ct:t:post'));
    assert.doesNotMatch(lastHtml(api), /style="primary" data="ct:t:post"/, 'Posts is off in the chips');
    await bot.handleUpdate(callbackUpdate(5, USER_ID, 'ct:all'));
    assert.match(lastHtml(api), /style="primary" data="ct:t:post"/, 'All content puts every kind back');

    // And the add that follows survives YouTube refusing the native feed, like a channel-id link.
    await bot.handleUpdate(callbackUpdate(6, USER_ID, 'ct:done'));
    const texts = api.calls.filter((call) => call.method === 'sendMessage').map((call) => String(call.body.text ?? ''));
    assert.ok(!texts.some((text) => /Couldn't find a feed/.test(text)), 'a video link add is not refused either');
    assert.match(String(texts.at(-1)), /A long video/, 'the preview comes from the fallback feed');

    const chatId = personalChat(db, ensureUser(db, USER_ID).id).id;
    await bot.handleUpdate(callbackUpdate(7, USER_ID, `add:dest:${chatId}`));
    await bot.handleUpdate(callbackUpdate(8, USER_ID, 'add:save_silent'));
    const row = db.prepare("SELECT canonical_url FROM sources WHERE platform = 'youtube' ORDER BY id DESC LIMIT 1").get() as { canonical_url: string };
    assert.equal(row.canonical_url, CHANNEL, 'the channel the Short belongs to is what gets followed');
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

    assert.equal(result.fresh, 1, 'only the feed this chat asked for is fetched, so only its item is fresh');
    assert.equal(result.delivered, 1, 'the community post is sent');
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM posts').get() as { n: number }).n, 1, 'no uploads were recorded for a Posts-only chat');

    const rich = api.calls.find((call) => call.method === 'sendRichMessage');
    assert.ok(rich, 'the post ships its photo, not a bare link');
    const html = String(rich?.body.rich_message?.html ?? '');
    assert.match(html, /Community post words/);
    assert.equal(html.split('Community post words').length - 1, 1, 'the words are printed once, not as a title and a body');
    assert.match(html, /youtube\.com\/post\/UgkxCOMMUNITY_POST_1/, 'the permalink is one tap away');
  } finally {
    db.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('youtube: a Posts-only channel adds even when its uploads feed is gone', async () => {
  const api = await fakeBotApi();
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-yt-postsonly-'));
  const db = openDb(join(dir, 'bot.db'));
  const seen: string[] = [];
  const channel = 'https://youtube.com/@DeadFeed';
  const http: Http = async (url) => {
    seen.push(url);
    if (url === `${channel}/posts`) return { status: 200, url, contentType: 'text/html; charset=utf-8', body: POSTS_TAB };
    // This channel's uploads feed answers 404 for everyone; a Posts-only chat must not care.
    throw new Error(`a Posts-only add must not fetch the uploads feed: ${url}`);
  };

  try {
    allowUser(db, USER_ID);
    const bot = createBot({ cfg: config(), db, apiRoot: api.apiRoot, http, media: engine({ resolve: [] }) });
    await bot.init();

    await bot.handleUpdate(startUpdate(1, USER_ID));
    await bot.handleUpdate(callbackUpdate(2, USER_ID, 'menu:add'));
    await bot.handleUpdate(textUpdate(3, USER_ID, channel));
    await bot.handleUpdate(callbackUpdate(4, USER_ID, 'ct:t:video'));
    await bot.handleUpdate(callbackUpdate(5, USER_ID, 'ct:t:short'));
    assert.match(lastHtml(api), /Sends: Posts/, 'only Posts is left on');
    await bot.handleUpdate(callbackUpdate(6, USER_ID, 'ct:done'));

    const texts = api.calls.filter((call) => call.method === 'sendMessage').map((call) => String(call.body.text ?? ''));
    assert.ok(!texts.some((text) => /Couldn't find a feed/.test(text)), 'the Posts-only add is not refused');
    const preview = api.calls.filter((call) => call.method === 'sendMessage').at(-1);
    assert.match(String(preview?.body.text), /Community post words/, 'the post from the tab is the preview');
    assert.deepEqual(seen, [`${channel}/posts`], 'only the tab was fetched');

    const chatId = personalChat(db, ensureUser(db, USER_ID).id).id;
    await bot.handleUpdate(callbackUpdate(7, USER_ID, `add:dest:${chatId}`));
    await bot.handleUpdate(callbackUpdate(8, USER_ID, 'add:save_silent'));

    const row = db.prepare('SELECT content_types FROM subscriptions ORDER BY id DESC LIMIT 1').get() as { content_types: string | null };
    assert.equal(row.content_types, 'post', 'the channel is followed for its posts alone');
  } finally {
    db.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('youtube: a @handle channel adds while YouTube refuses the native feed', async () => {
  // The reported case: the channel page answers and names its feed, feeds/videos.xml answers 404 for
  // every channel from a busy IP, and only the RSSHub route (page scrape) still answers.
  const api = await fakeBotApi();
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-yt-handle-'));
  const db = openDb(join(dir, 'bot.db'));
  const handleChannel = 'https://youtube.com/@RjChandruReport';
  const fallback = 'http://rsshub.test/youtube/channel/UCTEST000000000000000000';
  const http: Http = async (url) => {
    if (url === handleChannel) return { status: 200, url, contentType: 'text/html; charset=utf-8', body: CHANNEL_PAGE };
    if (url === FEED) return { status: 404, url, contentType: 'text/html; charset=UTF-8', body: '<html>not found</html>' };
    if (url === fallback) return { status: 200, url, contentType: 'application/atom+xml', body: ATOM };
    if (url === `${handleChannel}/posts`) return { status: 200, url, contentType: 'text/html; charset=utf-8', body: POSTS_TAB };
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    allowUser(db, USER_ID);
    const bot = createBot({ cfg: config(), db, apiRoot: api.apiRoot, http, media: engine({ resolve: [] }) });
    await bot.init();

    await bot.handleUpdate(startUpdate(1, USER_ID));
    await bot.handleUpdate(callbackUpdate(2, USER_ID, 'menu:add'));
    await bot.handleUpdate(textUpdate(3, USER_ID, `${handleChannel}?si=fmMGu2lcGlCcdKMw`));
    await bot.handleUpdate(callbackUpdate(4, USER_ID, 'ct:done'));

    const texts = api.calls.filter((call) => call.method === 'sendMessage').map((call) => String(call.body.text ?? ''));
    assert.ok(!texts.some((text) => /Couldn't find a feed/.test(text)), 'the add is not refused');
    const preview = api.calls.filter((call) => call.method === 'sendMessage').at(-1);
    assert.match(String(preview?.body.text), /A long video/, 'the fallback feed supplies the uploads');
    assert.match(String(preview?.body.text), /Community post words/, 'and the Posts tab still merges');

    const chatId = personalChat(db, ensureUser(db, USER_ID).id).id;
    await bot.handleUpdate(callbackUpdate(5, USER_ID, `add:dest:${chatId}`));
    await bot.handleUpdate(callbackUpdate(6, USER_ID, 'add:save_silent'));

    const row = db.prepare("SELECT canonical_url, feed_url FROM sources WHERE platform = 'youtube' ORDER BY id DESC LIMIT 1").get() as { canonical_url: string; feed_url: string | null };
    assert.equal(row.canonical_url, handleChannel, 'the handle stays the identity, not the RSSHub route');
    assert.equal(row.feed_url, FEED, 'the feed its page named is stored, exactly as a /channel/UC… add does');
  } finally {
    db.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('youtube: a scheduled handle source stores the feed its page named, then stops reading the page', async () => {
  const api = await fakeBotApi();
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-yt-sched-'));
  const db = openDb(join(dir, 'bot.db'));
  const handleChannel = 'https://youtube.com/@RjChandruReport';
  const asked: string[] = [];
  const http: Http = async (url) => {
    asked.push(url);
    if (url === handleChannel) return { status: 200, url, contentType: 'text/html; charset=utf-8', body: CHANNEL_PAGE };
    if (url === FEED) return { status: 404, url, contentType: 'text/html; charset=UTF-8', body: '<html>not found</html>' };
    if (url === 'http://rsshub.test/youtube/channel/UCTEST000000000000000000') return { status: 200, url, contentType: 'application/atom+xml', body: ATOM };
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const cfg = config();
    const user = ensureUser(db, USER_ID);
    const chat = ensurePrivateChat(db, user.id, USER_ID);
    // A handle source as the add flow leaves it before any discovery: no feed URL yet.
    const source = upsertSource(db, { platform: 'youtube', canonicalUrl: handleChannel, externalId: 'RjChandruReport', feedUrl: null, strategy: 'native_rss', title: 'Rj Chandru Report', avatarUrl: null });
    insertSubscription(db, { userId: user.id, sourceId: source.id, chatId: chat.id, deliver: true, nextSlotAt: null, contentTypes: ['video'] });

    const bot = createBot({ cfg, db, apiRoot: api.apiRoot, http, media: engine({ resolve: [] }) });
    await bot.init();
    const deps = { db, http, cfg, media: engine({ resolve: [] }), thumbnail: async () => null, sender: new TelegramSender(bot.api) };
    const first = await runFetchSource(deps, source.id);

    assert.equal(first.fresh, 2, 'the fallback feed supplied the uploads');
    const stored = db.prepare('SELECT feed_url FROM sources WHERE id = ?').get(source.id) as { feed_url: string | null };
    assert.equal(stored.feed_url, FEED, 'the discovered feed is stored, exactly as a /channel/UC… add stores it');

    asked.length = 0;
    await runFetchSource(deps, source.id);
    assert.ok(!asked.includes(handleChannel), 'the next check goes straight to the feed, never the channel page');
    assert.deepEqual(asked, [FEED, 'http://rsshub.test/youtube/channel/UCTEST000000000000000000'], 'native first, then the id keyed route');
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
    const htmlOf = (call: { body: Record<string, any> }) => String(call.body.rich_message?.html ?? '');
    assert.ok(to(USER_ID).some((call) => call.method === 'sendRichMessage' && /<img src="tg:\/\/photo/.test(htmlOf(call))), 'the post reaches the chat that asked for posts');
    assert.ok(!to(USER_ID).some((call) => call.method === 'sendRichMessage' && /<video src="tg:\/\/video/.test(htmlOf(call))), 'and no video follows it');
    assert.ok(to(1001).some((call) => call.method === 'sendRichMessage' && /<video src="tg:\/\/video/.test(htmlOf(call))), 'the video reaches the chat that asked for videos');
    assert.ok(!to(1001).some((call) => call.method === 'sendRichMessage' && /<img src="tg:\/\/photo/.test(htmlOf(call))), 'and no post follows it');
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
    assert.match(lastHtml(api), /What should Test Channel send here\?/, 'the card opens the picker for its own channel');

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
