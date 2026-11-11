/**
 * Threads download mode end to end, through the fake Bot API: one link in, the whole thread out.
 * The page fixture is the recon capture, so nothing here touches Threads.
 */
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { test } from 'node:test';
import { createBot } from '../../src/bot/index.ts';
import type { TelegraphPage } from '../../src/article/telegraph.ts';
import { parseConfig } from '../../src/config.ts';
import { openDb } from '../../src/db/index.ts';
import { ensurePrivateChat } from '../../src/db/repos/chats.ts';
import { upsertSource } from '../../src/db/repos/sources.ts';
import { insertSubscription } from '../../src/db/repos/subscriptions.ts';
import { ensureUser } from '../../src/db/repos/users.ts';
import type { MediaEngine } from '../../src/media/media-engine.ts';
import type { Http } from '../../src/platform/http.ts';
import { parseThreadDocument } from '../../src/platform/feed/threads.ts';
import { runFetchSource } from '../../src/pipeline/run.ts';
import { TelegramSender } from '../../src/telegram/api.ts';
import { esc } from '../../src/render/message-plan.ts';
import { callbackUpdate, commandUpdate, fakeBotApi, startUpdate, textUpdate } from '../fake-api.ts';
import { allowUser } from '../seed.ts';

const TOKEN = '123456:AAHfakeTokenForTestsOnly_1234567890abc';
const USER_ID = 777;
const PHOTO = fileURLToPath(new URL('../fixtures/media/photo.jpg', import.meta.url));

const evidence = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../fixtures/threads/${name}`, import.meta.url)), 'utf8');

const T1 = 'https://www.threads.com/@prompt.__hub/post/DcsVM6HlDOv';

/** The thread page, and the three headers that make Threads render it. */
function threadsHttp(html: string): { http: Http; seen: Array<Record<string, string> | undefined> } {
  const seen: Array<Record<string, string> | undefined> = [];
  const http: Http = async (url, options) => {
    seen.push(options.headers);
    return { status: 200, url, contentType: 'text/html; charset=utf-8', body: html };
  };
  return { http, seen };
}

/** A thread with no media at all: the shape that fails today, because cobalt needs a picture. */
function textThreadHtml(): string {
  const post = (pk: string, code: string, text: string, level: number) => ({
    pk,
    code,
    taken_at: 1_700_000_000 + level,
    user: { username: 'writer' },
    text_post_app_info: { reply_level: level, text_fragments: { fragments: [{ plaintext: text }] } },
  });
  const root = post('900', 'Root1', 'The root of a text-only thread.', 0);
  const sub = post('901', 'Sub22', 'The continuation that cobalt never saw.', 1);
  return `<script type="application/json" data-sjs>${JSON.stringify({
    expectedPreloaders: [{ variables: { postID: '900' } }],
    data: { media: { ...root, text_post_app_info: { ...root.text_post_app_info, self_thread: { posts: { edges: [{ node: sub }] } } } } },
  })}</script>`;
}

function mediaEngine(photoCalls: { resolve: number; download: number }): MediaEngine {
  return {
    async resolve() {
      photoCalls.resolve++;
      return { items: [], title: 'cobalt fallback', artist: null };
    },
    async download(_item, dir) {
      photoCalls.download++;
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `photo-${photoCalls.download}.jpg`);
      copyFileSync(PHOTO, path);
      return path;
    },
  };
}

/** The layout both modes must print: one linked source line with its platform, one day-first time line. */
function assertHeaderBlock(html: string, hrefPattern: string, name: string, platform: string): void {
  assert.match(
    html,
    new RegExp(`<a href="${hrefPattern}">${escapeRegExp(name)}</a> \\| ${escapeRegExp(platform)}<br/>⏱️ Time: \\d{2}\\/\\d{2} \\d{2}:\\d{2}`),
    `header block (saw ${html.slice(0, 120)}…)`,
  );
  assert.equal((html.match(/⏱️ Time:/g) ?? []).length, 1, 'one time line');
}

/** A rich post carries its whole text: no `(1/2)` split and no Instant View tail (ADR-023). */
function assertNoSplit(html: string): void {
  assert.doesNotMatch(html, /\(\d+\/\d+\)/, 'nothing is split into numbered parts');
  assert.doesNotMatch(html, /Read more/, 'no Instant View link on the rich path');
}

/** The renderer escapes source text and turns each newline into <br/>; match a tail the same way. */
const richTail = (text: string): string => esc(text).replace(/\n/g, '<br/>');

test('threads: one post link delivers the whole thread, its words and its media', async () => {
  const api = await fakeBotApi();
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-threads-'));
  const cfg = parseConfig({ BOT_TOKEN: TOKEN, ADMIN_CHAT_ID: '1', RSSHUB_BASE: 'http://rsshub.test', CALLBACK_INTERVAL_MS: '0', ADD_INTERVAL_MS: '0', MAX_DOWNLOADS_PER_DAY: '5' });
  const db = openDb(join(dir, 'bot.db'));
  allowUser(db, USER_ID);
  const pages: TelegraphPage[] = [];
  const telegraph = {
    async createPage(page: TelegraphPage): Promise<string> {
      pages.push(page);
      return `https://telegra.ph/thread-${pages.length}`;
    },
  };
  const calls = { resolve: 0, download: 0 };
  const { http, seen } = threadsHttp(evidence('06-t1-root-ssr-run1.html'));
  const expected = parseThreadDocument(evidence('06-t1-root-ssr-run1.html'), 'DcsVM6HlDOv');
  assert.ok(expected, 'the fixture parses');

  try {
    const bot = createBot({ cfg, db, apiRoot: api.apiRoot, http, media: mediaEngine(calls), telegraph });
    await bot.init();

    await bot.handleUpdate(startUpdate(1, USER_ID));
    await bot.handleUpdate(commandUpdate(2, USER_ID, 'download'));
    await bot.handleUpdate(textUpdate(3, USER_ID, T1));

    // The page is fetched with the headers that make Threads render it, never with cobalt.
    assert.equal(seen.length, 1, 'one request for the thread');
    assert.equal(seen[0]?.['sec-fetch-site'], 'same-origin');
    assert.match(seen[0]?.accept ?? '', /text\/html/);
    assert.equal(calls.resolve, 0, 'cobalt resolve is skipped for a Threads post');

    const rich = api.last('sendRichMessage');
    assert.ok(rich, `the thread is sent as one rich message (saw ${api.calls.map((call) => call.method).join(',')})`);
    assert.equal(calls.download, 1, 'the one photo of the thread is downloaded');
    const html = String(rich.body.rich_message?.html ?? '');
    assert.match(html, /threads\.com\/@prompt\.__hub\/post\/DcsVM6HlDOv/);
    // The same header block a scheduled delivery prints.
    assertHeaderBlock(html, 'https:\/\/(?:www\.)?threads\.com\/@prompt\.__hub\/post\/DcsVM6HlDOv', 'PROMPT HUB', 'Threads');
    assertNoSplit(html);
    assert.match(html, /<tg-slideshow><img src="tg:\/\/photo\?id=m0"\/><\/tg-slideshow>/, 'the photo rides in the slideshow');
    
    // Both posts' words reach the message whole: root and the 3,779-char sub-post.
    assert.equal(pages.length, 0, 'no Instant View page on the rich path');
    assert.match(html, /data="more:[A-Za-z0-9_-]+"/, 'a long thread opens with a Show more button');
    const token = /data="more:([A-Za-z0-9_-]+)"/.exec(html)?.[1] ?? '';
    await bot.handleUpdate(callbackUpdate(4, USER_ID, `more:${token}`));
    const expanded = String(api.last('editMessageText')?.body.rich_message?.html ?? '');
    assert.ok(expanded.includes(richTail(expected.posts[1]?.text.slice(-60) ?? '')), 'the sub-post text arrives on expand');
    assert.match(expanded, /<tg-slideshow>/, 'the slideshow survives the edit');

    const row = db.prepare('SELECT post_id, status FROM deliveries ORDER BY id DESC LIMIT 1').get() as { post_id: number | null; status: string };
    assert.equal(row.post_id, null, 'Download mode has no posts row');
    assert.equal(row.status, 'sent');
  } finally {
    db.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('threads: a text-only thread is delivered as text, not as a failure', async () => {
  const api = await fakeBotApi();
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-threads-text-'));
  const cfg = parseConfig({ BOT_TOKEN: TOKEN, ADMIN_CHAT_ID: '1', RSSHUB_BASE: 'http://rsshub.test', CALLBACK_INTERVAL_MS: '0', ADD_INTERVAL_MS: '0', MAX_DOWNLOADS_PER_DAY: '5' });
  const db = openDb(join(dir, 'bot.db'));
  allowUser(db, USER_ID);
  const calls = { resolve: 0, download: 0 };
  const { http } = threadsHttp(textThreadHtml());

  try {
    const bot = createBot({ cfg, db, apiRoot: api.apiRoot, http, media: mediaEngine(calls) });
    await bot.init();
    await bot.handleUpdate(startUpdate(1, USER_ID));
    await bot.handleUpdate(commandUpdate(2, USER_ID, 'download'));
    await bot.handleUpdate(textUpdate(3, USER_ID, 'https://www.threads.com/@writer/post/Root1'));

    assert.equal(calls.resolve, 0);
    assert.equal(calls.download, 0, 'nothing to download');
    assert.equal(api.last('sendPhoto'), undefined, 'no media message for a text thread');
    const html = String(api.last('sendRichMessage')?.body.rich_message?.html ?? '');
    assert.ok(html.includes('The root of a text-only thread.'), 'the root text arrives');
    assert.ok(html.includes('The continuation that cobalt never saw.'), 'so does the sub-post');
  } finally {
    db.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('threads: the app shell falls back to cobalt instead of failing', async () => {
  const api = await fakeBotApi();
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-threads-shell-'));
  const cfg = parseConfig({ BOT_TOKEN: TOKEN, ADMIN_CHAT_ID: '1', RSSHUB_BASE: 'http://rsshub.test', CALLBACK_INTERVAL_MS: '0', ADD_INTERVAL_MS: '0', MAX_DOWNLOADS_PER_DAY: '5' });
  const db = openDb(join(dir, 'bot.db'));
  allowUser(db, USER_ID);
  const calls = { resolve: 0, download: 0 };
  const { http } = threadsHttp(evidence('01-root-post-html.html'));

  try {
    const bot = createBot({ cfg, db, apiRoot: api.apiRoot, http, media: mediaEngine(calls) });
    await bot.init();
    await bot.handleUpdate(startUpdate(1, USER_ID));
    await bot.handleUpdate(commandUpdate(2, USER_ID, 'download'));
    await bot.handleUpdate(textUpdate(3, USER_ID, T1));

    assert.equal(calls.resolve, 1, 'the shell hands the link to cobalt, which is what ships today');
    assert.match(api.last('sendMessage')?.body.text ?? '', /Delivered/, 'the download still completes');
  } finally {
    db.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

/** The RSSHub item the bug report came from: the handle glued to a cut-down copy, in title and body. */
function feedWithPreview(): string {
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>PROMPT HUB (@prompt.__hub) on Threads</title>
    <item><title>@prompt.hub: Prompt by⚡️ @prompt.hub A young adult woman(… P...</title>
    <link>${T1}</link><guid isPermaLink="false">DcsVM6HlDOv</guid>
    <pubDate>Sat, 01 Nov 2026 16:16:00 GMT</pubDate>
    <description><![CDATA[@prompt.__hub :

Prompt by⚡️
@prompt.__hub
A young adult woman(feed preview, cut short.]]></description></item></channel></rss>`;
}

test('threads: a scheduled source prints the whole thread, not the feed preview twice', async () => {
  const api = await fakeBotApi();
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-threads-scheduled-'));
  const cfg = parseConfig({ BOT_TOKEN: TOKEN, ADMIN_CHAT_ID: '1', RSSHUB_BASE: 'http://rsshub.test', CALLBACK_INTERVAL_MS: '0', ADD_INTERVAL_MS: '0' });
  const db = openDb(join(dir, 'bot.db'));
  allowUser(db, USER_ID);

  const html = evidence('06-t1-root-ssr-run1.html');
  const expected = parseThreadDocument(html, 'DcsVM6HlDOv');
  assert.ok(expected, 'the fixture parses');

  // RSSHub ships the preview that caused the bug: handle glued to a cut-down copy, in title and body.
  const feed = feedWithPreview();
  const http: Http = async (url) => {
    if (url.startsWith('http://rsshub.test/')) return { status: 200, url, contentType: 'application/rss+xml', body: feed };
    return { status: 200, url, contentType: 'text/html; charset=utf-8', body: html };
  };
  const calls = { resolve: 0, download: 0 };
  const media: MediaEngine = {
    async resolve() {
      calls.resolve++;
      // Two photos: a Threads carousel has to arrive as one album, not one message per photo.
      return {
        items: [
          { kind: 'photo', url: 'https://cdn.test/one.jpg', picker: false },
          { kind: 'photo', url: 'https://cdn.test/two.jpg', picker: false },
        ],
        title: null,
        artist: null,
      };
    },
    async download(_item, workDir) {
      calls.download++;
      mkdirSync(workDir, { recursive: true });
      const path = join(workDir, `media-photo-${calls.download}`);
      copyFileSync(PHOTO, path);
      return path;
    },
  };
  const pages: TelegraphPage[] = [];
  const telegraph = {
    async createPage(page: TelegraphPage): Promise<string> {
      pages.push(page);
      return `https://telegra.ph/scheduled-${pages.length}`;
    },
  };

  try {
    const user = ensureUser(db, USER_ID);
    const chat = ensurePrivateChat(db, user.id, USER_ID);
    const source = upsertSource(db, {
      platform: 'threads',
      canonicalUrl: 'https://threads.com/@prompt.__hub',
      externalId: 'prompt.__hub',
      feedUrl: 'http://rsshub.test/threads/prompt.__hub',
      strategy: 'rsshub',
      title: 'PROMPT HUB (@prompt.__hub) on Threads',
      avatarUrl: null,
    });
    insertSubscription(db, { userId: user.id, sourceId: source.id, chatId: chat.id, deliver: true, nextSlotAt: Date.now() - 1000 });

    const bot = createBot({ cfg, db, apiRoot: api.apiRoot, http, media, telegraph });
    await bot.init();
    await runFetchSource({ db, http, cfg, media, thumbnail: async () => null, sender: new TelegramSender(bot.api), telegraph }, source.id);

    const rich = api.last('sendRichMessage');
    const html = String(rich?.body.rich_message?.html ?? '');
    const richMedia = (rich?.body.rich_message?.media ?? []) as Array<unknown>;
    assert.equal(richMedia.length, 2, 'both photos ride in one slideshow');
    assert.equal(calls.download, 2, 'every photo of the post is downloaded');
    // The layout Download Mode prints, with the source the feed named.
    assertHeaderBlock(html, 'https:\/\/(?:www\.)?threads\.com\/@prompt\.__hub\/post\/DcsVM6HlDOv', 'PROMPT HUB (@prompt.__hub)', 'Threads');
    assert.doesNotMatch(html, /feed preview|@prompt\.__hub :/, 'the feed preview is not printed as a body of its own');
    assertNoSplit(html);
    
    // The whole thread — root and the 3,779-char sub-post — reaches the message, once.
    assert.equal(pages.length, 0, 'no Instant View page on the rich path');
    assert.match(html, /data="more:[A-Za-z0-9_-]+"/, 'the scheduled thread opens with a Show more button');
    const token = /data="more:([A-Za-z0-9_-]+)"/.exec(html)?.[1] ?? '';
    await bot.handleUpdate(callbackUpdate(10, USER_ID, `more:${token}`));
    const expanded = String(api.last('editMessageText')?.body.rich_message?.html ?? '');
    assert.ok(expanded.includes(richTail(expected.posts[1]?.text.slice(-60) ?? '')), 'the sub-post tail arrives on expand');
    assert.doesNotMatch(html, /feed preview/, 'the message carries the thread, not the RSS preview');
  } finally {
    db.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('threads: a blocked permalink keeps the feed text instead of losing the post', async () => {
  const api = await fakeBotApi();
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-threads-offline-'));
  const cfg = parseConfig({ BOT_TOKEN: TOKEN, ADMIN_CHAT_ID: '1', RSSHUB_BASE: 'http://rsshub.test', CALLBACK_INTERVAL_MS: '0', ADD_INTERVAL_MS: '0' });
  const db = openDb(join(dir, 'bot.db'));
  allowUser(db, USER_ID);

  // The permalink answers with the app shell, which is the anti-bot refusal on a real request.
  const feed = feedWithPreview();
  const shell = evidence('01-root-post-html.html');
  const http: Http = async (url) => {
    if (url.startsWith('http://rsshub.test/')) return { status: 200, url, contentType: 'application/rss+xml', body: feed };
    return { status: 200, url, contentType: 'text/html; charset=utf-8', body: shell };
  };
  const media: MediaEngine = {
    async resolve() {
      return { items: [], title: null, artist: null };
    },
    async download() {
      throw new Error('nothing to download');
    },
  };

  try {
    const user = ensureUser(db, USER_ID);
    const chat = ensurePrivateChat(db, user.id, USER_ID);
    const source = upsertSource(db, {
      platform: 'threads',
      canonicalUrl: 'https://threads.com/@prompt.__hub',
      externalId: 'prompt.__hub',
      feedUrl: 'http://rsshub.test/threads/prompt.__hub',
      strategy: 'rsshub',
      title: 'PROMPT HUB (@prompt.__hub) on Threads',
      avatarUrl: null,
    });
    insertSubscription(db, { userId: user.id, sourceId: source.id, chatId: chat.id, deliver: true, nextSlotAt: Date.now() - 1000 });

    const bot = createBot({ cfg, db, apiRoot: api.apiRoot, http, media });
    await bot.init();
    await runFetchSource({ db, http, cfg, media, thumbnail: async () => null, sender: new TelegramSender(bot.api) }, source.id);

    const html = String(api.last('sendRichMessage')?.body.rich_message?.html ?? '');
    assertHeaderBlock(html, 'https:\/\/(?:www\.)?threads\.com\/@prompt\.__hub\/post\/DcsVM6HlDOv', 'PROMPT HUB (@prompt.__hub)', 'Threads');
    assert.match(html, /data="more:[A-Za-z0-9_-]+"/, 'the long feed text opens with a Show more button');
    const token = /data="more:([A-Za-z0-9_-]+)"/.exec(html)?.[1] ?? '';
    await bot.handleUpdate(callbackUpdate(1, USER_ID, `more:${token}`));
    const expanded = String(api.last('editMessageText')?.body.rich_message?.html ?? '');
    assert.match(expanded, /feed preview/, 'the feed text ships when the permalink says no');
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE status = 'sent'").get() as { n: number }).n, 1, 'one delivery, not two');
  } finally {
    db.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
