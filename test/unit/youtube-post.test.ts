/**
 * The community-post parser against real captures of youtube.com/post/<id>. No network.
 * Each fixture keeps only the `ytInitialData` script of the page it was captured from.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Coded, E, isCoded } from '../../src/platform/errors.ts';
import type { Http } from '../../src/platform/http.ts';
import { fetchYouTubePost, parseYouTubePost } from '../../src/platform/feed/youtube-post.ts';

const evidence = (name: string): string => readFileSync(fileURLToPath(new URL(`../fixtures/youtube/${name}`, import.meta.url)), 'utf8');

const IMAGE = 'UgkxGuBM_v4CJugE7V-Dns33VhSMVB0_UL_F';
const MULTI = 'UgkxzJ6r7VLAK03TN5Gjq7YpjHmjtee_Rdn9';

const httpReturning = (status: number, body: string, seen: Array<{ url: string; headers?: Record<string, string> }> = []): Http =>
  async (url, options) => {
    seen.push({ url, headers: options.headers });
    return { status, url, contentType: 'text/html; charset=utf-8', body };
  };

test('youtube: a post link yields its channel, its words and its one photo', () => {
  const doc = parseYouTubePost(evidence('post-image.html'), IMAGE);
  assert.ok(doc, 'the post is in the document');
  assert.equal(doc.author, 'Ceylon Focus News', 'the channel title, not the handle');
  // The native feed route needs no RSSHub key, which is why the browseId is what gets offered.
  assert.deepEqual(doc.channel, { url: 'https://youtube.com/channel/UCHxWFaBKe7EuOlOX3DFDm-Q', handle: 'CeylonFocusNews' });
  assert.equal(doc.text.length, 725);
  assert.match(doc.text, /^ஈரானின்/);
  assert.equal(doc.media.length, 1, 'one photo');
  assert.match(doc.media[0] ?? '', /^https:\/\/yt3\.ggpht\.com\//);
  assert.match(doc.media[0] ?? '', /=s1600-/, 'the original, not the 230px preview');
});

test('youtube: an album keeps every image, in post order, at full size', () => {
  const doc = parseYouTubePost(evidence('post-multi-image.html'), MULTI);
  assert.ok(doc);
  assert.equal(doc.author, 'MrBeast');
  assert.equal(doc.media.length, 2);
  assert.match(doc.media[0] ?? '', /=s5464-/);
  assert.match(doc.media[1] ?? '', /=s1000-/);
  // The link the post spells out survives as text; YouTube wraps it in a redirect only on click.
  assert.match(doc.text, /themostdangerousgames\.com/);
});

test('youtube: an attached video becomes a link, never a download', () => {
  const doc = parseYouTubePost(evidence('post-video.html'), 'UgkxvMrKTpUbvqLPjv-lVi7N0wn68DV_NCBQ');
  assert.ok(doc);
  assert.deepEqual(doc.media, [], 'nothing to upload: a 25-minute video is not a caption');
  assert.match(doc.text, /🎬 MrBeast Lab Ep 1: Monster Invasion/);
  assert.match(doc.text, /https:\/\/youtu\.be\/tycyv2eoOaU$/);
});

test('youtube: a poll ships its question and every choice', () => {
  const doc = parseYouTubePost(evidence('post-poll.html'), 'UgkxZusu9I1Z-VuU5PGZNA2gclHi8V9CJVZk');
  assert.ok(doc);
  assert.deepEqual(doc.media, []);
  assert.match(doc.text, /Would you rather stop aging/);
  assert.match(doc.text, /📊 Poll\n• 100 Years Of No Aging\n• 1 Billion Dollars/);
});

test('youtube: no post data is a null document, never an empty post', () => {
  assert.equal(parseYouTubePost(evidence('post-unavailable.html'), 'UgkxTHIS_POST_DOES_NOT_EXIST_0000000000'), null);
  assert.equal(parseYouTubePost(evidence('post-image.html'), 'UgkSomeOtherPost'), null, 'a payload for another post is not this post');
  assert.equal(parseYouTubePost('<html><body>nope</body></html>', IMAGE), null);
  assert.equal(parseYouTubePost('<script>var ytInitialData = {broken};</script>', IMAGE), null);
});

test('youtube: the page is fetched on www with a browser-shaped accept (302s would drop headers)', async () => {
  const seen: Array<{ url: string; headers?: Record<string, string> }> = [];
  const doc = await fetchYouTubePost(httpReturning(200, evidence('post-image.html'), seen), `https://youtube.com/post/${IMAGE}`);

  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.url, `https://www.youtube.com/post/${IMAGE}`);
  assert.match(seen[0]?.headers?.accept ?? '', /text\/html/);
  assert.equal(doc.text.length, 725);
});

test('youtube: a removed post is a clean no-feed error, an unknown shape is link-invalid', async () => {
  await assert.rejects(
    () => fetchYouTubePost(httpReturning(404, evidence('post-unavailable.html')), 'https://youtube.com/post/Ugkxgone'),
    (err: unknown) => isCoded(err) && err.code === E.NO_FEED,
  );
  await assert.rejects(
    () => fetchYouTubePost(httpReturning(200, '<html>shell</html>'), 'https://youtube.com/post/Ugkxgone'),
    (err: unknown) => err instanceof Coded && err.code === E.NO_FEED,
  );
  await assert.rejects(
    () => fetchYouTubePost(httpReturning(200, evidence('post-image.html')), 'https://youtube.com/watch?v=dQw4w9WgXcQ'),
    (err: unknown) => isCoded(err) && err.code === E.LINK_INVALID,
  );
});
