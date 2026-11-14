/**
 * S4 end to end (§5.4): a pasted profile goes through stage 2 — the site's own feed and an RSSHub
 * route — and the preview that reaches the chat always lists the five newest posts. The caption cap
 * (1024) is where they used to disappear; the screen's own five-line rule is `source-preview.test.ts`.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { callbackUpdate, fakeBotApi, startUpdate, textUpdate } from '../fake-api.ts';
import { allowUser } from '../seed.ts';
import { createBot } from '../../src/bot/index.ts';
import { parseConfig } from '../../src/config.ts';
import { openDb } from '../../src/db/index.ts';
import type { Http } from '../../src/platform/http.ts';
import { CAPTION_LIMIT } from '../../src/telegram/api.ts';

const TOKEN = '123456:AAHfakeTokenForTestsOnly_1234567890abc';
const USER_ID = 555;
const RSSHUB_BASE = 'http://rsshub.test';
const AVATAR = 'https://cdn.example.test/avatar.jpg';

/** A title longer than any real feed ships, and one the cap must shorten on its own. */
const LONG = 't'.repeat(400);

const item = (index: number, title: string): string =>
  `<item><title><![CDATA[${title}]]></title><link>https://example.test/p/${index}</link>`
  + `<guid>g${index}</guid><pubDate>${new Date(Date.UTC(2026, 10, 1 + index, 9, 0)).toUTCString()}</pubDate></item>`;

/** A seven-post feed: five survive the preview, the two oldest do not. */
const feed = (titles: string[]): string =>
  `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Example</title>`
  + `<link>https://example.test/</link><image><url>${AVATAR}</url></image>`
  + titles.map((title, index) => item(index, title)).join('')
  + '</channel></rss>';

const TITLES = [`Oldest post`, `Second oldest`, `Post three ${LONG}`, `Post four ${LONG}`, `Post five ${LONG}`, `Post six ${LONG}`, `Newest post`];

const bullets = (text: string): string[] => text.split('\n').filter((line) => line.startsWith('• '));

/** Runs the add flow for one pasted profile and returns the S4 caption (a photo caption here). */
async function preview(link: string, http: Http): Promise<string> {
  const api = await fakeBotApi();
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-preview-'));
  const cfg = parseConfig({ BOT_TOKEN: TOKEN, ADMIN_CHAT_ID: '1', RSSHUB_BASE, CALLBACK_INTERVAL_MS: '0', ADD_INTERVAL_MS: '0' });
  const db = openDb(join(dir, 'bot.db'));
  try {
    allowUser(db, USER_ID);
    const bot = createBot({ cfg, db, apiRoot: api.apiRoot, http });
    await bot.init();
    await bot.handleUpdate(startUpdate(1, USER_ID));
    await bot.handleUpdate(callbackUpdate(2, USER_ID, 'menu:add'));
    const before = api.calls.length;
    await bot.handleUpdate(textUpdate(3, USER_ID, link));

    const photo = api.callsSince(before).filter((call) => call.method === 'sendPhoto').at(-1);
    assert.ok(photo !== undefined, `S4 went out as a photo (saw ${api.callsSince(before).map((call) => call.method).join(',')})`);
    return String(photo.body.caption ?? '');
  } finally {
    db.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

/** Every assertion S4 owes the user, whatever the platform behind it. */
function expectFivePosts(caption: string): void {
  const lines = bullets(caption);
  assert.equal(lines.length, 5, `five posts are listed:\n${caption}`);
  assert.ok(caption.length <= CAPTION_LIMIT, `the caption is ${caption.length} chars, the photo cap is ${CAPTION_LIMIT}`);
  assert.ok(!caption.endsWith('…'), 'the question survives: the caption was not sliced');
  assert.ok(lines.every((line) => line.length <= 130), 'every title is one list line');
}

test('S4: a site with its own feed previews five posts, long titles and all', async () => {
  const page = '<html><head><link rel="alternate" type="application/rss+xml" href="/feed"></head><body></body></html>';
  const http: Http = async (url) => {
    if (url === 'https://blog.example.test') return { status: 200, url, contentType: 'text/html', body: page };
    if (url === 'https://blog.example.test/feed') return { status: 200, url, contentType: 'application/rss+xml', body: feed(TITLES) };
    throw new Error(`unexpected fetch ${url}`);
  };

  const caption = await preview('https://blog.example.test', http);
  expectFivePosts(caption);
  assert.match(bullets(caption)[0] ?? '', /Post three/, 'the oldest of the newest five comes first');
  assert.match(bullets(caption)[4] ?? '', /Newest post/, 'the newest post is the last line');
});

test('S4: an Instagram profile through RSSHub previews five posts, long titles and all', async () => {
  const http: Http = async (url) => {
    if (url === `${RSSHUB_BASE}/instagram/user/natgeo`) return { status: 200, url, contentType: 'application/rss+xml', body: feed(TITLES) };
    throw new Error(`unexpected fetch ${url}`);
  };

  const caption = await preview('https://www.instagram.com/natgeo/', http);
  expectFivePosts(caption);
  assert.match(caption, /📸/, 'the preview carries the platform it read');
});
