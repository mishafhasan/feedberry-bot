/**
 * ADR-031: a feed that publishes its own domain as `<channel><title>` names no source, so two category
 * feeds of one site would read the same. The name must come from the host and the feed's own path —
 * and never from the file name the feed URL ends in.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { feedSourceTitle } from '../../src/bot/texts.ts';

test('M31 source name: a domain title is replaced by the site and its category', () => {
  assert.equal(feedSourceTitle('www.dailymirror.lk', 'https://dailymirror.lk/rss/breaking_news/108', null), 'Dailymirror · Breaking News');
  assert.equal(feedSourceTitle('www.dailymirror.lk', 'https://dailymirror.lk/rss/top_story/155', null), 'Dailymirror · Top Story');
  assert.equal(feedSourceTitle('dailymirror.lk', 'https://dailymirror.lk/top-stories/155', '/top-stories/155'), 'Dailymirror · Top Stories');
});

test('M31 source name: a real feed title is kept as it is', () => {
  assert.equal(feedSourceTitle('Daily Mirror - Breaking News', 'https://dailymirror.lk/rss/breaking_news/108', null), 'Daily Mirror - Breaking News');
  assert.equal(feedSourceTitle('Wired', 'https://wired.com/category/science', '/category/science'), 'Wired · Science');
});

test('M31 source name: the feed file itself never becomes the category', () => {
  assert.equal(feedSourceTitle(null, 'https://www.theverge.com/rss/index.xml', null), 'Theverge', 'no "Index.xml"');
  assert.equal(feedSourceTitle(null, 'https://example.com/feed.xml', null), 'Example');
  assert.equal(feedSourceTitle(null, 'https://feeds.bbci.co.uk/news/world/rss.xml', null), 'Bbci · World', 'a feed host is not the name');
});

test('M31 source name: a platform source is named by its handle, never by its host', () => {
  assert.equal(feedSourceTitle(null, 'https://instagram.com/creator', null, 'creator'), 'creator', 'the handle, not "Instagram · Creator"');
  assert.equal(feedSourceTitle(null, 'https://youtube.com/@MrBeast', null, 'MrBeast'), 'MrBeast');
  assert.equal(feedSourceTitle('MrBeast', 'https://youtube.com/@MrBeast', null, 'MrBeast'), 'MrBeast');
});
