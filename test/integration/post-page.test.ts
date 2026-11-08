/**
 * M22: a single-post permalink must keep the download/add chooser. WordPress serves its comment feed at
 * `/<post-slug>/feed/`, which looks section-scoped by URL; its items point back at the post.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createBot } from '../../src/bot/index.ts';
import { parseConfig } from '../../src/config.ts';
import { openDb } from '../../src/db/index.ts';
import type { Http } from '../../src/platform/http.ts';
import { callbackUpdate, fakeBotApi, startUpdate, textUpdate } from '../fake-api.ts';
import { allowUser } from '../seed.ts';

const TOKEN = '123456:AAHfakeTokenForTestsOnly_1234567890abc';
const USER_ID = 559;
const RSSHUB_BASE = 'http://rsshub.test';
const POST = 'https://blog.example.test/news/how-to-do-a-thing';
const COMMENTS = `${POST}/feed/`;
const SITE = 'https://blog.example.test';
const SITE_FEED = `${SITE}/feed/`;

const comments = `<?xml version="1.0"?><rss version="2.0"><channel><title>Comments on: How to do a thing</title>
  <item><title>By: someone</title><link>https://www.blog.example.test/news/how-to-do-a-thing/#comment-1</link><guid>c1</guid></item>
</channel></rss>`;

const siteFeed = `<?xml version="1.0"?><rss version="2.0"><channel><title>Example Blog</title>
  <item><title>Another story</title><link>https://blog.example.test/news/another-story</link><guid>s1</guid></item>
</channel></rss>`;

const http: Http = async (url) => {
  if (url === POST) return { status: 200, url, contentType: 'text/html', body: '<html><head><title>Post</title></head></html>' };
  if (url === COMMENTS) return { status: 200, url, contentType: 'application/rss+xml', body: comments };
  if (url === SITE) return { status: 200, url, contentType: 'text/html', body: '<html><head><link rel="alternate" type="application/rss+xml" href="/feed/"></head></html>' };
  if (url === SITE_FEED) return { status: 200, url, contentType: 'application/rss+xml', body: siteFeed };
  throw new Error(`unexpected fetch ${url}`);
};

test('M22: a post permalink offers download/add, and Add follows the site', async () => {
  const api = await fakeBotApi();
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-post-page-'));
  const cfg = parseConfig({ BOT_TOKEN: TOKEN, ADMIN_CHAT_ID: '1', RSSHUB_BASE, CALLBACK_INTERVAL_MS: '0', ADD_INTERVAL_MS: '0' });
  const db = openDb(join(dir, 'bot.db'));
  allowUser(db, USER_ID);

  try {
    const bot = createBot({ cfg, db, apiRoot: api.apiRoot, http });
    await bot.init();
    await bot.handleUpdate(startUpdate(1, USER_ID));
    await bot.handleUpdate(textUpdate(2, USER_ID, POST));

    const chooser = api.last('sendMessage');
    assert.match(String(chooser?.body.text ?? ''), /This is a post link/, 'a comment feed must not turn the post into a source');
    const buttons = ((chooser?.body.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> } | undefined)?.inline_keyboard ?? []).flat().map((button) => button.callback_data);
    assert.ok(buttons.includes('dl:post'), 'download is offered');
    assert.ok(buttons.includes('add:post'), 'and the site behind it');

    await bot.handleUpdate(callbackUpdate(3, USER_ID, 'add:post'));
    const preview = String(api.last('sendMessage')?.body.text ?? '');
    assert.match(preview, /<b>Example Blog<\/b>/, 'Add resolves the site, not the post’s comment feed');
    assert.doesNotMatch(preview, /Comments on/, 'the comment feed is never used');
  } finally {
    db.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
