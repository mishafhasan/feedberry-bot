/**
 * M19: a category URL is a source of its own. The preview names the category, the stored source keeps
 * the category URL and the feed that proved it, and a page that is not a category falls back to its
 * site. Everything runs on the fake Bot API and a stubbed `Http`; no network.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createBot } from '../../src/bot/index.ts';
import { parseConfig } from '../../src/config.ts';
import { openDb, type Db } from '../../src/db/index.ts';
import { resetSession } from '../../src/bot/fsm.ts';
import type { Http } from '../../src/platform/http.ts';
import { callbackUpdate, fakeBotApi, startUpdate, textUpdate } from '../fake-api.ts';
import { allowUser } from '../seed.ts';

const TOKEN = '123456:AAHfakeTokenForTestsOnly_1234567890abc';
const USER_ID = 555;
const RSSHUB_BASE = 'http://rsshub.test';

// Canonical URLs drop `www.` (registry.normalizeHost), so the stub answers the canonical spelling.
const WIRED = 'https://wired.com/category/science';
const WIRED_FEED = `${WIRED}/feed/`;
const BBC = 'https://bbc.com/technology';
const BBC_ALIAS = 'https://bbc.co.uk/news/technology';
const BBC_FEED = `${BBC_ALIAS}/rss.xml`;
const ARTICLE = 'https://blog.test/posts/a-quiet-return';
const SITE = 'https://blog.test';
const SITE_FEED = `${SITE}/rss`;

const wiredFeed = `<?xml version="1.0"?><rss version="2.0"><channel><title>Wired</title>
  <item><title>Quantum chip</title><link>https://www.wired.com/story/quantum</link><guid>w1</guid><category>Science</category></item>
  <item><title>Deep sea</title><link>https://www.wired.com/story/deep-sea</link><guid>w2</guid><category>Science</category></item>
</channel></rss>`;

const bbcFeed = `<?xml version="1.0"?><rss version="2.0"><channel><title>BBC News</title>
  <item><title>AI stocks</title><link>https://www.bbc.co.uk/news/articles/1</link><guid>b1</guid></item>
</channel></rss>`;

const siteFeed = `<?xml version="1.0"?><rss version="2.0"><channel><title>Blog</title>
  <item><title>An older post</title><link>https://blog.test/posts/older</link><guid>s1</guid></item>
</channel></rss>`;

const page = (links: string): string => `<html><head>${links}</head><body></body></html>`;
const alternate = (href: string): string => `<link rel="alternate" type="application/rss+xml" href="${href}">`;

const seen: string[] = [];

const http: Http = async (url) => {
  seen.push(url);
  if (url === WIRED) return { status: 200, url, contentType: 'text/html', body: page(alternate('/category/science/feed/')) };
  if (url === WIRED_FEED) return { status: 200, url, contentType: 'application/rss+xml', body: wiredFeed };
  if (url === BBC) return { status: 200, url, contentType: 'text/html', body: page(`<a href="${BBC_ALIAS}">Technology</a>`) };
  if (url === BBC_FEED) return { status: 200, url, contentType: 'application/rss+xml', body: bbcFeed };
  if (url === ARTICLE || url === SITE) return { status: 200, url, contentType: 'text/html', body: page(alternate('/rss')) };
  if (url === SITE_FEED) return { status: 200, url, contentType: 'application/rss+xml', body: siteFeed };
  throw new Error(`unexpected fetch ${url}`);
};

const row = (db: Db, url: string): { canonical_url: string; feed_url: string; title: string } =>
  db.prepare('SELECT canonical_url, feed_url, title FROM sources WHERE canonical_url = ?').get(url) as { canonical_url: string; feed_url: string; title: string };

test('M19: a category link is previewed as a category and stored with its own feed', async () => {
  const api = await fakeBotApi();
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-section-'));
  const cfg = parseConfig({ BOT_TOKEN: TOKEN, ADMIN_CHAT_ID: '1', RSSHUB_BASE, CALLBACK_INTERVAL_MS: '0', ADD_INTERVAL_MS: '0' });
  const db = openDb(join(dir, 'bot.db'));
  allowUser(db, USER_ID);
  let updateId = 1;

  try {
    const bot = createBot({ cfg, db, apiRoot: api.apiRoot, http });
    await bot.init();
    await bot.handleUpdate(startUpdate(updateId++, USER_ID));

    // Add Source accepts it as a source, not as "a post link".
    await bot.handleUpdate(callbackUpdate(updateId++, USER_ID, 'menu:add'));
    await bot.handleUpdate(textUpdate(updateId++, USER_ID, 'https://www.wired.com/category/science/'));
    const preview = String(api.last('sendMessage')?.body.text ?? '');
    assert.match(preview, /<b>Wired · Science<\/b>/, 'the preview names the site and the category');
    assert.match(preview, /📂 Category: Science/, 'S4 says what is being monitored');
    assert.match(preview, /Quantum chip/, 'and shows the category posts');

    const personal = db.prepare("SELECT id FROM chats WHERE type = 'private'").get() as { id: number };
    await bot.handleUpdate(callbackUpdate(updateId++, USER_ID, `add:dest:${personal.id}`));
    await bot.handleUpdate(callbackUpdate(updateId++, USER_ID, 'add:save'));
    assert.match(String(api.last('editMessageText')?.body.text ?? ''), /is added to your feed/, 'S6 confirms');

    const stored = row(db, WIRED);
    assert.equal(stored.canonical_url, WIRED, 'the category page is the source');
    assert.equal(stored.feed_url, WIRED_FEED, 'the section feed is what every later check reads');
    assert.equal(stored.title, 'Wired · Science', 'the list says which category it is');
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM posts').get() as { n: number }).n, 2);

    // A one-segment page is ambiguous on the URL alone, so its own feed decides: this one has a
    // category feed behind an alias, so it goes straight to the preview, no download chooser.
    await bot.handleUpdate(textUpdate(updateId++, USER_ID, 'https://www.bbc.com/technology'));
    const bbcPreview = String(api.last('sendMessage')?.body.text ?? '');
    assert.match(bbcPreview, /<b>BBC News · Technology<\/b>/);
    assert.match(bbcPreview, /📂 Category: Technology/);

    // A page with no category feed is an article: the download choice stays, but is offered from the
    // resolution instead of from the URL shape.
    resetSession(USER_ID); // the preview above owns the session; a fresh message starts a new flow
    const before = seen.filter((url) => url === SITE_FEED).length;
    await bot.handleUpdate(textUpdate(updateId++, USER_ID, ARTICLE));
    assert.equal(
      seen.filter((url) => url === SITE_FEED).length - before,
      2,
      'the feed is fetched as the alternate and again as the site fallback, never as a directory too',
    );
    const chooser = api.last('sendMessage');
    assert.match(String(chooser?.body.text ?? ''), /post link/);
    const buttons = ((chooser?.body.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> } | undefined)?.inline_keyboard ?? []).flat().map((button) => button.callback_data);
    assert.ok(buttons.includes('dl:post') && buttons.includes('add:post'), 'download and add are both offered');
  } finally {
    db.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
