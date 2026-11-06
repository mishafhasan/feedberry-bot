/**
 * One channel, three kinds of post, one choice per chat. The rules are pure so the picker, the
 * preview and the delivery filter all read the same answer.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allowsContent, filterByContentTypes, formatContentTypes, parseContentTypes, youtubeKindOf } from '../../src/platform/content-types.ts';

test('content types: every YouTube permalink shape lands on one kind', () => {
  assert.equal(youtubeKindOf('https://youtube.com/watch?v=dQw4w9WgXcQ'), 'video');
  assert.equal(youtubeKindOf('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s'), 'video');
  assert.equal(youtubeKindOf('https://youtu.be/qqb3zbTFON0?si=OZjNynEkhymg0G3u'), 'video');
  assert.equal(youtubeKindOf('https://m.youtube.com/watch?v=dQw4w9WgXcQ'), 'video');
  assert.equal(youtubeKindOf('https://www.youtube.com/live/abc123'), 'video');
  assert.equal(youtubeKindOf('https://youtube.com/shorts/ccIE0DwsH4I?si=RIOFlxJwTiwsKDf-'), 'short');
  assert.equal(youtubeKindOf('https://www.youtube.com/post/UgkxGuBM_v4CJugE7V-Dns33VhSMVB0_UL_F'), 'post');
  // A channel names no kind, and neither does another platform's post.
  assert.equal(youtubeKindOf('https://youtube.com/@MrBeast'), null);
  assert.equal(youtubeKindOf('https://instagram.com/p/C1/'), null);
  assert.equal(youtubeKindOf('not a url'), null);
  assert.equal(youtubeKindOf(null), null);
});

test('content types: a stored row round-trips in the picker order, and an empty row means everything', () => {
  assert.equal(formatContentTypes(['post', 'video']), 'video,post');
  assert.deepEqual(parseContentTypes('video,post'), ['video', 'post']);
  assert.deepEqual(parseContentTypes('short'), ['short']);
  assert.deepEqual(parseContentTypes('video,video'), ['video'], 'a repeated kind is one kind');
  assert.equal(parseContentTypes(null), null, 'a row from before the picker keeps every kind');
  assert.equal(parseContentTypes(''), null);
  assert.equal(parseContentTypes('nonsense'), null, 'a forged value cannot switch a chat off');
});

test('content types: a filter never hides a post it cannot classify', () => {
  assert.equal(allowsContent(null, 'video'), true, 'no choice means everything');
  assert.equal(allowsContent(['short'], null), true, 'a channel link is not a post');
  assert.equal(allowsContent(['short'], 'short'), true);
  assert.equal(allowsContent(['short'], 'video'), false);
  assert.equal(allowsContent([], 'video'), false, 'nothing picked is nothing sent');
});

test('content types: the preview keeps only the chosen kinds, and only for YouTube', () => {
  const items = [
    { guid: '1', link: 'https://youtube.com/watch?v=VID', title: 'v', publishedAt: null, summary: null, media: [] },
    { guid: '2', link: 'https://youtube.com/shorts/SHORT', title: 's', publishedAt: null, summary: null, media: [] },
    { guid: '3', link: 'https://youtube.com/post/POST', title: 'p', publishedAt: null, summary: null, media: [] },
  ];

  assert.deepEqual(filterByContentTypes('youtube', items, ['video']).map((item) => item.guid), ['1']);
  assert.deepEqual(filterByContentTypes('youtube', items, ['short', 'post']).map((item) => item.guid), ['2', '3']);
  assert.equal(filterByContentTypes('youtube', items, null).length, 3);
  assert.equal(filterByContentTypes('instagram', items, ['video']).length, 3, 'another platform has nothing to filter');
});
