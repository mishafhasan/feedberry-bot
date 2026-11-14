/**
 * ADR-028: the schedule and the paste are two doors into one pipeline. Every case here runs the same
 * post through Download Mode and through a seeded scheduled delivery, then compares what the reader gets.
 */
import assert from 'node:assert/strict';
import { closeSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import { ensureUser, upsertAllowedUser } from '../../src/db/repos/users.ts';
import type { MediaEngine, MediaItem } from '../../src/media/media-engine.ts';
import { parseYouTubePost } from '../../src/platform/feed/youtube-post.ts';
import type { Http } from '../../src/platform/http.ts';
import { deliverPending } from '../../src/pipeline/run.ts';
import { TelegramSender } from '../../src/telegram/api.ts';
import { commandUpdate, fakeBotApi, startUpdate, textUpdate } from '../fake-api.ts';

const TOKEN = '123456:AAHfakeTokenForTestsOnly_1234567890abc';
const USER_ID = 640;
const MB = 1024 * 1024;

interface Post {
  platform: string;
  /** The canonical link both doors use: a feed stores this, a paste resolves to it. */
  link: string;
  title: string;
  artist: string;
  publishedAt: number;
  /** Feed media, the only source a community post has. */
  media?: Array<{ url: string; type: string }>;
  /** The feed's own words, when they carry a player line the paste door never sees. */
  summary?: string;
  /** What the extractor answers for the post link, per quality rung. */
  resolve: (quality?: string) => MediaItem[];
  /** Poster the extractor states, when it states one. */
  poster?: string;
  /** A page the adapters read instead of a bare card (a YouTube community post). */
  page?: string;
  /** Bytes each URL lands, for the 50 MB gate. */
  sizes?: Record<string, number>;
}

/** A deterministic engine: sparse files, a size the CDN would report, per-rung results. */
function engineOf(post: Post, calls: { downloads: string[]; sizes: number[] }): MediaEngine {
  return {
    async resolve(_url, _signal, quality) {
      return { items: post.resolve(quality), title: post.title, artist: post.artist, publishedAt: post.publishedAt };
    },
    async size(item) {
      return post.sizes?.[item.url] ?? null;
    },
    async download(item, dir) {
      calls.downloads.push(item.url);
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `${item.kind}-${calls.downloads.length}.bin`);
      const bytes = post.sizes?.[item.url] ?? 2048;
      if (bytes < MB) {
        writeFileSync(path, Buffer.alloc(bytes, 1));
      } else {
        const fd = openSync(path, 'w');
        ftruncateSync(fd, bytes);
        closeSync(fd);
      }
      calls.sizes.push(bytes);
      return path;
    },
  };
}

/** The post page as the app reads it: no name, no description, no date — the engine carries those. */
const pageHttp = (post: Post): Http => async (url) => {
  if (url.includes('api.fxtwitter.com')) return { status: 200, url, contentType: 'application/json', body: JSON.stringify({ tweet: { text: post.title } }) };
  if (post.page !== undefined) return { status: 200, url, contentType: 'text/html', body: post.page };
  const image = post.poster === undefined ? '' : `<meta property="og:image" content="${post.poster}"/>`;
  return { status: 200, url, contentType: 'text/html', body: `<html><head>${image}</head><body></body></html>` };
};

/** A YouTube community post, read from the captured page the parser tests already rely on. */
function communityPost(): Post {
  const html = readFileSync(fileURLToPath(new URL('../fixtures/youtube/post-video.html', import.meta.url)), 'utf8');
  const id = 'UgkxvMrKTpUbvqLPjv-lVi7N0wn68DV_NCBQ';
  const doc = parseYouTubePost(html, id);
  assert.ok(doc, 'the fixture is a real community post');
  return {
    platform: 'youtube',
    link: `https://youtube.com/post/${id}`,
    title: doc.text,
    artist: doc.author ?? 'MrBeast',
    publishedAt: doc.publishedAt ?? 0,
    media: doc.videos.map((url) => ({ url, type: 'video' })),
    // Cobalt answers the post page with the page's own images: they are not the post's media, and
    // resolving the page at all is what put two pictures on the schedule and none on the paste (ADR-028).
    resolve: () => [
      { kind: 'photo', url: 'https://yt3.ggpht.com/page-a.jpg', picker: true },
      { kind: 'photo', url: 'https://yt3.ggpht.com/page-b.jpg', picker: true },
    ],
    sizes: { 'https://i.ytimg.com/vi/tycyv2eoOaU/hqdefault.jpg': 8192 },
    page: html,
  };
}

const config = (): ReturnType<typeof parseConfig> =>
  parseConfig({ BOT_TOKEN: TOKEN, ADMIN_CHAT_ID: '1', RSSHUB_BASE: 'http://rsshub.test', CALLBACK_INTERVAL_MS: '0', ADD_INTERVAL_MS: '0' });

interface Result {
  html: string;
  media: number;
  labels: number;
}

const resultOf = (rich: { html?: string; media?: unknown[] } | undefined): Result => {
  const html = String(rich?.html ?? '');
  return { html, media: (rich?.media ?? []).length, labels: (html.match(/🎬 <a href="[^"]+">Video \d<\/a>/g) ?? []).length };
};

/** Stage 3 → 7 through `deliverPending`, the schedule's own door. */
async function scheduled(post: Post): Promise<Result> {
  const api = await fakeBotApi();
  const dir = mkdtempSync(join(tmpdir(), 'parity-sched-'));
  const db = openDb(join(dir, 'bot.db'));
  const calls = { downloads: [] as string[], sizes: [] as number[] };
  try {
    const user = ensureUser(db, USER_ID);
    const chat = ensurePrivateChat(db, user.id, USER_ID);
    const source = upsertSource(db, { platform: post.platform, canonicalUrl: post.link, externalId: post.artist, feedUrl: null, strategy: 'native_rss', title: post.artist, avatarUrl: null });
    insertSubscription(db, { userId: user.id, sourceId: source.id, chatId: chat.id, deliver: true, nextSlotAt: null });
    const rows = insertPosts(db, source.id, [{ guid: 'parity', link: post.link, title: post.title, summary: post.summary ?? null, publishedAt: post.publishedAt, media: post.media ?? [] }]);
    for (const row of rows) markPendingDelivery(db, row.id, chat.id);

    const cfg = config();
    const engine = engineOf(post, calls);
    const http = pageHttp(post);
    const bot = createBot({ cfg, db, apiRoot: api.apiRoot, http, media: engine });
    await bot.init();
    const delivered = await deliverPending({ db, cfg, http, media: engine, thumbnail: async () => null, sender: new TelegramSender(bot.api) }, source.id);
    assert.equal(delivered.delivered, 1, 'the scheduled post is delivered');
    return resultOf(api.last('sendRichMessage')?.body.rich_message);
  } finally {
    db.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

/** Stage 1 → 7 through the bot's Download Mode handler, the paste's door. */
async function download(post: Post): Promise<Result> {
  const api = await fakeBotApi();
  const dir = mkdtempSync(join(tmpdir(), 'parity-dl-'));
  const db = openDb(join(dir, 'bot.db'));
  const calls = { downloads: [] as string[], sizes: [] as number[] };
  try {
    upsertAllowedUser(db, USER_ID);
    const cfg = config();
    const engine = engineOf(post, calls);
    const http = pageHttp(post);
    const bot = createBot({ cfg, db, apiRoot: api.apiRoot, http, media: engine });
    await bot.init();
    await bot.handleUpdate(startUpdate(1, USER_ID));
    await bot.handleUpdate(commandUpdate(2, USER_ID, 'download'));
    await bot.handleUpdate(textUpdate(3, USER_ID, post.link));
    const rich = api.last('sendRichMessage')?.body.rich_message;
    assert.ok(rich !== undefined, `Download Mode answered with a rich message (saw ${api.calls.map((call) => call.method).join(',')})`);
    return resultOf(rich);
  } finally {
    db.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

const small = (url: string, extra: Partial<MediaItem> = {}): MediaItem => ({ kind: 'video', url, picker: false, ...extra });

const cases: Array<{ name: string; post: Post; expect: (result: Result) => void }> = [
  {
    name: '(a) a small Instagram clip attaches inline',
    post: {
      platform: 'instagram',
      link: 'https://instagram.com/p/SmallClip',
      title: 'A short clip',
      artist: 'cristiano',
      publishedAt: Date.UTC(2026, 10, 13, 9, 30),
      resolve: () => [small('https://cdn.test/small.mp4')],
      poster: 'https://cdn.test/small.jpg',
      sizes: { 'https://cdn.test/small.mp4': 2 * MB, 'https://cdn.test/small.jpg': 2048 },
    },
    expect: (result) => {
      assert.equal(result.media, 1, 'the clip itself is uploaded');
      assert.match(result.html, /<tg-slideshow><video src="tg:\/\/video\?id=m0"><\/video><\/tg-slideshow>/);
      assert.equal(result.labels, 0, 'nothing to link');
    },
  },
  {
    name: '(b) a large X clip shows its label and poster',
    post: {
      platform: 'x',
      link: 'https://x.com/who/status/123',
      title: 'A two-hour course',
      artist: '@who',
      publishedAt: Date.UTC(2026, 10, 13, 10, 0),
      resolve: (quality) => [small(quality === '720' ? 'https://cdn.test/x-720.mp4' : 'https://cdn.test/x-1080.mp4')],
      poster: 'https://cdn.test/x.jpg',
      sizes: { 'https://cdn.test/x-1080.mp4': 490 * MB, 'https://cdn.test/x-720.mp4': 190 * MB, 'https://cdn.test/x.jpg': 4096 },
    },
    expect: (result) => {
      assert.equal(result.labels, 1, 'one labelled link');
      assert.equal(result.media, 1, 'the poster rides as the only upload');
      assert.match(result.html, /<tg-slideshow><img src="tg:\/\/photo\?id=m0"\/><\/tg-slideshow>/, 'the poster is above the label');
      assert.match(result.html, /🎬 <a href="https:\/\/cdn\.test\/x-1080\.mp4">Video 1<\/a>/, 'the label points at the 1080 URL');
    },
  },
  {
    name: '(c) a YouTube community clip keeps its poster and label',
    post: communityPost(),
    expect: (result) => {
      assert.equal(result.labels, 1);
      assert.equal(result.media, 1, 'only the derived poster, never the page images cobalt would answer');
      assert.match(result.html, /🎬 <a href="https:\/\/youtu\.be\/tycyv2eoOaU">Video 1<\/a>/);
      assert.doesNotMatch(result.html, /<p>[^<]*https?:\/\//, 'no raw URL on its own line');
    },
  },
  {
    name: '(d) a two-clip Instagram carousel stays inline',
    post: {
      platform: 'instagram',
      link: 'https://instagram.com/p/Carousel',
      title: 'Two clips',
      artist: 'nasa',
      publishedAt: Date.UTC(2026, 10, 13, 12, 0),
      resolve: () => [
        { kind: 'photo', url: 'https://cdn.test/i.jpg', picker: true },
        { kind: 'video', url: 'https://cdn.test/v1.mp4', picker: true },
        { kind: 'video', url: 'https://cdn.test/v2.mp4', picker: true },
      ],
      sizes: { 'https://cdn.test/i.jpg': 3000, 'https://cdn.test/v1.mp4': 4 * MB, 'https://cdn.test/v2.mp4': 3 * MB },
    },
    expect: (result) => {
      assert.equal(result.media, 3, 'both clips and the photo are uploaded');
      assert.equal(result.labels, 0, 'no link is needed');
    },
  },
  {
    name: '(e) a feed player line never prints beside the clip it linked',
    post: {
      platform: 'x',
      link: 'https://x.com/who/status/456',
      title: 'Made with Seedance',
      // ADR-021 stores the embedded player as its own line; the paste door reads the tweet instead.
      summary: 'Made with Seedance\n\n🎬 https://video.twimg.com/amplify/456/clip.mp4?tag=29',
      artist: '@who',
      publishedAt: Date.UTC(2026, 10, 13, 13, 0),
      resolve: () => [small('https://video.twimg.com/amplify/456/clip.mp4?tag=29')],
      sizes: { 'https://video.twimg.com/amplify/456/clip.mp4?tag=29': 2 * MB },
    },
    expect: (result) => {
      assert.equal(result.media, 1, 'the clip rides inline');
      assert.equal(result.labels, 0, 'a clip that fits is never linked');
      assert.doesNotMatch(result.html, /video\.twimg\.com/, 'and its direct URL never prints');
    },
  },
];

for (const entry of cases) {
  test(`parity ${entry.name}`, async () => {
    const fromSchedule = await scheduled(entry.post);
    const fromPaste = await download(entry.post);

    entry.expect(fromSchedule);
    entry.expect(fromPaste);
    assert.equal(fromPaste.html, fromSchedule.html, 'the two doors render the same message');
  });
}
