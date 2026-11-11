/**
 * YouTube community posts end to end, through the fake Bot API: one /post/ link in, the post out.
 * The page fixtures are the captures behind the unit tests, so nothing here touches YouTube.
 */
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { test } from 'node:test';
import { createBot } from '../../src/bot/index.ts';
import { getSession } from '../../src/bot/session.ts';
import { parseConfig } from '../../src/config.ts';
import { openDb } from '../../src/db/index.ts';
import type { MediaEngine } from '../../src/media/media-engine.ts';
import type { Http } from '../../src/platform/http.ts';
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

    const photo = api.last('sendPhoto');
    assert.ok(photo, `the post photo is sent (saw ${api.calls.map((call) => call.method).join(',')})`);
    const caption = String(photo.body.caption ?? '');
    assert.ok(caption.length <= 1024, 'the caption stays inside Telegram\'s limit');
    assert.match(caption, /Ceylon Focus News/, 'the channel title heads the caption');
    assert.match(caption, /youtube\.com\/post\/UgkxGuBM_v4CJugE7V-Dns33VhSMVB0_UL_F/, 'the post is one tap away');
    assert.match(caption, /உலகெங்கிலும்/, 'the post\'s own words are the body');

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

test('youtube: an album post ships every photo in one media group', async () => {
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

    const group = api.last('sendMediaGroup');
    assert.ok(group, `the album is sent (saw ${api.calls.map((call) => call.method).join(',')})`);
    const media = group.body.media as Array<{ caption?: string }>;
    assert.equal(media.length, 2, 'both images, in post order');
    assert.equal(calls.download, 2);
    // R3/R4: an album carries its caption on the first item, never on the group.
    assert.match(media[0]?.caption ?? '', /MrBeast/);
    assert.match(media[0]?.caption ?? '', /themostdangerousgames\.com/);
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

    assert.equal(calls.download, 0, 'nothing to upload');
    assert.equal(api.last('sendPhoto'), undefined, 'no media message for a text post');
    assert.equal(api.last('sendMediaGroup'), undefined);
    const texts = api.calls.filter((call) => call.method === 'sendMessage').map((call) => String(call.body.text ?? ''));
    assert.ok(texts.some((text) => text.includes('https://youtu.be/tycyv2eoOaU')), 'the attached video ships as a link');
  } finally {
    db.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
