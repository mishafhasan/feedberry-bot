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
import { resetSession } from '../../src/bot/session.ts';
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
    const feedsBefore = seen.filter((url) => url === SITE_FEED).length;
    const pagesBefore = seen.filter((url) => url === SITE).length;
    await bot.handleUpdate(textUpdate(updateId++, USER_ID, ARTICLE));
    assert.equal(seen.filter((url) => url === SITE_FEED).length - feedsBefore, 1, 'the page’s own alternate is fetched once as evidence');
    assert.equal(seen.filter((url) => url === SITE).length - pagesBefore, 0, 'a chooser needs no site page');
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

const MIRROR = 'https://dailymirror.lk/rss/breaking_news/108';
const MIRROR_TOP = 'https://dailymirror.lk/rss/top_story/155';

/** The site publishes its own domain as the channel title, which names no category at all. */
const mirrorFeed = (title: string, slug: string, id: string): string => `<?xml version="1.0"?><rss version="2.0"><channel><title>www.dailymirror.lk</title>
  <item><title>${title}</title><link>https://www.dailymirror.lk/breaking_news/${slug}</link><guid>${id}</guid></item>
</channel></rss>`;

test('M31 source title: two category feeds of one domain are named apart', async () => {
  const api = await fakeBotApi();
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-titles-'));
  const cfg = parseConfig({ BOT_TOKEN: TOKEN, ADMIN_CHAT_ID: '1', RSSHUB_BASE, CALLBACK_INTERVAL_MS: '0', ADD_INTERVAL_MS: '0' });
  const db = openDb(join(dir, 'bot.db'));
  allowUser(db, USER_ID);
  let updateId = 1;
  const http: Http = async (url) => {
    if (url === MIRROR) return { status: 200, url, contentType: 'application/rss+xml', body: mirrorFeed('Airbag recall', 'airbag', 'm1') };
    if (url === MIRROR_TOP) return { status: 200, url, contentType: 'application/rss+xml', body: mirrorFeed('Scam probe', 'scam', 'm2') };
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const bot = createBot({ cfg, db, apiRoot: api.apiRoot, http });
    await bot.init();
    await bot.handleUpdate(startUpdate(updateId++, USER_ID));

    const titles: string[] = [];
    for (const link of [MIRROR, MIRROR_TOP]) {
      resetSession(USER_ID);
      await bot.handleUpdate(textUpdate(updateId++, USER_ID, link));
      titles.push(String(api.last('sendMessage')?.body.text ?? ''));
      const personal = db.prepare("SELECT id FROM chats WHERE type = 'private'").get() as { id: number };
      await bot.handleUpdate(callbackUpdate(updateId++, USER_ID, `add:dest:${personal.id}`));
      await bot.handleUpdate(callbackUpdate(updateId++, USER_ID, 'add:save'));
    }

    assert.match(titles[0] ?? '', /<b>Dailymirror · Breaking News<\/b>/, 'the feed path names the category its own title does not');
    assert.match(titles[1] ?? '', /<b>Dailymirror · Top Story<\/b>/);
    assert.notEqual(titles[0], titles[1], 'two categories of one site never preview the same');

    const rows = db.prepare('SELECT canonical_url, title FROM sources ORDER BY id').all() as Array<{ canonical_url: string; title: string }>;
    assert.deepEqual(rows.map((row) => row.title), ['Dailymirror · Breaking News', 'Dailymirror · Top Story'], 'and the list prints the same two names');
    assert.equal(rows[0]?.canonical_url, MIRROR, 'each source keeps its own feed');
  } finally {
    db.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('M31 sections: a listing word is followed to the feed the site publishes for it', async () => {
  const api = await fakeBotApi();
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-listing-'));
  const cfg = parseConfig({ BOT_TOKEN: TOKEN, ADMIN_CHAT_ID: '1', RSSHUB_BASE, CALLBACK_INTERVAL_MS: '0', ADD_INTERVAL_MS: '0' });
  const db = openDb(join(dir, 'bot.db'));
  allowUser(db, USER_ID);
  const POPULAR = 'https://listing.test/popular';
  const POPULAR_FEED = `${POPULAR}/feed/`;
  const http: Http = async (url) => {
    if (url === POPULAR) return { status: 200, url, contentType: 'text/html', body: page('') };
    if (url === POPULAR_FEED) {
      const feed = `<?xml version="1.0"?><rss version="2.0"><channel><title>Listing News</title>
  <item><title>Most read today</title><link>https://listing.test/popular/most-read</link><guid>l1</guid></item>
</channel></rss>`;
      return { status: 200, url, contentType: 'application/rss+xml', body: feed };
    }
    // The site-wide guesses must fail, or the section feed would never be the one that answers.
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const bot = createBot({ cfg, db, apiRoot: api.apiRoot, http });
    await bot.init();
    await bot.handleUpdate(startUpdate(1, USER_ID));
    await bot.handleUpdate(textUpdate(2, USER_ID, POPULAR));

    const preview = String(api.last('sendMessage')?.body.text ?? '');
    assert.match(preview, /<b>Listing News · Popular<\/b>/, 'the feed names the site, the path names the category');
    assert.match(preview, /📂 Category: Popular/, 'S4 says which listing is followed');
    assert.match(preview, /Most read today/, 'and the listing’s own posts');

    const personal = db.prepare("SELECT id FROM chats WHERE type = 'private'").get() as { id: number };
    await bot.handleUpdate(callbackUpdate(3, USER_ID, `add:dest:${personal.id}`));
    await bot.handleUpdate(callbackUpdate(4, USER_ID, 'add:save'));

    const stored = row(db, POPULAR);
    assert.equal(stored.canonical_url, POPULAR, 'the listing is the source');
    assert.equal(stored.feed_url, POPULAR_FEED, 'and its own feed is what every later check reads');
    assert.equal(stored.title, 'Listing News · Popular');
  } finally {
    db.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('M31: a listing whose site publishes no feed offers the download, never a dead Retry', async () => {
  const api = await fakeBotApi();
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-nofeed-'));
  const cfg = parseConfig({ BOT_TOKEN: TOKEN, ADMIN_CHAT_ID: '1', RSSHUB_BASE, CALLBACK_INTERVAL_MS: '0', ADD_INTERVAL_MS: '0' });
  const db = openDb(join(dir, 'bot.db'));
  allowUser(db, USER_ID);
  // No rel=alternate, no /feed, no /rss, no sitemap: the site publishes nothing to follow.
  const http: Http = async (url) => {
    if (url === 'https://no-feed.test/popular' || url === 'https://no-feed.test') {
      return { status: 200, url, contentType: 'text/html', body: '<html><head><title>No feed</title></head><body></body></html>' };
    }
    return { status: 404, url, contentType: 'text/html', body: '' };
  };

  try {
    const bot = createBot({ cfg, db, apiRoot: api.apiRoot, http });
    await bot.init();
    await bot.handleUpdate(startUpdate(1, USER_ID));
    await bot.handleUpdate(textUpdate(2, USER_ID, 'https://no-feed.test/popular'));

    const notice = api.last('sendMessage');
    assert.match(String(notice?.body.text ?? ''), /publishes no feed/, 'the reason is said once');
    const buttons = ((notice?.body.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> } | undefined)?.inline_keyboard ?? []).flat().map((button) => button.callback_data);
    assert.ok(buttons.includes('dl:post'), 'the download the link still supports is offered');
    assert.ok(!buttons.includes('add:post'), 'no Add button that can only fail');
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM sources').get() as { n: number }).n, 0, 'nothing was stored');
  } finally {
    db.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
