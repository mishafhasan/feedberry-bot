/**
 * R15 (§8.1): a carousel whose third clip is past the Bot API's 50 MB ceiling still arrives. The
 * playable media goes out as one album, the big clip contributes a frame plus a 🎬 caption line,
 * and the post is delivered rather than dropped.
 */
import assert from 'node:assert/strict';
import { closeSync, copyFileSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createBot } from '../../src/bot/index.ts';
import { parseConfig } from '../../src/config.ts';
import { openDb } from '../../src/db/index.ts';
import { ensurePrivateChat } from '../../src/db/repos/chats.ts';
import { markPendingDelivery } from '../../src/db/repos/deliveries.ts';
import { insertPosts } from '../../src/db/repos/posts.ts';
import { upsertSource } from '../../src/db/repos/sources.ts';
import { insertSubscription } from '../../src/db/repos/subscriptions.ts';
import { ensureUser } from '../../src/db/repos/users.ts';
import type { MediaEngine, MediaItem } from '../../src/media/media-engine.ts';
import type { Thumbnailer } from '../../src/media/thumbnail.ts';
import type { Http } from '../../src/platform/http.ts';
import { deliverPending } from '../../src/pipeline/run.ts';
import { TelegramSender } from '../../src/telegram/api.ts';
import { callbackUpdate, fakeBotApi, startUpdate, textUpdate } from '../fake-api.ts';
import { allowUser } from '../seed.ts';

const TOKEN = '123456:AAHfakeTokenForTestsOnly_1234567890abc';
const USER_ID = 555;
const POST = 'https://x.com/Royal/status/2120186300917542912';
const BIG = 'https://video.twimg.com/amplify_video/2120186300917542912/vid/avc1/848x464/M_Hex2T7T_vKTl70.mp4?tag=29';
const VIDEO = fileURLToPath(new URL('../fixtures/media/video.mp4', import.meta.url));
const PHOTO = fileURLToPath(new URL('../fixtures/media/photo.jpg', import.meta.url));
const OVER_50MB = 51 * 1024 * 1024;

/** The carousel: two clips that fit, one that does not, two photos. */
const ITEMS: MediaItem[] = [
  { kind: 'video', url: 'https://cdn.test/v1.mp4', picker: false },
  { kind: 'video', url: 'https://cdn.test/v2.mp4', picker: false },
  { kind: 'video', url: BIG, picker: false },
  { kind: 'photo', url: 'https://cdn.test/i1.jpg', picker: false },
  { kind: 'photo', url: 'https://cdn.test/i2.jpg', picker: false },
];

let downloads = 0;
const engine: MediaEngine = {
  async resolve() {
    return { items: ITEMS, title: 'Three clips', artist: '@Royal' };
  },
  async download(item, dir) {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `media-${++downloads}${item.kind === 'video' ? '.mp4' : '.jpg'}`);
    if (item.url === BIG) {
      // A sparse 51 MB file: the upload ceiling without a 51 MB blob in git.
      const fd = openSync(path, 'w');
      ftruncateSync(fd, OVER_50MB);
      closeSync(fd);
      return path;
    }
    copyFileSync(item.kind === 'video' ? VIDEO : PHOTO, path);
    return path;
  },
};

/** ffmpeg is not assumed in CI, so the frame grabber is stubbed with the photo fixture. */
let frames = 0;
const thumbnail: Thumbnailer = async (_video, dir) => {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `frame-${++frames}.jpg`);
  copyFileSync(PHOTO, path);
  return path;
};

const http: Http = async (url) => {
  throw new Error(`no page fetch expected in R15, got ${url}`);
};

test('R15: an album with one 51 MB clip ships as a frame plus a caption link', async () => {
  const api = await fakeBotApi();
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-r15-int-'));
  const cfg = parseConfig({ BOT_TOKEN: TOKEN, ADMIN_CHAT_ID: '1', RSSHUB_BASE: 'http://rsshub.test' });
  const db = openDb(join(dir, 'bot.db'));

  try {
    const user = ensureUser(db, USER_ID);
    const chat = ensurePrivateChat(db, user.id, USER_ID);
    const source = upsertSource(db, {
      platform: 'x',
      canonicalUrl: 'https://x.com/Royal',
      externalId: 'Royal',
      feedUrl: 'https://rsshub.test/x/user/Royal',
      strategy: 'rsshub',
      title: '@Royal',
      avatarUrl: null,
    });
    insertSubscription(db, { userId: user.id, sourceId: source.id, chatId: chat.id, deliver: true, nextSlotAt: null });

    const posts = insertPosts(db, source.id, [
      { guid: 'r15', link: POST, title: 'Three clips', summary: null, publishedAt: Date.parse('2026-11-10T16:07:00Z'), media: [] },
    ]);
    for (const entry of posts) markPendingDelivery(db, entry.id, chat.id);

    const bot = createBot({ cfg, db, apiRoot: api.apiRoot, http, media: engine });
    await bot.init();
    const result = await deliverPending({ db, http, cfg, media: engine, thumbnail, sender: new TelegramSender(bot.api) }, source.id);

    assert.equal(result.delivered, 1, 'the post is delivered, never dropped');
    assert.equal(result.failed, 0);

    const groups = api.calls.filter((call) => call.method === 'sendMediaGroup');
    assert.equal(groups.length, 1, 'five items fit one group');
    const media = groups[0]?.body.media as Array<{ type: string; caption?: string }>;
    assert.equal(media.length, 5, 'two clips + two photos + the frame standing in for the big clip');
    assert.deepEqual(media.map((item) => item.type), ['video', 'video', 'photo', 'photo', 'photo'], 'the 51 MB clip is not one of them');

    const caption = String(media[0]?.caption ?? '');
    assert.match(caption, /^🌐 <a href="https:\/\/x\.com\/Royal\/status\/2120186300917542912">@Royal<\/a> \| X/);
    assert.match(caption, /⏱️ Time: 11\/10 16:07/);
    assert.ok(caption.includes('Three clips'), 'the post text sits between the header and the links');
    assert.ok(caption.endsWith(`🎬 ${BIG}`), `the caption links the clip it could not send:\n${caption}`);

    assert.equal(api.calls.filter((call) => call.method === 'sendVideo').length, 0, 'the 51 MB clip never starts an upload');

    const row = db.prepare('SELECT status FROM deliveries ORDER BY id DESC LIMIT 1').get() as { status: string };
    assert.equal(row.status, 'sent', 'too large is a success path, not a failure');
  } finally {
    db.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('R15: Download Mode delivers the same carousel, frame included', async () => {
  const api = await fakeBotApi();
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-r15-dl-'));
  const cfg = parseConfig({ BOT_TOKEN: TOKEN, ADMIN_CHAT_ID: '1', RSSHUB_BASE: 'http://rsshub.test', CALLBACK_INTERVAL_MS: '0', ADD_INTERVAL_MS: '0' });
  const db = openDb(join(dir, 'bot.db'));
  allowUser(db, USER_ID);

  try {
    const bot = createBot({ cfg, db, apiRoot: api.apiRoot, http, media: engine, thumbnail });
    await bot.init();

    await bot.handleUpdate(startUpdate(1, USER_ID));
    await bot.handleUpdate(callbackUpdate(2, USER_ID, 'menu:download'));
    await bot.handleUpdate(textUpdate(3, USER_ID, POST));
    await bot.handleUpdate(callbackUpdate(4, USER_ID, 'dl:post'));

    const groups = api.calls.filter((call) => call.method === 'sendMediaGroup');
    assert.equal(groups.length, 1, 'the carousel ships as one group');
    const media = groups[0]?.body.media as Array<{ type: string; caption?: string }>;
    assert.deepEqual(media.map((item) => item.type), ['video', 'video', 'photo', 'photo', 'photo'], 'the 51 MB clip is replaced by its frame');
    assert.ok(String(media[0]?.caption ?? '').endsWith(`🎬 ${BIG}`), 'the caption still links the clip');
  } finally {
    db.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('R15: a lone oversized video in Download Mode ends on its media file, not the post page', async () => {
  const api = await fakeBotApi();
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-r15-single-'));
  const cfg = parseConfig({ BOT_TOKEN: TOKEN, ADMIN_CHAT_ID: '1', RSSHUB_BASE: 'http://rsshub.test', CALLBACK_INTERVAL_MS: '0', ADD_INTERVAL_MS: '0' });
  const db = openDb(join(dir, 'bot.db'));
  allowUser(db, USER_ID);

  // The reported case: one clip, past the ceiling, no album and no frame.
  const single: MediaEngine = {
    async resolve() {
      return { items: [{ kind: 'video', url: BIG, picker: false }], title: 'Claude FULL COURSE 1 HOUR', artist: 'Dhruv kumar' };
    },
    async download(_item, into) {
      mkdirSync(into, { recursive: true });
      const path = join(into, 'clip.mp4');
      const fd = openSync(path, 'w');
      ftruncateSync(fd, OVER_50MB);
      closeSync(fd);
      return path;
    },
  };

  try {
    const bot = createBot({ cfg, db, apiRoot: api.apiRoot, http, media: single, thumbnail });
    await bot.init();

    await bot.handleUpdate(startUpdate(1, USER_ID));
    await bot.handleUpdate(callbackUpdate(2, USER_ID, 'menu:download'));
    await bot.handleUpdate(textUpdate(3, USER_ID, POST));

    // The pasted link alone delivers: there is no second button to press.
    const text = String(api.calls.filter((call) => call.method === 'sendMessage' && String(call.body.text ?? '').includes('🎬')).at(-1)?.body.text ?? '');
    assert.ok(text.endsWith(`🎬 ${BIG}`), `the last line is the media file:\n${text}`);
    assert.ok(!text.trimEnd().endsWith(POST), 'the post page is not the last thing the reader sees');
    assert.equal(api.calls.filter((call) => call.method === 'sendVideo').length, 0, 'the clip never starts an upload');
  } finally {
    db.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
