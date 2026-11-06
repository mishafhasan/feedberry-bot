/**
 * The channel behind a YouTube link. A watch page is far too heavy for the page budget (11 s here),
 * so the owner comes from the oEmbed card; a community post has no card and is read from its page.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Http } from '../../src/platform/http.ts';
import { youtubeChannelOf } from '../../src/platform/youtube-channel.ts';

const fake = (routes: Record<string, { status: number; body: string }>, seen: string[] = []): Http => async (url) => {
  seen.push(url);
  const hit = routes[url];
  if (hit === undefined) throw new Error(`unexpected fetch ${url}`);
  return { status: hit.status, url, contentType: 'application/json', body: hit.body };
};

const card = (author: string): string => JSON.stringify({ author_url: author, author_name: 'A Channel' });

test('youtube channel: the oEmbed card names the channel for a video, a Short and a youtu.be link', async () => {
  for (const link of ['https://www.youtube.com/watch?v=abc12345678', 'https://youtube.com/shorts/abc12345678', 'https://youtu.be/abc12345678']) {
    const seen: string[] = [];
    const channel = await youtubeChannelOf(fake({ [`https://www.youtube.com/oembed?url=${encodeURIComponent(link)}&format=json`]: { status: 200, body: card('https://www.youtube.com/@DWTamil') } }, seen), link);

    assert.deepEqual(channel, { url: 'https://www.youtube.com/@DWTamil', handle: 'DWTamil' });
    assert.equal(seen.length, 1, 'one small request, never the 1.3 MB page');
  }
});

test('youtube channel: a topic channel answers a channel URL, which carries no handle', async () => {
  const link = 'https://youtu.be/abc12345678';
  const channel = await youtubeChannelOf(
    fake({ [`https://www.youtube.com/oembed?url=${encodeURIComponent(link)}&format=json`]: { status: 200, body: card('https://www.youtube.com/channel/UCbRSywya_rl8YS15Lo9ttsA') } }),
    link,
  );

  assert.deepEqual(channel, { url: 'https://www.youtube.com/channel/UCbRSywya_rl8YS15Lo9ttsA', handle: null });
});

test('youtube channel: a community post has no card, so its own page names the channel', async () => {
  const link = 'https://youtube.com/post/UgkxGuBM_v4CJugE7V-Dns33VhSMVB0_UL_F';
  const seen: string[] = [];
  const channel = await youtubeChannelOf(
    fake({ 'https://www.youtube.com/post/UgkxGuBM_v4CJugE7V-Dns33VhSMVB0_UL_F': { status: 404, body: '' } }, seen),
    link,
  );

  assert.equal(channel, null, 'a post that cannot be read offers no channel');
  assert.ok(seen[0]?.endsWith('/post/UgkxGuBM_v4CJugE7V-Dns33VhSMVB0_UL_F'), 'the post page is what was asked for');
  assert.ok(!seen.some((url) => url.includes('oembed')), 'a post has no oEmbed card to try');
});

test('youtube channel: another platform, a failed card and a broken body never throw', async () => {
  const seen: string[] = [];
  assert.equal(await youtubeChannelOf(fake({}, seen), 'https://instagram.com/p/C1/'), null);
  assert.deepEqual(seen, [], 'no request leaves the bot for another platform');

  const link = 'https://youtu.be/abc12345678';
  const url = `https://www.youtube.com/oembed?url=${encodeURIComponent(link)}&format=json`;
  assert.equal(await youtubeChannelOf(fake({ [url]: { status: 404, body: '' } }), link), null);
  assert.equal(await youtubeChannelOf(fake({ [url]: { status: 200, body: 'not json' } }), link), null);
  assert.equal(await youtubeChannelOf(fake({ [url]: { status: 200, body: '{}' } }), link), null);
  assert.equal(await youtubeChannelOf(fake({}, []), 'nonsense'), null);
});
