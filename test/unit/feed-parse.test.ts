import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Coded, E } from '../../src/platform/errors.ts';
import { parseFeed, discoverAlternate } from '../../src/platform/feed/native.ts';

const fixture = readFileSync(new URL('../fixtures/ig-profile.rss', import.meta.url), 'utf8');

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

test('M2 feed parser: rel=alternate discovery picks the RSS link', () => {
  const html = '<html><head><link rel="alternate" type="application/rss+xml" href="/feed.xml"><link rel="stylesheet" href="/a.css"></head></html>';
  assert.equal(discoverAlternate(html, 'https://example.com/blog'), 'https://example.com/feed.xml');
  assert.equal(discoverAlternate('<html><head></head></html>', 'https://example.com'), null);
});
