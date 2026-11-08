import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Coded, E } from '../../src/platform/errors.ts';
import { parseFeed, discoverAlternate, discoverAlternates, fetchNativeFeed } from '../../src/platform/feed/native.ts';
import { fetchRsshubFeed } from '../../src/platform/feed/rsshub.ts';
import type { Http } from '../../src/platform/http.ts';

const fixture = readFileSync(new URL('../fixtures/ig-profile.rss', import.meta.url), 'utf8');
const file = (name: string): string => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');

test('M2 feed parser: RSS 2.0 with CDATA, entities and enclosures', () => {
  const feed = parseFeed(fixture, 'https://www.instagram.com/cristiano/');
  assert.equal(feed.title, 'Cristiano Ronaldo');
  assert.equal(feed.avatarUrl, 'https://cdn.example.test/avatar.jpg');
  assert.equal(feed.items.length, 7);

  const first = feed.items[0];
  assert.equal(first?.guid, 'ig-1');
  assert.equal(first?.title, '71 years of passion. Happy birthday, Al Nassr! 💛💙', 'CDATA unwrapped');
  assert.equal(first?.link, 'https://www.instagram.com/p/C1/', 'relative links resolved');
  assert.equal(first?.publishedAt, Date.parse('Fri, 24 Oct 2025 20:34:00 GMT'));

  const second = feed.items[1];
  assert.equal(second?.title, "Let's go! 💛💙", 'entities decoded');

  const fourth = feed.items[3];
  assert.deepEqual(fourth?.media, [{ url: 'https://cdn.example.test/C4.jpg', type: 'photo' }]);
});

test('M2 feed parser: the whole post text is kept, from whichever tag carries it', () => {
  const long = 'word '.repeat(200).trim(); // 999 characters, well past the old 400 cap
  const feed = parseFeed(
    `<?xml version="1.0"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>Blog</title>
      <item><title>Short header</title><link>https://blog.example.test/a</link><guid>a</guid>
        <description>Read more</description>
        <content:encoded><![CDATA[${long}]]></content:encoded>
        <pubDate>Sat, 25 Oct 2026 10:00:00 GMT</pubDate></item>
      <item><title>Only content</title><link>https://blog.example.test/b</link><guid>b</guid>
        <content:encoded><![CDATA[Body without a description tag.]]></content:encoded>
        <pubDate>Sat, 25 Oct 2026 11:00:00 GMT</pubDate></item>
    </channel></rss>`,
    'https://blog.example.test/rss',
  );

  assert.equal(feed.items[0]?.summary?.length, 999, 'the longer body wins over the short description');
  assert.equal(feed.items[1]?.summary, 'Body without a description tag.', 'content:encoded alone is still the body');
});

test('M2 feed parser: an item with no title keeps its body instead of inventing a title from it', () => {
  const feed = parseFeed(
    `<?xml version="1.0"?><rss version="2.0"><channel><title>Blog</title>
      <item><link>https://blog.example.test/c</link><guid>c</guid>
        <description>${'a '.repeat(300)}</description>
        <pubDate>Sat, 25 Oct 2026 12:00:00 GMT</pubDate></item>
    </channel></rss>`,
    'https://blog.example.test/rss',
  );

  assert.equal(feed.items[0]?.title, '', 'no title is left empty rather than copied from the body');
  assert.equal(feed.items[0]?.summary?.length, 599, 'and a body past the old cap of 400 survives');
});

test('M2 feed parser: Atom entries', () => {
  const atom = `<?xml version="1.0"?>
    <feed xmlns="http://www.w3.org/2005/Atom">
      <title>Example Blog</title>
      <entry>
        <id>tag:example.com,2025:1</id>
        <title>Hello</title>
        <link rel="alternate" href="https://example.com/hello"/>
        <updated>2025-10-24T20:34:00Z</updated>
        <summary>Short text</summary>
      </entry>
    </feed>`;
  const feed = parseFeed(atom, 'https://example.com/');
  assert.equal(feed.title, 'Example Blog');
  assert.equal(feed.items[0]?.guid, 'tag:example.com,2025:1');
  assert.equal(feed.items[0]?.link, 'https://example.com/hello');
  assert.equal(feed.items[0]?.publishedAt, Date.parse('2025-10-24T20:34:00Z'));
});

test('M2 feed parser: an empty feed is E_NO_FEED, not a crash', () => {
  assert.throws(
    () => parseFeed('<rss><channel><title>empty</title></channel></rss>', 'https://example.com/'),
    (err) => err instanceof Coded && err.code === E.NO_FEED,
  );
});

test('M2 rsshub adapter: a cold route is given longer than the 20 s trusted-fetch default', async () => {
  let timeoutMs: number | undefined;
  const http: Http = async (url, options) => {
    timeoutMs = options.timeoutMs;
    return { status: 200, url, contentType: 'application/rss+xml', body: fixture };
  };

  const feed = await fetchRsshubFeed(http, {
    platform: 'instagram',
    canonicalUrl: 'https://instagram.com/evolving.ai',
    externalId: 'evolving.ai',
    feedUrl: 'http://rsshub.test/instagram/user/evolving.ai',
    strategy: 'rsshub',
  });

  assert.equal(feed.items.length, 7);
  assert.ok(
    (timeoutMs ?? 0) > 20_000 && (timeoutMs ?? 0) <= 120_000,
    'longer than the trusted-fetch default, and still bounded by the queue: the stale lock is 10 min',
  );
});

test('M2 feed parser: rel=alternate discovery picks the RSS link', () => {
  const html = '<html><head><link rel="alternate" type="application/rss+xml" href="/feed.xml"><link rel="stylesheet" href="/a.css"></head></html>';
  assert.equal(discoverAlternate(html, 'https://example.com/blog'), 'https://example.com/feed.xml');
  assert.equal(discoverAlternate('<html><head></head></html>', 'https://example.com'), null);
});

test('M2 feed parser: a discovered feed reports its URL and borrows the page avatar', async () => {
  const page =
    '<html><head><meta property="og:image" content="https://yt3.example.test/avatar"><link rel="alternate" type="application/rss+xml" href="https://www.youtube.com/feeds/videos.xml?channel_id=UCTEST"></head></html>';
  const feed = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Channel</title>
    <entry><id>yt:video:V1</id><title>One</title><link rel="alternate" href="https://www.youtube.com/shorts/V1"/></entry></feed>`;
  const http: Http = async (url) =>
    url.includes('/feeds/')
      ? { status: 200, url, contentType: 'application/atom+xml', body: feed }
      : { status: 200, url, contentType: 'text/html; charset=utf-8', body: page };

  const parsed = await fetchNativeFeed(http, { platform: 'youtube', canonicalUrl: 'https://youtube.com/@Channel', externalId: 'Channel', feedUrl: null, strategy: 'native_rss' });

  assert.equal(parsed.feedUrl, 'https://www.youtube.com/feeds/videos.xml?channel_id=UCTEST', 'stage 2 can store the feed it found');
  assert.equal(parsed.avatarUrl, 'https://yt3.example.test/avatar', 'the feed has no image, so the page lends its own');
  assert.equal(parsed.items[0]?.link, 'https://www.youtube.com/shorts/V1');
});

test('M2 feed parser: a caption keeps the paragraphs it was written in', () => {
  const rss =
    '<rss version="2.0"><channel><title>t</title><item><guid>g1</guid><link>https://example.com/1</link>' +
    '<title>Altman on RAM…</title><description><![CDATA[<p>Altman on RAM.</p><p>Then the podcast.</p><p>And the backlash.</p>]]></description>' +
    '</item></channel></rss>';
  const summary = parseFeed(rss, 'https://www.instagram.com/evolving.ai/').items[0]?.summary ?? '';

  assert.equal(summary, ['Altman on RAM.', 'Then the podcast.', 'And the backlash.'].join('\u000A\u000A'));
});

test('M20 parser: RSS 1.0 has no pubDate, so dc:date is the date', () => {
  const feed = parseFeed(file('rdf-dc.xml'), 'https://rdf.example.test/');

  assert.equal(feed.title, 'RDF Example');
  assert.equal(feed.items.length, 2, 'RDF items are read like RSS items');
  assert.equal(feed.items[0]?.publishedAt, Date.parse('2026-11-08T06:29:22+00:00'));
  assert.equal(feed.items[0]?.guid, 'https://rdf.example.test/a', 'no guid element, so the link identifies the post');
  assert.equal(feed.items[1]?.title, 'Second & last', 'entities decoded');
});

test('M20 parser: an Atom entry keeps its own page when rel=self comes first', () => {
  const feed = parseFeed(file('atom-multi-link.xml'), 'https://atom.example.test/feed.atom');

  assert.equal(feed.items[0]?.link, 'https://atom.example.test/entry/1', 'rel=alternate is the post, rel=self is the file');
  assert.equal(feed.items[0]?.guid, 'tag:atom.example.test,2026:1');
});

test('M20 parser: a captured Atom feed keeps title, link, date, body and categories', () => {
  const feed = parseFeed(file('atom-github.xml'), 'https://github.blog/feed/atom/');
  const item = feed.items[0];

  assert.equal(feed.title, 'The GitHub Blog');
  assert.ok(item, 'the entry is read');
  assert.match(item.link, /^https:\/\/github\.blog\//);
  assert.ok((item.categories ?? []).length > 0, 'term categories survive');
  assert.ok((item.summary ?? '').length > 0, 'the body survives');
  assert.notEqual(item.publishedAt, null, 'published is read');
});

test('M20 parser: a captured RSS 2.0 feed keeps its guid, thumbnail and date', () => {
  const feed = parseFeed(file('rss-wired.xml'), 'https://www.wired.com/feed/rss');
  const item = feed.items[0];

  assert.equal(feed.items.length, 50);
  assert.ok(item);
  assert.equal(item.guid, '6aecb024d52bfcd5eead0d31', 'the CMS id is the identity');
  assert.ok(item.media.some((entry) => entry.type === 'photo' && entry.url.startsWith('https://media.wired.com/')), 'media:thumbnail is a photo');
  assert.notEqual(item.publishedAt, null);
});

test('M20 parser: every media spelling reaches FeedItem, relative URLs resolved', () => {
  const feed = parseFeed(file('rss-mixed-media.xml'), 'https://media.example.test/feed');

  assert.deepEqual(feed.items[0]?.media, [
    { url: 'https://cdn.example.test/a.mp3', type: 'audio' },
    { url: 'https://media.example.test/img/b.jpg', type: 'photo' },
    { url: 'https://cdn.example.test/thumb.jpg', type: 'photo' },
  ]);
  assert.deepEqual(feed.items[1]?.media, [{ url: 'https://cdn.example.test/b.mp4', type: 'video' }]);
});

test('M20 parser: a page that is not a feed says so instead of "no items"', () => {
  assert.throws(
    () => parseFeed(file('malformed.xml'), 'https://site.example.test/feed'),
    (err: unknown) => err instanceof Coded && err.code === E.NO_FEED && /^not a feed: /.test(err.message),
    'an HTML error page is named as such',
  );
  assert.throws(
    () => parseFeed('<rss version="2.0"><channel><item>', 'https://site.example.test/feed'),
    (err: unknown) => err instanceof Coded && err.code === E.NO_FEED && err.message === 'feed has no readable items',
    'a truncated feed is a feed with nothing readable',
  );
});

test('M20 discovery: RDF and plain XML alternates are feeds, JSON is not', () => {
  assert.deepEqual(discoverAlternates(file('discovery.html'), 'https://blog.example.test/'), [
    'https://blog.example.test/feed.xml',
    'https://blog.example.test/index.rdf',
    'https://blog.example.test/plain.xml',
  ]);
});
