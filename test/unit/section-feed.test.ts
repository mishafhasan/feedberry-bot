/**
 * A category URL is a source of its own: the page's own feed decides which feed that is, and only a
 * site-wide feed is filtered down to the category. The four shapes below are the ones real sites use.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Coded, E, isCoded } from '../../src/platform/errors.ts';
import { parseFeed } from '../../src/platform/feed/native.ts';
import { fetchSectionFeed } from '../../src/platform/feed/section.ts';
import type { Http } from '../../src/platform/http.ts';
import type { SourceRef } from '../../src/platform/registry.ts';
import { fetchPageSource } from '../../src/pipeline/s2-feed.ts';

const PAGE = 'https://site.test/category/science';
const FEED = 'https://site.test/category/science/feed/';

const section: SourceRef = { platform: 'rss', canonicalUrl: PAGE, externalId: 'site.test', feedUrl: null, strategy: 'native_rss' };

type Route = { status: number; body: string; contentType?: string };

/** Unknown URLs fail like a 404; every request is recorded so "which feed answered" is provable. */
function stubHttp(routes: Record<string, Route>, seen: string[]): Http {
  return async (url) => {
    seen.push(url);
    const hit = routes[url];
    if (hit === undefined) throw new Coded(E.NO_FEED, `nothing at ${url}`);
    return { status: hit.status, url, contentType: hit.contentType ?? (url.endsWith('.xml') || /(^|\/)(feed|rss)\/?$/.test(url) ? 'application/rss+xml' : 'text/html'), body: hit.body };
  };
}

const rss = (items: string, title = 'Science'): string => `<?xml version="1.0"?><rss version="2.0"><channel><title>${title}</title>${items}</channel></rss>`;
const item = (link: string, categories = ''): string => `<item><title>${link}</title><link>${link}</link><guid>${link}</guid>${categories}</item>`;
const html = (links: string): string => `<html><head>${links}</head><body></body></html>`;
const alternate = (href: string): string => `<link rel="alternate" type="application/rss+xml" href="${href}">`;

test('section feed: the feed the page scopes to itself answers, and nothing else is tried', async () => {
  const seen: string[] = [];
  const feed = await fetchSectionFeed(
    stubHttp({ [PAGE]: { status: 200, body: html(alternate('/category/science/feed/')) }, [FEED]: { status: 200, body: rss(item('https://site.test/story/a')) } }, seen),
    section,
    '/category/science',
  );

  assert.deepEqual(seen, [PAGE, FEED], 'the scoped alternate is the section feed, so no guessing');
  assert.deepEqual(feed.items.map((entry) => entry.guid), ['https://site.test/story/a']);
  assert.equal(feed.feedUrl, FEED, 'the discovered feed is what a later check stores');
});

test('section feed: the conventional path under the section answers when the page names no feed', async () => {
  const seen: string[] = [];
  const feed = await fetchSectionFeed(
    stubHttp({ [PAGE]: { status: 200, body: html('') }, [FEED]: { status: 200, body: rss(item('https://site.test/story/b')) } }, seen),
    section,
    '/category/science',
  );

  assert.equal(feed.items.length, 1);
  assert.equal(feed.feedUrl, FEED);
  assert.deepEqual(seen, [PAGE, FEED], '/feed/ is the first convention tried');
});

test('section feed: an alias the page links to itself carries the feed (bbc.com/technology → /news/technology)', async () => {
  const seen: string[] = [];
  const page = 'https://www.bbc.test/technology';
  const alias = 'https://www.bbc.test/news/technology';
  const aliasFeed = `${alias}/rss.xml`;
  const feed = await fetchSectionFeed(
    stubHttp(
      {
        [page]: { status: 200, body: html(`<a href="${alias}">Technology</a>`), contentType: 'text/html' },
        [aliasFeed]: { status: 200, body: rss(item('https://www.bbc.test/news/articles/1')) },
      },
      seen,
    ),
    { ...section, canonicalUrl: page, externalId: 'bbc.test' },
    '/technology',
  );

  assert.ok(seen.includes(aliasFeed), 'the alias feed was tried');
  assert.equal(feed.feedUrl, aliasFeed);
  assert.equal(feed.items.length, 1);
});

test('section feed: a feed directory the page links names the section feed by its id', async () => {
  const seen: string[] = [];
  const page = 'https://www.mirror.test/top-stories/155';
  const feedUrl = 'https://www.mirror.test/rss/top_story/155';
  const feed = await fetchSectionFeed(
    stubHttp(
      {
        [page]: { status: 200, body: html('<a href="/rss">RSS feeds</a>'), contentType: 'text/html' },
        'https://www.mirror.test/rss': { status: 200, body: html('<a href="/rss/top_story/155">Top Story</a><a href="/rss/sports/419">Sports</a>'), contentType: 'text/html' },
        [feedUrl]: { status: 200, body: rss(item('https://www.mirror.test/breaking-news/a/108-1'), 'Top Story') },
      },
      seen,
    ),
    { ...section, canonicalUrl: page, externalId: 'mirror.test' },
    '/top-stories/155',
  );

  assert.equal(feed.feedUrl, feedUrl);
  assert.equal(feed.items.length, 1);
});

test('section feed: a site-wide feed keeps only the items that carry the category', async () => {
  const seen: string[] = [];
  const siteFeed = 'https://site.test/feed/rss';
  const body = rss(
    `${item('https://site.test/story/from-science', '<category>Science</category>')}${item('https://site.test/story/from-gear', '<category>Gear</category>')}`,
    'Site',
  );
  const feed = await fetchSectionFeed(stubHttp({ [PAGE]: { status: 200, body: html(alternate(siteFeed)) }, [siteFeed]: { status: 200, body } }, seen), section, '/category/science');

  assert.deepEqual(feed.items.map((entry) => entry.guid), ['https://site.test/story/from-science'], 'unrelated content never reaches the subscription');
  assert.equal(feed.feedUrl, siteFeed, 'the feed is stored; the filter runs again on the next check');
});

test('section feed: an article in its own site feed never proves itself a category', async () => {
  // The pasted page is an item of the site feed; counting it would freeze a one-item subscription.
  const article = 'https://blog.test/posts/a-quiet-return';
  const siteFeed = 'https://blog.test/rss';
  const http = stubHttp(
    {
      [article]: { status: 200, body: html(alternate(siteFeed)) },
      [siteFeed]: { status: 200, body: rss(item('https://blog.test/posts/a-quiet-return?utm_source=rss')) },
    },
    [],
  );

  await assert.rejects(
    () => fetchSectionFeed(http, { ...section, canonicalUrl: article, externalId: 'blog.test' }, '/posts/a-quiet-return'),
    (err: unknown) => isCoded(err) && err.code === E.NO_FEED,
    'the page cannot be its own category',
  );
});

test('section feed: a multi-word section is named by a tag of the same words', async () => {
  const page = 'https://site.test/category/gear-deals';
  const siteFeed = 'https://site.test/feed/rss';
  const body = rss(
    `${item('https://site.test/story/1', '<category>Gear Deals</category>')}${item('https://site.test/story/2', '<category>Gear</category>')}`,
  );
  const feed = await fetchSectionFeed(
    stubHttp({ [page]: { status: 200, body: html(alternate(siteFeed)) }, [siteFeed]: { status: 200, body } }, []),
    { ...section, canonicalUrl: page, externalId: 'site.test' },
    '/category/gear-deals',
  );

  assert.deepEqual(feed.items.map((entry) => entry.guid), ['https://site.test/story/1'], 'the tag names the section; a shorter tag does not');
});

test('section feed: a scoped feed is never emptied by the tag filter', async () => {
  const stored = { ...section, feedUrl: FEED };
  const body = rss(item('https://site.test/story/untagged'));
  const feed = await fetchSectionFeed(stubHttp({ [FEED]: { status: 200, body } }, []), stored, '/category/science');

  assert.equal(feed.items.length, 1, 'the section feed is the section, whatever its items are tagged');
});

test('section feed: a post’s own comment feed is not a category', async () => {
  // WordPress answers `/<post-slug>/feed/` with the comments feed; its items point at the post itself.
  const page = 'https://blog.test/news/how-to-do-a-thing';
  const comments = `${page}/feed/`;
  const body = rss(
    '<item><title>By: someone</title><link>https://www.blog.test/news/how-to-do-a-thing/#comment-1</link><guid>x</guid></item>',
    'Comments on: How to do a thing',
  );

  await assert.rejects(
    () => fetchSectionFeed(stubHttp({ [page]: { status: 200, body: html('') }, [comments]: { status: 200, body } }, []), { ...section, canonicalUrl: page, externalId: 'blog.test' }, '/news/how-to-do-a-thing'),
    (err: unknown) => isCoded(err) && err.code === E.NO_FEED,
    'items that point back at the page are not a section',
  );
});

test('section feed: a page with no feed for the section is an honest E_NO_FEED', async () => {
  await assert.rejects(
    () => fetchSectionFeed(stubHttp({ [PAGE]: { status: 200, body: html('') } }, []), section, '/category/science'),
    (err: unknown) => isCoded(err) && err.code === E.NO_FEED,
  );
});

test('section feed: a site-wide feed is not proved by the directory every post shares', async () => {
  // Every post lives under /posts/, so a parent segment must never count as the section itself.
  const article = 'https://blog.test/posts/a-quiet-return';
  const siteFeed = 'https://blog.test/rss';
  const body = rss(`${item('https://blog.test/posts/other-1')}${item('https://blog.test/posts/other-2')}`);
  const http = stubHttp(
    { [article]: { status: 200, body: html(alternate(siteFeed)) }, 'https://blog.test': { status: 200, body: html(alternate(siteFeed)) }, [siteFeed]: { status: 200, body } },
    [],
  );

  const resolved = await fetchPageSource(http, { ...section, canonicalUrl: article, externalId: 'blog.test' });
  assert.equal(resolved.ref.canonicalUrl, 'https://blog.test', 'the article is not a category, so the site is the source');
});

test('section feed: a category URL with no feed is refused, never widened to the whole site', async () => {
  await assert.rejects(
    () => fetchPageSource(stubHttp({ [PAGE]: { status: 200, body: html('') } }, []), section),
    (err: unknown) => isCoded(err) && err.code === E.NO_FEED,
  );
});

test('section feed: a pasted article falls back to the site it belongs to', async () => {
  const article = 'https://blog.test/a-quiet-return';
  const page = stubHttp(
    { [article]: { status: 200, body: html(alternate('https://blog.test/rss')) }, 'https://blog.test': { status: 200, body: html(alternate('https://blog.test/rss')) }, 'https://blog.test/rss': { status: 200, body: rss(item('https://blog.test/x')) } },
    [],
  );
  const resolved = await fetchPageSource(page, { ...section, canonicalUrl: article, externalId: 'blog.test' });

  assert.equal(resolved.ref.canonicalUrl, 'https://blog.test', 'the article is not a category, so the site is the source');
  assert.equal(resolved.feed.items.length, 1);
});

test('section feed: a category page stays the source, with the feed that proved it', async () => {
  const http = stubHttp({ [PAGE]: { status: 200, body: html(alternate('/category/science/feed/')) }, [FEED]: { status: 200, body: rss(item('https://site.test/story/a')) } }, []);
  const resolved = await fetchPageSource(http, section);

  assert.equal(resolved.ref.canonicalUrl, PAGE);
  assert.equal(resolved.feed.feedUrl, FEED);
});

test('section feed: RSS <category> and Atom term both reach the item', () => {
  const feed = parseFeed(
    `<?xml version="1.0"?><rss version="2.0"><channel><title>Site</title>
      <item><title>One</title><link>https://site.test/a</link><guid>a</guid><category>Science</category><category><![CDATA[Space]]></category></item>
      <item><title>Two</title><link>https://site.test/b</link><guid>b</guid></item>
    </channel></rss>`,
    'https://site.test',
  );
  assert.deepEqual(feed.items[0]?.categories, ['Science', 'Space']);
  assert.equal(feed.items[1]?.categories, undefined, 'an untagged item carries no empty array');

  const atom = parseFeed(
    `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Site</title>
      <entry><id>a</id><title>One</title><link href="https://site.test/a"/><category term="Science"/></entry>
    </feed>`,
    'https://site.test',
  );
  assert.deepEqual(atom.items[0]?.categories, ['Science']);
});
