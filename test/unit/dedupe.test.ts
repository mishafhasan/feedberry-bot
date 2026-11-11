/**
 * One identity per post. A guid can be re-issued with a cache-busting tail, but a WordPress `?p=`
 * guid *is* the post id: dropping the query makes every post on the blog the same post.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FeedItem } from '../../src/platform/feed/native.ts';
import { normalizeGuid, uniqueItems } from '../../src/pipeline/dedupe.ts';

function item(guid: string, link = `https://blog.test/${guid.replace(/\W+/g, '-')}`): FeedItem {
  return { guid, link, title: guid, summary: null, publishedAt: 1_700_000_000_000, media: [], categories: [] };
}

test('dedupe: WordPress ?p= guids stay distinct posts', () => {
  const items = [item('https://www.sammobile.com/?p=16687997'), item('https://www.sammobile.com/?p=16687936')];
  assert.notEqual(normalizeGuid(items[0]!.guid), normalizeGuid(items[1]!.guid));
  assert.equal(uniqueItems(items).length, 2, 'two posts, not one');
});

test('dedupe: a cache-busting tail still collapses to one identity', () => {
  const items = [item('https://blog.test/post-1?utm_source=rss&utm_campaign=daily'), item('https://blog.test/post-1#comments')];
  assert.equal(uniqueItems(items).length, 1);
});

test('dedupe: a non-URL guid is compared as written', () => {
  assert.equal(normalizeGuid(' Tag:blogger.com,1999:post-42 '), 'tag:blogger.com,1999:post-42');
});
