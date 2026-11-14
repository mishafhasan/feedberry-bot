/**
 * §8.1 R15: every non-RSS post labels the video it cannot send — `🎬 Video 1` as the link itself,
 * never a raw URL as visible text. One rule, every platform the rich layout serves.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PostRow } from '../../src/db/repos/posts.ts';
import { renderDownload, renderPost } from '../../src/pipeline/render-post.ts';
import type { MediaFile } from '../../src/render/message-plan.ts';

const DIRECT = 'https://video.twimg.com/amplify_video/1/vid/avc1/1280x720/clip.mp4?tag=29';
const SECOND = 'https://cdn.test/second.mp4';
const LINK = `🎬 <a href="${DIRECT}">Video 1</a>`;
const POST = 'https://social.example.test/p/1';

const post: PostRow = {
  id: 1,
  source_id: 1,
  guid: 'g',
  url: POST,
  published_at: Date.UTC(2026, 10, 10, 16, 7),
  kind: 'video',
  payload_json: JSON.stringify({ title: 'A post', summary: null, media: [] }),
  first_seen_at: 0,
};

/** Every platform that takes the rich layout, including the two whose clips live on a page. */
const PLATFORMS = ['x', 'instagram', 'tiktok', 'youtube', 'tumblr', 'facebook', 'bluesky', 'snapchat', 'pinterest'];

const linked = (url: string, extra: Partial<MediaFile> = {}): MediaFile => ({ path: '', kind: 'video', size: 0, url, ...extra });
const htmlOf = (plan: ReturnType<typeof renderPost>): string => (plan.kind === 'rich' ? plan.html : '');

test('R15: a video that cannot upload is one labelled link on every rich platform', () => {
  for (const platform of PLATFORMS) {
    const html = htmlOf(renderPost(post, 'video', [linked(DIRECT)], { platform, sourceTitle: '@who' }));

    assert.ok(html.includes(`<p>${LINK}</p>`), `${platform} prints the label line:\n${html}`);
    assert.doesNotMatch(html, /<p>[^<]*https?:\/\//, `${platform} never opens a line with a bare URL`);
  }
});

test('R15: two linked videos are numbered in post order', () => {
  const html = htmlOf(renderPost(post, 'album', [linked(DIRECT), linked(SECOND)], { platform: 'instagram', sourceTitle: '@who' }));

  assert.ok(html.includes(`<p>${LINK}<br/>🎬 <a href="${SECOND}">Video 2</a></p>`), `each clip keeps its own number:\n${html}`);
});

test('R15: Download Mode labels the same clip the same way', () => {
  const html = htmlOf(renderDownload([linked(DIRECT)], { title: 'A post', artist: '@who', publishedAt: post.published_at, platform: 'x' }, POST));

  assert.ok(html.includes(`<p>${LINK}</p>`), `the download path prints one label too:\n${html}`);
});

test('ADR-028: a body that repeats the media URL keeps only the label', () => {
  const withUrl = { ...post, payload_json: JSON.stringify({ title: `Watch this ${DIRECT}`, summary: null, media: [] }) };
  const html = htmlOf(renderPost(withUrl, 'video', [linked(DIRECT)], { platform: 'x', sourceTitle: '@who' }));

  assert.equal((html.match(/video\.twimg\.com/g) ?? []).length, 1, 'the URL survives once, inside the label href');
  assert.ok(html.includes(`<p>${LINK}</p>`), 'and the label is what the reader sees');
  assert.ok(html.includes('Watch this'), 'the words keep their shape');
  assert.doesNotMatch(html, />https?:\/\//, 'no raw URL as visible text');
});

test('ADR-027: the clip\'s poster rides in the same message as its label', () => {
  const files: MediaFile[] = [linked(DIRECT), { path: 'poster.jpg', kind: 'photo', size: 2048, url: 'https://cdn.test/poster.jpg' }];
  const html = htmlOf(renderPost(post, 'video', files, { platform: 'x', sourceTitle: '@who' }));

  assert.ok(html.includes('<tg-slideshow><img src="tg://photo?id=m0"/></tg-slideshow>'), `the poster is the slideshow:\n${html}`);
  assert.ok(html.includes(`<p>${LINK}</p>`), 'and the file stays one tap away');
  const schedule = renderPost(post, 'video', files, { platform: 'x', sourceTitle: '@who' });
  const download = renderDownload(files, { title: 'A post', artist: '@who', publishedAt: post.published_at, platform: 'x' }, POST);
  assert.deepEqual(download, schedule, 'both doors render the poster and the label identically');
});
