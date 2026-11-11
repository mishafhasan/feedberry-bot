/**
 * M17: one classifier, three screens. The same link is a post or a source wherever it is pasted,
 * and a screen that cannot use it names the link it wants instead of a Retry that would fail again.
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
import { ensurePrivateChat } from '../../src/db/repos/chats.ts';
import { upsertSource } from '../../src/db/repos/sources.ts';
import { insertSubscription } from '../../src/db/repos/subscriptions.ts';
import { ensureUser } from '../../src/db/repos/users.ts';
import type { MediaEngine } from '../../src/media/media-engine.ts';
import type { Http } from '../../src/platform/http.ts';
import { callbackUpdate, fakeBotApi, startUpdate, textUpdate, type Call } from '../fake-api.ts';
import { allowUser } from '../seed.ts';

const TOKEN = '123456:AAHfakeTokenForTestsOnly_1234567890abc';
const USER_ID = 555;
const PHOTO = fileURLToPath(new URL('../fixtures/media/photo.jpg', import.meta.url));

const cfgFor = () =>
  parseConfig({ BOT_TOKEN: TOKEN, ADMIN_CHAT_ID: '1', RSSHUB_BASE: 'http://rsshub.test', CALLBACK_INTERVAL_MS: '0', ADD_INTERVAL_MS: '0', MAX_DOWNLOADS_PER_DAY: '5' });

const FEED = `<?xml version="1.0"?><rss version="2.0"><channel><title>Zuck</title>
    <item><title>Latest post</title><link>https://threads.com/@zuck/post/1</link><guid>t-1</guid>
    <pubDate>Sat, 25 Oct 2026 10:00:00 GMT</pubDate><description>Body</description></item>
  </channel></rss>`;

/** Every feed route answers with the same feed; anything else is a flow bug. */
const fetched: string[] = [];
const OEMBED = /^https:\/\/www\.pinterest\.com\/oembed\.json\?url=/;
const http: Http = async (url) => {
  fetched.push(url);
  // Pinterest names a pin's owner only in its oEmbed card.
  if (OEMBED.test(url)) return { status: 200, url, contentType: 'application/json', body: JSON.stringify({ author_url: 'https://www.pinterest.com/sabrinaeasminn/' }) };
  // A Tumblr post's source is its blog's own feed; everything else is an RSSHub route.
  if (url !== 'https://mariacallous.tumblr.com/rss' && !url.startsWith('http://rsshub.test/')) throw new Error(`unexpected fetch ${url}`);
  return { status: 200, url, contentType: 'application/rss+xml', body: FEED };
};

/** A /C1/ or /reel/ link stands for a post the engine can name the account of. */
const engine: MediaEngine = {
  async resolve(url) {
    return { items: [{ kind: 'photo', url: 'https://cdn.test/p.jpg', picker: true }], title: 'Cobalt post', artist: /C1|reel/i.test(url) ? 'cristiano' : null };
  },
  async download(item, dir) {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${Date.now()}.jpg`);
    copyFileSync(PHOTO, path);
    return path;
  },
};

const buttons = (call: Call | undefined): string[] =>
  ((call?.body.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> } | undefined)?.inline_keyboard ?? []).flat().map((button) => button.callback_data);

test('M17: one IG post link is a post in every screen', async () => {
  const api = await fakeBotApi();
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-classify-post-'));
  const db = openDb(join(dir, 'bot.db'));
  allowUser(db, USER_ID);
  let updateId = 1;

  try {
    const bot = createBot({ cfg: cfgFor(), db, apiRoot: api.apiRoot, http, media: engine });
    await bot.init();
    await bot.handleUpdate(startUpdate(updateId++, USER_ID));

    // Free text: the chooser. A bare /p/ link names no account, but the extractor does.
    await bot.handleUpdate(textUpdate(updateId++, USER_ID, 'https://www.instagram.com/p/C1/'));
    const chooser = api.last('sendMessage');
    assert.match(String(chooser?.body.text), /post link/);
    assert.ok(buttons(chooser).includes('dl:post'), 'the download is offered');
    assert.ok(buttons(chooser).includes('add:post'), 'and the account the extractor names');

    // Add Source: the same link is a post, so it gets the notice instead of a failing preview.
    await bot.handleUpdate(callbackUpdate(updateId++, USER_ID, 'menu:add'));
    await bot.handleUpdate(textUpdate(updateId++, USER_ID, 'https://www.instagram.com/p/C1/'));
    const addNotice = api.last('sendMessage');
    assert.match(String(addNotice?.body.text), /Send a source link, not a post\./);
    assert.ok(!buttons(addNotice).includes('err:retry'), 'no Retry that would fail again');

    // Download Mode: the same link downloads, and the success offers the account and the next one.
    await bot.handleUpdate(callbackUpdate(updateId++, USER_ID, 'menu:download'));
    await bot.handleUpdate(textUpdate(updateId++, USER_ID, 'https://www.instagram.com/p/C1/'));
    assert.ok(api.calls.some((call) => call.method === 'sendRichMessage'), 'the media arrives');
    const done = api.last('sendMessage');
    assert.match(String(done?.body.text), /Delivered/);
    assert.ok(buttons(done).includes('add:post'), 'the account the engine named is offered as a source');
    assert.ok(buttons(done).includes('dl:more'), 'and the next download is offered');
  } finally {
    db.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('M17: a followed profile is "already a source", and a profile is never a download', async () => {
  const api = await fakeBotApi();
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-classify-source-'));
  const db = openDb(join(dir, 'bot.db'));
  allowUser(db, USER_ID);

  const user = ensureUser(db, USER_ID);
  const chat = ensurePrivateChat(db, user.id, USER_ID);
  const source = upsertSource(db, {
    platform: 'instagram',
    canonicalUrl: 'https://instagram.com/cristiano',
    externalId: 'cristiano',
    feedUrl: 'http://rsshub.test/instagram/user/cristiano',
    strategy: 'rsshub',
    title: 'Cristiano',
    avatarUrl: null,
  });
  insertSubscription(db, { userId: user.id, sourceId: source.id, chatId: chat.id, deliver: true, nextSlotAt: null });
  let updateId = 1;

  try {
    const bot = createBot({ cfg: cfgFor(), db, apiRoot: api.apiRoot, http, media: engine });
    await bot.init();
    await bot.handleUpdate(startUpdate(updateId++, USER_ID));

    // Free text: a source already in the list is recognised before any fetch.
    await bot.handleUpdate(textUpdate(updateId++, USER_ID, 'https://www.instagram.com/cristiano/'));
    const already = api.last('sendMessage');
    assert.match(String(already?.body.text), /already in your sources/);
    assert.ok(buttons(already).includes('menu:sources'), 'the list is one tap away');

    // Download Mode: a profile is not a post — one notice, no Retry that would fail again.
    await bot.handleUpdate(callbackUpdate(updateId++, USER_ID, 'menu:download'));
    await bot.handleUpdate(textUpdate(updateId++, USER_ID, 'https://www.instagram.com/cristiano/'));
    const notice = api.last('sendMessage');
    assert.match(String(notice?.body.text), /Send a post link, not a profile\./);
    assert.ok(!buttons(notice).includes('err:retry'), 'no Retry that would fail again');

    // The screen is still Download Mode: the next post link downloads.
    await bot.handleUpdate(textUpdate(updateId++, USER_ID, 'https://www.instagram.com/p/C1/'));
    assert.ok(api.calls.some((call) => call.method === 'sendRichMessage'), 'a post link still downloads');
  } finally {
    db.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('M17: a Tumblr or Facebook post link offers the account behind it, and adding it works', async () => {
  const api = await fakeBotApi();
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-classify-owner-'));
  const db = openDb(join(dir, 'bot.db'));
  allowUser(db, USER_ID);
  fetched.length = 0;

  try {
    const bot = createBot({ cfg: cfgFor(), db, apiRoot: api.apiRoot, http, media: engine });
    await bot.init();
    await bot.handleUpdate(startUpdate(1, USER_ID));

    // Tumblr: tumblr.com/<blog>/<id> names the blog, so the post leads to its source.
    await bot.handleUpdate(textUpdate(2, USER_ID, 'https://www.tumblr.com/mariacallous/832322209601224704?source=share'));
    assert.ok(buttons(api.last('sendMessage')).includes('add:post'), 'the blog behind the post is offered');
    await bot.handleUpdate(callbackUpdate(3, USER_ID, 'add:post'));
    assert.match(String(api.last('sendMessage')?.body.text), /Latest post/, 'the blog feed is previewed');
    assert.ok(fetched.includes('https://mariacallous.tumblr.com/rss'), 'through the blog’s own feed');

    // A Facebook photo names no page, but the album it was opened from does: set=pb.<pageId>.
    await bot.handleUpdate(callbackUpdate(4, USER_ID, 'nav:home'));
    await bot.handleUpdate(textUpdate(5, USER_ID, 'https://web.facebook.com/photo/?fbid=1270547115300126&set=pb.100070345475708.-2207520000'));
    assert.ok(buttons(api.last('sendMessage')).includes('add:post'), 'the page that posted the photo is offered');
    await bot.handleUpdate(callbackUpdate(6, USER_ID, 'add:post'));
    assert.match(String(api.last('sendMessage')?.body.text), /Latest post/, 'the page feed is previewed');
    assert.ok(fetched.includes('http://rsshub.test/facebook/page/100070345475708'), 'on the RSSHub page route that answers');

    // A /posts/<pfbid> permalink is the post, not its page: the chooser offers both actions.
    await bot.handleUpdate(callbackUpdate(7, USER_ID, 'nav:home'));
    await bot.handleUpdate(textUpdate(8, USER_ID, 'https://www.facebook.com/TrollMafia01/posts/pfbid02aYgKUGgf31rSVh7rAEb6gq9xopg3SUo6w2FTJVPowk69mQJUwt13s8dg1gLfJTQ9l'));
    const permalink = api.last('sendMessage');
    assert.ok(buttons(permalink).includes('dl:post'), 'the post can be downloaded');
    assert.ok(buttons(permalink).includes('add:post'), 'the page behind it is offered');
    await bot.handleUpdate(callbackUpdate(9, USER_ID, 'add:post'));
    assert.ok(fetched.includes('http://rsshub.test/facebook/page/TrollMafia01'), 'the page feed the link names');
  } finally {
    db.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('M17 download: the result offers Download more, Add source, Back — adding the link’s own source', async () => {
  const api = await fakeBotApi();
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-classify-done-'));
  const db = openDb(join(dir, 'bot.db'));
  allowUser(db, USER_ID);
  fetched.length = 0;

  try {
    const bot = createBot({ cfg: cfgFor(), db, apiRoot: api.apiRoot, http, media: engine });
    await bot.init();
    await bot.handleUpdate(startUpdate(1, USER_ID));
    await bot.handleUpdate(callbackUpdate(2, USER_ID, 'menu:download'));
    // The download names no account, but the link does: instagram.com/<user>/p/<code>.
    await bot.handleUpdate(textUpdate(3, USER_ID, 'https://www.instagram.com/zuck/p/XYZ/'));

    const done = api.last('sendMessage');
    assert.match(String(done?.body.text), /Delivered/);
    const rows = ((done?.body.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> }).inline_keyboard).map((row) => row.map((button) => button.callback_data));
    assert.deepEqual(rows, [['dl:more', 'add:post'], ['nav:home']], 'download more and add source side by side, Back alone');
    assert.match(JSON.stringify(done?.body.reply_markup), /Add source/, 'the plain label, since the download named no account');

    await bot.handleUpdate(callbackUpdate(4, USER_ID, 'add:post'));
    assert.match(String(api.last('sendMessage')?.body.text), /Latest post/, 'the source behind the link is previewed');
    assert.ok(fetched.includes('http://rsshub.test/instagram/user/zuck'));
  } finally {
    db.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('M18: an IG reel names no account, but the extractor does, so the chooser offers it', async () => {
  const api = await fakeBotApi();
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-classify-reel-'));
  const db = openDb(join(dir, 'bot.db'));
  allowUser(db, USER_ID);
  fetched.length = 0;

  try {
    const bot = createBot({ cfg: cfgFor(), db, apiRoot: api.apiRoot, http, media: engine });
    await bot.init();
    await bot.handleUpdate(startUpdate(1, USER_ID));
    await bot.handleUpdate(textUpdate(2, USER_ID, 'https://www.instagram.com/reel/DbndR7CNuhv/?hl=en'));

    const chooser = api.last('sendMessage');
    assert.ok(buttons(chooser).includes('add:post'), 'the poster the extractor named is offered as a source');
    await bot.handleUpdate(callbackUpdate(3, USER_ID, 'add:post'));
    assert.match(String(api.last('sendMessage')?.body.text), /Latest post/, 'the poster feed is previewed');
    assert.ok(fetched.includes('http://rsshub.test/instagram/user/cristiano'));
  } finally {
    db.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('M18: with a Twitter token, an X post offers its account before and after download, and the caption names it', async () => {
  const api = await fakeBotApi();
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-classify-x-'));
  const db = openDb(join(dir, 'bot.db'));
  allowUser(db, USER_ID);
  fetched.length = 0;
  const cfg = parseConfig({ BOT_TOKEN: TOKEN, ADMIN_CHAT_ID: '1', RSSHUB_BASE: 'http://rsshub.test', CALLBACK_INTERVAL_MS: '0', ADD_INTERVAL_MS: '0', MAX_DOWNLOADS_PER_DAY: '5', TWITTER_AUTH_TOKEN: 'auth' });

  try {
    const bot = createBot({ cfg, db, apiRoot: api.apiRoot, http, media: engine });
    await bot.init();
    await bot.handleUpdate(startUpdate(1, USER_ID));
    await bot.handleUpdate(textUpdate(2, USER_ID, 'https://x.com/QAiStudio/status/2117256134616818159'));

    const chooser = api.last('sendMessage');
    assert.ok(buttons(chooser).includes('add:post'), 'the account the link names is offered before download');

    await bot.handleUpdate(callbackUpdate(3, USER_ID, 'dl:post'));
    const html = String(api.last('sendRichMessage')?.body.rich_message?.html ?? '');
    assert.match(html, /<a href="https:\/\/x\.com\/QAiStudio\/status\/2117256134616818159">@QAiStudio<\/a>/, 'the account names the source, not the bare host');
    assert.ok(buttons(api.last('sendMessage')).includes('add:post'), 'and the result offers it too');

    await bot.handleUpdate(callbackUpdate(4, USER_ID, 'add:post'));
    assert.match(String(api.last('sendMessage')?.body.text), /Latest post/, 'the X feed is previewed');
    assert.ok(fetched.includes('http://rsshub.test/twitter/user/QAiStudio'));
  } finally {
    db.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('M17: a Pinterest pin offers the pinner its oEmbed card names', async () => {
  const api = await fakeBotApi();
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-classify-pin-'));
  const db = openDb(join(dir, 'bot.db'));
  allowUser(db, USER_ID);
  fetched.length = 0;

  try {
    const bot = createBot({ cfg: cfgFor(), db, apiRoot: api.apiRoot, http, media: engine });
    await bot.init();
    await bot.handleUpdate(startUpdate(1, USER_ID));

    await bot.handleUpdate(textUpdate(2, USER_ID, 'https://www.pinterest.com/pin/1149614242378622706/'));
    assert.ok(buttons(api.last('sendMessage')).includes('add:post'), 'the pinner is offered as a source');
    await bot.handleUpdate(callbackUpdate(3, USER_ID, 'add:post'));
    assert.match(String(api.last('sendMessage')?.body.text), /Latest post/, 'the pinner feed is previewed');
    assert.ok(fetched.includes('http://rsshub.test/pinterest/user/sabrinaeasminn'), 'on the RSSHub user route');
  } finally {
    db.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('M17: a threads post offers the account behind it, and adding it runs the source flow', async () => {
  const api = await fakeBotApi();
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-classify-threads-'));
  const db = openDb(join(dir, 'bot.db'));
  allowUser(db, USER_ID);

  try {
    const bot = createBot({ cfg: cfgFor(), db, apiRoot: api.apiRoot, http, media: engine });
    await bot.init();
    await bot.handleUpdate(startUpdate(1, USER_ID));
    await bot.handleUpdate(textUpdate(2, USER_ID, 'https://www.threads.net/@zuck/post/Cabc'));

    const chooser = api.last('sendMessage');
    assert.ok(buttons(chooser).includes('dl:post'), 'the download is offered');
    assert.ok(buttons(chooser).includes('add:post'), 'and the account the URL names');

    await bot.handleUpdate(callbackUpdate(3, USER_ID, 'add:post'));
    const preview = api.last('sendMessage');
    assert.match(String(preview?.body.text), /Latest post/, 'the profile behind the post is previewed');
    assert.ok(
      buttons(preview).some((data) => data.startsWith('add:dest:')),
      'and Add to My Sources is one tap away',
    );
  } finally {
    db.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
