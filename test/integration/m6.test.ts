/**
 * M6 verification (IMPLEMENTATION_PLAN §4 M6): the 3-minute rule and the 50 MB wall.
 * A 2-minute clip uploads, a 4-minute clip arrives as a thumbnail plus a link, and a clip over
 * 50 MB never starts an upload at all (the fixture is a sparse file, not a 61 MB blob in git).
 */
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, openSync, closeSync, ftruncateSync, rmSync } from 'node:fs';
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
import type { MediaEngine, MediaItem } from '../../src/media/cobalt.ts';
import type { Thumbnailer } from '../../src/media/thumb.ts';
import type { Http } from '../../src/platform/http.ts';
import { deliverPending } from '../../src/pipeline/run.ts';
import { TelegramSender } from '../../src/telegram/api.ts';
import { fakeBotApi } from '../fake-api.ts';

const TOKEN = '123456:AAHfakeTokenForTestsOnly_1234567890abc';
const USER_ID = 555;
const VIDEO = fileURLToPath(new URL('../fixtures/media/video.mp4', import.meta.url));
const PHOTO = fileURLToPath(new URL('../fixtures/media/photo.jpg', import.meta.url));
const OVER_50MB = 51 * 1024 * 1024;

const video = (durationSec: number | null, bytes?: number): MediaItem => ({ kind: 'video', url: 'https://cdn.test/v.mp4', picker: false, durationSec, ...(bytes ? { bytes } : {}) });

/** URL → item; `bytes` makes the fake download produce a sparse file of that size. */
const MEDIA: Record<string, MediaItem & { bytes?: number }> = {
  'https://blog.example.test/video-2m': video(120),
  'https://blog.example.test/video-4m10': video(250),
  'https://blog.example.test/video-61mb': video(120, OVER_50MB),
  'https://blog.example.test/video-poster': video(250),
};

const engine: MediaEngine = {
  async resolve(url) {
    const item = MEDIA[url];
    return { items: item ? [item] : [], title: 'Video post' };
  },
  async download(item, dir) {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'clip.mp4');
    // resolve() hands back the same object, so identity tells us which fixture this is.
    if (item === MEDIA['https://blog.example.test/video-61mb']) {
      // A sparse 51 MB file: the 50 MB wall without a 61 MB blob in git.
      const fd = openSync(path, 'w');
      ftruncateSync(fd, OVER_50MB);
      closeSync(fd);
      return path;
    }
    copyFileSync(VIDEO, path);
    return path;
  },
};

/** ffmpeg is not assumed in CI, so the frame grabber is stubbed with the photo fixture. */
let thumbCalls = 0;
const thumbnail: Thumbnailer = async (_video, dir) => {
  thumbCalls++;
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'thumb.jpg');
  copyFileSync(PHOTO, path);
  return path;
};

const http: Http = async (url) => {
  throw new Error(`no feed fetch expected in M6, got ${url}`);
};

test('M6: 2-minute video uploads, 4-minute and 51 MB videos become thumbnail + link', async () => {
  const api = await fakeBotApi();
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-m6-'));
  const cfg = parseConfig({ BOT_TOKEN: TOKEN, ADMIN_CHAT_ID: '1', RSSHUB_BASE: 'http://rsshub.test' });
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
      { guid: 'v-2m', link: 'https://blog.example.test/video-2m', title: 'Two minutes' },
      { guid: 'v-4m', link: 'https://blog.example.test/video-4m10', title: 'Four minutes' },
      { guid: 'v-61', link: 'https://blog.example.test/video-61mb', title: 'Over fifty megabytes' },
    ].map((raw) => ({ ...raw, summary: null, publishedAt: Date.parse('2025-10-24T10:00:00Z'), media: [] as const }));

    // A fourth clip whose feed item already carries the platform poster.
    posts.push({
      guid: 'v-poster',
      link: 'https://blog.example.test/video-poster',
      title: 'A poster clip',
      summary: null,
      publishedAt: Date.parse('2025-10-24T10:00:00Z'),
      media: [{ url: 'https://cdn.test/poster.jpg', type: 'photo' }],
    });

    for (const entry of insertPosts(db, source.id, posts)) markPendingDelivery(db, entry.id, chat.id);

    const bot = createBot({ cfg, db, apiRoot: api.apiRoot, http, media: engine });
    await bot.init();
    const result = await deliverPending({ db, http, cfg, media: engine, thumbnail, sender: new TelegramSender(bot.api) }, source.id);

    assert.equal(result.delivered, 4, 'all four posts ship, none is a failure');
    assert.equal(result.failed, 0);

    const videos = api.calls.filter((c) => c.method === 'sendVideo');
    assert.equal(videos.length, 1, 'only the 2-minute clip is uploaded (R6)');

    const photos = api.calls.filter((c) => c.method === 'sendPhoto');
    assert.equal(photos.length, 3, 'the 4-minute, 51 MB and poster clips arrive as previews (R7/R8)');
    assert.ok(
      photos.some((call) => call.body.photo === 'https://cdn.test/poster.jpg'),
      'the platform poster is sent by URL, no frame grab needed',
    );
    assert.equal(thumbCalls, 2, 'ffmpeg runs only where the feed had no poster');

    const links = api.calls.filter((c) => c.method === 'sendMessage' && /blog\.example\.test\/video-(4m10|61mb|poster)$/.test(String(c.body.text)));
    assert.equal(links.length, 3, 'each preview is followed by its source link');

    const perPost = db.prepare("SELECT p.guid, d.status FROM deliveries d JOIN posts p ON p.id = d.post_id ORDER BY p.guid").all() as Array<{ guid: string; status: string }>;
    assert.deepEqual(
      perPost.map((row) => row.status),
      ['sent', 'sent', 'sent', 'sent'],
      'too-large is a silent success, not a failure',
    );
  } finally {
    db.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
