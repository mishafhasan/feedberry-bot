/**
 * Stage 2 fetches only what the selection needs. A channel whose uploads feed is empty or gone must
 * still be addable for its Posts alone — that is the add that used to fail with E_NO_FEED — and when
 * YouTube closes feeds/videos.xml to a busy IP the RSSHub route has to cover the gap.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Coded, E, isCoded } from '../../src/platform/errors.ts';
import type { Http } from '../../src/platform/http.ts';
import type { SourceRef } from '../../src/platform/registry.ts';
import { fetchSourceFeed } from '../../src/pipeline/s2-feed.ts';

const RSSHUB = 'http://rsshub.test';
const FEED = 'https://www.youtube.com/feeds/videos.xml?channel_id=UCTEST000000000000000000';
const TAB = 'https://youtube.com/@Channel/posts';
const BY_ID = `${RSSHUB}/youtube/channel/UCTEST000000000000000000`;
const BY_HANDLE = `${RSSHUB}/youtube/user/@Channel`;
const PAGE = `<html><head><link rel="alternate" type="application/rss+xml" href="${FEED}"></head></html>`;

const channel: SourceRef = { platform: 'youtube', canonicalUrl: 'https://youtube.com/@Channel', externalId: 'Channel', feedUrl: FEED, strategy: 'native_rss' };
/** A handle link before any discovery: it has to read the page to learn its own feed. */
const undiscovered: SourceRef = { ...channel, feedUrl: null };

const UPLOADS = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>Channel</title>
  <entry><id>yt:video:V1</id><title>One</title><link rel="alternate" href="https://www.youtube.com/watch?v=V1"/></entry>
</feed>`;

const TAB_PAGE = `<script>var ytInitialData = ${JSON.stringify({
  contents: [{ backstagePostRenderer: { postId: 'UgkxONE', contentText: { runs: [{ text: 'From the tab' }] }, publishedTimeText: { runs: [{ text: '2 hours ago' }] } } }],
})};</script>`;

/** Every request is recorded, so a feed the selection does not need must not appear at all. */
function source(routes: Record<string, { status: number; body: string }>, seen: string[]): Http {
  return async (url) => {
    seen.push(url);
    const hit = routes[url];
    if (hit === undefined) throw new Coded(E.NO_FEED, `feed replied 404 (${url})`);
    return { status: hit.status, url, contentType: url.includes('/feeds/') ? 'application/atom+xml' : 'text/html', body: hit.body };
  };
}

test('source feed: Posts only never touches the uploads feed', async () => {
  const seen: string[] = [];
  const feed = await fetchSourceFeed(source({ [TAB]: { status: 200, body: TAB_PAGE } }, seen), channel, ['post'], RSSHUB);

  assert.deepEqual(seen, [TAB], 'the uploads feed was not requested at all');
  assert.deepEqual(feed.items.map((item) => item.guid), ['UgkxONE']);
});

test('source feed: Posts only surfaces a failing tab instead of pretending the channel is empty', async () => {
  const seen: string[] = [];
  await assert.rejects(
    () => fetchSourceFeed(source({}, seen), channel, ['post'], RSSHUB),
    (err: unknown) => isCoded(err) && err.code === E.NO_FEED,
  );
  assert.deepEqual(seen, [TAB], 'the uploads feed is still not the thing that failed');
});

test('source feed: videos only never touches the Posts tab', async () => {
  const seen: string[] = [];
  const feed = await fetchSourceFeed(source({ [FEED]: { status: 200, body: UPLOADS } }, seen), channel, ['video'], RSSHUB);

  assert.deepEqual(seen, [FEED], 'the native feed answered, so nothing else was tried');
  assert.equal(feed.items.length, 1);
});

test('source feed: a refused native feed falls back to the RSSHub channel route', async () => {
  const seen: string[] = [];
  const feed = await fetchSourceFeed(source({ [BY_ID]: { status: 200, body: UPLOADS } }, seen), channel, ['video'], RSSHUB);

  assert.deepEqual(seen, [FEED, BY_ID], 'native first, then the route that scrapes the pages');
  assert.equal(feed.items.length, 1);
  assert.equal(feed.feedUrl, null, 'nothing new was discovered, so nothing is stored');
});

test('source feed: a handle keeps the feed its page named, even when that feed refuses', async () => {
  const seen: string[] = [];
  const feed = await fetchSourceFeed(source({ [channel.canonicalUrl]: { status: 200, body: PAGE }, [BY_ID]: { status: 200, body: UPLOADS } }, seen), undiscovered, ['video'], RSSHUB);

  assert.deepEqual(seen, [channel.canonicalUrl, FEED, BY_ID], 'the page is read once, then its own feed, then the fallback');
  assert.equal(feed.feedUrl, FEED, 'the discovered feed is stored, so the next check skips the page');
  assert.equal(feed.items.length, 1);
});

test('source feed: a page that names no feed falls back by handle', async () => {
  const seen: string[] = [];
  const feed = await fetchSourceFeed(source({ [channel.canonicalUrl]: { status: 200, body: '<html><head></head></html>' }, [BY_HANDLE]: { status: 200, body: UPLOADS } }, seen), undiscovered, ['video'], RSSHUB);

  assert.ok(seen.includes(BY_HANDLE), 'the @ is what makes RSSHub read the handle instead of a legacy name');
  assert.equal(feed.feedUrl, null, 'no feed was named, so nothing is stored');
});

test('source feed: a Shorts-only chat keeps the honest error instead of a flattened fallback', async () => {
  const seen: string[] = [];
  await assert.rejects(
    () => fetchSourceFeed(source({ [BY_ID]: { status: 200, body: UPLOADS } }, seen), channel, ['short'], RSSHUB),
    (err: unknown) => isCoded(err) && err.code === E.NO_FEED,
  );
  assert.deepEqual(seen, [FEED], 'RSSHub flattens Shorts into videos, so it was not asked');
});

test('source feed: a channel-id source falls back to the channel route', async () => {
  const seen: string[] = [];
  const byId: SourceRef = { ...channel, canonicalUrl: 'https://youtube.com/channel/UCTEST000000000000000000', externalId: 'UCTEST000000000000000000' };
  await fetchSourceFeed(source({ [BY_ID]: { status: 200, body: UPLOADS } }, seen), byId, ['video'], RSSHUB);

  assert.ok(seen.includes(BY_ID));
});

test('source feed: a mixed selection keeps the uploads when the tab fails', async () => {
  const feed = await fetchSourceFeed(source({ [FEED]: { status: 200, body: UPLOADS } }, []), channel, ['video', 'post'], RSSHUB);
  assert.deepEqual(feed.items.map((item) => item.guid).length, 1, 'the uploads feed still answers');
});

test('source feed: everything (a row from before the picker) reads both feeds', async () => {
  const feed = await fetchSourceFeed(source({ [FEED]: { status: 200, body: UPLOADS }, [TAB]: { status: 200, body: TAB_PAGE } }, []), channel, null, RSSHUB);
  assert.deepEqual(feed.items.map((item) => item.guid).sort(), ['UgkxONE', 'yt:video:V1']);
});

test('source feed: another platform ignores the selection and the fallback', async () => {
  const seen: string[] = [];
  const blog: SourceRef = { platform: 'rss', canonicalUrl: 'https://blog.example.test', externalId: 'blog', feedUrl: 'https://blog.example.test/rss', strategy: 'native_rss' };
  await fetchSourceFeed(source({ 'https://blog.example.test/rss': { status: 200, body: UPLOADS } }, seen), blog, ['post'], RSSHUB);

  assert.deepEqual(seen, ['https://blog.example.test/rss'], 'no tab and no RSSHub route for a non-YouTube source');
});
