/**
 * YouTube community posts end to end, through the fake Bot API: one /post/ link in, the post out.
 * The page fixtures are the captures behind the unit tests, so nothing here touches YouTube.
 */
import assert from 'node:assert/strict';
import { copyFileSync, closeSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { test } from 'node:test';
import { createBot } from '../../src/bot/index.ts';
import { getSession } from '../../src/bot/session.ts';
import { parseConfig } from '../../src/config.ts';
import { openDb } from '../../src/db/index.ts';
import { ensurePrivateChat } from '../../src/db/repos/chats.ts';
import { markPendingDelivery } from '../../src/db/repos/deliveries.ts';
import { insertPosts } from '../../src/db/repos/posts.ts';
import { upsertSource } from '../../src/db/repos/sources.ts';
import { insertSubscription } from '../../src/db/repos/subscriptions.ts';
import { ensureUser } from '../../src/db/repos/users.ts';
import type { MediaEngine } from '../../src/media/media-engine.ts';
import type { Http } from '../../src/platform/http.ts';
import { deliverPending } from '../../src/pipeline/run.ts';
import { TelegramSender } from '../../src/telegram/api.ts';
import { commandUpdate, fakeBotApi, startUpdate, textUpdate } from '../fake-api.ts';
import { allowUser } from '../seed.ts';

const TOKEN = '123456:AAHfakeTokenForTestsOnly_1234567890abc';
const USER_ID = 777;
const PHOTO = fileURLToPath(new URL('../fixtures/media/photo.jpg', import.meta.url));

const POST = 'https://www.youtube.com/post/UgkxGuBM_v4CJugE7V-Dns33VhSMVB0_UL_F';
const ALBUM = 'https://www.youtube.com/post/UgkxzJ6r7VLAK03TN5Gjq7YpjHmjtee_Rdn9';
const VIDEO_POST = 'https://www.youtube.com/post/UgkxvMrKTpUbvqLPjv-lVi7N0wn68DV_NCBQ';

const evidence = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../fixtures/youtube/${name}`, import.meta.url)), 'utf8');

/** The post page, and the URLs the bot asked for: the adapter is the only network call. */
function postHttp(html: string): { http: Http; seen: string[] } {
  const seen: string[] = [];
  const http: Http = async (url) => {
    seen.push(url);
    return { status: 200, url, contentType: 'text/html; charset=utf-8', body: html };
  };
  return { http, seen };
}

function mediaEngine(calls: { resolve: number; download: number }): MediaEngine {
  return {
    async resolve() {
      calls.resolve++;
      return { items: [], title: 'cobalt fallback', artist: null };
    },
    async download(_item, dir) {
      calls.download++;
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `photo-${calls.download}.jpg`);
      copyFileSync(PHOTO, path);
      return path;
    },
  };
}

const config = (): ReturnType<typeof parseConfig> =>
  parseConfig({ BOT_TOKEN: TOKEN, ADMIN_CHAT_ID: '1', RSSHUB_BASE: 'http://rsshub.test', CALLBACK_INTERVAL_MS: '0', ADD_INTERVAL_MS: '0', MAX_DOWNLOADS_PER_DAY: '5' });

test('youtube: one post link delivers its channel, its words and its photo', async () => {
  const api = await fakeBotApi();
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-youtube-'));
  const db = openDb(join(dir, 'bot.db'));
  allowUser(db, USER_ID);
  const calls = { resolve: 0, download: 0 };
  const { http, seen } = postHttp(evidence('post-image.html'));

  try {
    const bot = createBot({ cfg: config(), db, apiRoot: api.apiRoot, http, media: mediaEngine(calls) });
    await bot.init();

    await bot.handleUpdate(startUpdate(1, USER_ID));
    await bot.handleUpdate(commandUpdate(2, USER_ID, 'download'));
    await bot.handleUpdate(textUpdate(3, USER_ID, POST));

    // One request, on the host that answers with the post, and cobalt is never asked.
    assert.deepEqual(seen, ['https://www.youtube.com/post/UgkxGuBM_v4CJugE7V-Dns33VhSMVB0_UL_F']);
    assert.equal(calls.resolve, 0, 'cobalt resolve is skipped for a community post');
    assert.equal(calls.download, 1, 'the post photo is downloaded');

    const rich = api.last('sendRichMessage');
    assert.ok(rich, `the post is sent as one rich message (saw ${api.calls.map((call) => call.method).join(',')})`);
    const html = String(rich.body.rich_message?.html ?? '');
    assert.match(html, /Ceylon Focus News/, 'the channel title heads the message');
    assert.match(html, /youtube\.com\/post\/UgkxGuBM_v4CJugE7V-Dns33VhSMVB0_UL_F/, 'the post is one tap away');
    assert.match(html, /உலகெங்கிலும்/, 'the post\'s own words are the body');
    assert.match(html, /<tg-slideshow><img src="tg:\/\/photo\?id=m0"\/><\/tg-slideshow>/, 'the photo rides in the slideshow');

    // The channel the post names becomes the source to offer, on its keyless native feed route.
    const keyboard = JSON.stringify(api.last('sendMessage')?.body.reply_markup ?? {});
    assert.match(keyboard, /add:post/, 'the "add as source" button is offered');
    assert.match(keyboard, /@CeylonFocusNews/);
    assert.equal(getSession(USER_ID).chooser?.link, 'https://youtube.com/@CeylonFocusNews', 'the handle form is one source, not a second row');

    const row = db.prepare('SELECT post_id, status FROM deliveries ORDER BY id DESC LIMIT 1').get() as { post_id: number | null; status: string };
    assert.equal(row.post_id, null, 'Download mode has no posts row');
    assert.equal(row.status, 'sent');
  } finally {
    db.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('youtube: a scheduled community post with only a clip ships its poster and its label', async () => {
  const api = await fakeBotApi();
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-youtube-clip-'));
  const db = openDb(join(dir, 'bot.db'));
  const calls = { resolve: 0, download: 0 };

  try {
    const user = ensureUser(db, USER_ID);
    const chat = ensurePrivateChat(db, user.id, USER_ID);
    const source = upsertSource(db, { platform: 'youtube', canonicalUrl: 'https://youtube.com/@NASA', externalId: 'NASA', feedUrl: null, strategy: 'native_rss', title: 'NASA', avatarUrl: null });
    insertSubscription(db, { userId: user.id, sourceId: source.id, chatId: chat.id, deliver: true, nextSlotAt: null });
    // Stage 2 stores the attachment as a video page link; there is no photo to upload at all.
    const rows = insertPosts(db, source.id, [{
      guid: 'community-clip',
      link: VIDEO_POST,
      title: 'A post with a clip',
      summary: null,
      publishedAt: Date.now(),
      media: [{ url: 'https://youtu.be/tycyv2eoOaU', type: 'video' }],
    }]);
    for (const row of rows) markPendingDelivery(db, row.id, chat.id);

    const cfg = config();
    const bot = createBot({ cfg, db, apiRoot: api.apiRoot, http: async () => { throw new Error('no page fetch expected'); }, media: mediaEngine(calls) });
    await bot.init();
    const result = await deliverPending({ db, cfg, http: async () => { throw new Error('no feed fetch expected'); }, media: mediaEngine(calls), thumbnail: async () => null, sender: new TelegramSender(bot.api) }, source.id);

    assert.equal(result.delivered, 1);
    const rich = api.last('sendRichMessage');
    const html = String(rich?.body.rich_message?.html ?? '');
    assert.ok(html.includes('<p>🎬 <a href="https://youtu.be/tycyv2eoOaU">Video 1</a></p>'), `the label is there:\n${html}`);
    assert.ok(html.includes('<tg-slideshow><img src="tg://photo?id=m0"/></tg-slideshow>'), `and the poster rides above it:\n${html}`);
  } finally {
    db.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('youtube: an album post ships every photo in one slideshow', async () => {
  const api = await fakeBotApi();
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-youtube-album-'));
  const db = openDb(join(dir, 'bot.db'));
  allowUser(db, USER_ID);
  const calls = { resolve: 0, download: 0 };
  const { http } = postHttp(evidence('post-multi-image.html'));

  try {
    const bot = createBot({ cfg: config(), db, apiRoot: api.apiRoot, http, media: mediaEngine(calls) });
    await bot.init();

    await bot.handleUpdate(startUpdate(1, USER_ID));
    await bot.handleUpdate(commandUpdate(2, USER_ID, 'download'));
    await bot.handleUpdate(textUpdate(3, USER_ID, ALBUM));

    const rich = api.last('sendRichMessage');
    assert.ok(rich, `the album is sent as one rich message (saw ${api.calls.map((call) => call.method).join(',')})`);
    const media = rich.body.rich_message?.media as Array<unknown>;
    assert.equal(media.length, 2, 'both images, in post order');
    assert.equal(calls.download, 2);
    const html = String(rich.body.rich_message?.html ?? '');
    assert.match(html, /MrBeast/);
    assert.match(html, /themostdangerousgames\.com/);
  } finally {
    db.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('youtube: a post that attaches a video ships it as a link, not as a download', async () => {
  const api = await fakeBotApi();
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-youtube-video-'));
  const db = openDb(join(dir, 'bot.db'));
  allowUser(db, USER_ID);
  const calls = { resolve: 0, download: 0 };
  const { http } = postHttp(evidence('post-video.html'));

  try {
    const bot = createBot({ cfg: config(), db, apiRoot: api.apiRoot, http, media: mediaEngine(calls) });
    await bot.init();

    await bot.handleUpdate(startUpdate(1, USER_ID));
    await bot.handleUpdate(commandUpdate(2, USER_ID, 'download'));
    await bot.handleUpdate(textUpdate(3, USER_ID, VIDEO_POST));

    assert.equal(calls.download, 1, 'the clip is not downloaded, only its poster (ADR-027)');
    assert.equal(api.last('sendPhoto'), undefined, 'no media message for a text post');
    assert.equal(api.last('sendMediaGroup'), undefined);
    const rich = api.last('sendRichMessage');
    const html = String(rich?.body.rich_message?.html ?? '');
    assert.ok(
      html.includes('<p>🎬 <a href="https://youtu.be/tycyv2eoOaU">Video 1</a></p>'),
      `the attached video ships as its label, never as a raw URL:\n${html}`,
    );
    assert.ok(
      html.includes('<tg-slideshow><img src="tg://photo?id=m0"/></tg-slideshow>'),
      `and its poster rides in the same message:\n${html}`,
    );
    assert.equal((rich?.body.rich_message?.media as Array<unknown> | undefined)?.length, 1, 'one uploaded poster');
  } finally {
    db.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('youtube: a scheduled post keeps the clip label even when its photos break the budget', async () => {
  const api = await fakeBotApi();
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-youtube-budget-'));
  const db = openDb(join(dir, 'bot.db'));
  const calls = { resolve: 0, download: 0 };

  try {
    const user = ensureUser(db, USER_ID);
    const chat = ensurePrivateChat(db, user.id, USER_ID);
    const source = upsertSource(db, { platform: 'youtube', canonicalUrl: 'https://youtube.com/@CeylonFocusNews', externalId: 'CeylonFocusNews', feedUrl: null, strategy: 'native_rss', title: 'Ceylon Focus News', avatarUrl: null });
    insertSubscription(db, { userId: user.id, sourceId: source.id, chatId: chat.id, deliver: true, nextSlotAt: null });
    // The community post as stage 2 stores it: one photo to download, one attached video as a page link.
    const rows = insertPosts(db, source.id, [{
      guid: 'community-video',
      link: VIDEO_POST,
      title: 'A post',
      summary: null,
      publishedAt: Date.now(),
      media: [{ url: 'https://yt3.ggpht.com/photo=s1600', type: 'photo' }, { url: 'https://youtu.be/tycyv2eoOaU', type: 'video' }],
    }]);
    for (const row of rows) markPendingDelivery(db, row.id, chat.id);

    // A one megabyte budget against a two megabyte photo: stage 5 trips it (ADR-012).
    const cfg = parseConfig({ BOT_TOKEN: TOKEN, ADMIN_CHAT_ID: '1', RSSHUB_BASE: 'http://rsshub.test', MAX_DOWNLOAD_MB: '1' });
    const heavy: MediaEngine = {
      async resolve() {
        return { items: [], title: null, artist: null };
      },
      async download(_item, into) {
        mkdirSync(into, { recursive: true });
        const path = join(into, 'photo.jpg');
        const fd = openSync(path, 'w');
        ftruncateSync(fd, 2 * 1024 * 1024);
        closeSync(fd);
        return path;
      },
    };
    const bot = createBot({ cfg, db, apiRoot: api.apiRoot, http: async () => { throw new Error('no page fetch expected'); }, media: heavy });
    await bot.init();
    const result = await deliverPending({ db, cfg, http: async () => { throw new Error('no feed fetch expected'); }, media: heavy, thumbnail: async () => null, sender: new TelegramSender(bot.api) }, source.id);

    assert.equal(result.delivered, 1, 'a budget failure is a degraded post, never a lost one');
    const rich = api.last('sendRichMessage');
    const media = (rich?.body.rich_message?.media ?? []) as Array<unknown>;
    assert.equal(media.length, 0, 'the photo that broke the budget is not uploaded');
    const html = String(rich?.body.rich_message?.html ?? '');
    assert.ok(html.includes('<p>🎬 <a href="https://youtu.be/tycyv2eoOaU">Video 1</a></p>'), `the clip is still one tap away:\n${html}`);
  } finally {
    db.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
