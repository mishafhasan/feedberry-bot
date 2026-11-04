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
import type { MediaEngine } from '../../src/media/cobalt.ts';
import type { Http } from '../../src/platform/http.ts';
import { parseThreadDocument } from '../../src/platform/feed/threads.ts';
import { commandUpdate, fakeBotApi, startUpdate, textUpdate } from '../fake-api.ts';
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

    const photo = api.last('sendPhoto');
    assert.ok(photo, `the thread photo is sent (saw ${api.calls.map((call) => call.method).join(',')})`);
    assert.equal(calls.download, 1, 'the one photo of the thread is downloaded');
    const caption = String(photo.body.caption ?? '');
    assert.ok(caption.length <= 1024, 'the caption stays inside Telegram\'s limit');
    assert.match(caption, /👉🏻 Read more/, 'the thread tail moves to Instant View');
    assert.match(caption, /threads\.com\/@prompt\.__hub\/post\/DcsVM6HlDOv/);

    // Both posts' words reach the page: root (455) and the 3,779-char sub-post.
    assert.equal(pages.length, 1, 'one Instant View page per thread');
    const page = pages[0]?.content ?? '';
    assert.match(page, new RegExp(escapeRegExp(expected.posts[1]?.text.slice(-60) ?? '')), 'the sub-post text is not lost');
    assert.match(page, /cdn\.test|cdninstagram|scontent/i, 'the photo rides along');

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
    const texts = api.calls.filter((call) => call.method === 'sendMessage').map((call) => String(call.body.text ?? ''));
    assert.ok(texts.some((text) => text.includes('The root of a text-only thread.')), 'the root text arrives');
    assert.ok(texts.some((text) => text.includes('The continuation that cobalt never saw.')), 'so does the sub-post');
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

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
