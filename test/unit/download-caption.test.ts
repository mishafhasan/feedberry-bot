import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PostRow } from '../../src/db/repos/posts.ts';
import { detectSource, profileFromAuthor, profileOfPost } from '../../src/platform/registry.ts';
import { renderDownload, renderPost } from '../../src/pipeline/render-post.ts';
import type { MediaFile } from '../../src/render/message-plan.ts';

const opts = { rsshubBase: 'http://rsshub.test', telegramBeta: false };
const photo = { path: 'work/media-photo', kind: 'photo' as const, size: 1024 };
const htmlOf = (plan: ReturnType<typeof renderDownload>): string => (plan.kind === 'rich' ? plan.html : '');

test('Instagram post links: the owner comes from the URL, or from the download', () => {
  const share = 'https://www.instagram.com/cristiano/p/C1xYz/';

  assert.equal(detectSource(share, opts).strategy, 'single_post', 'a web share link is one post, not a profile');
  assert.equal(profileOfPost(share), 'https://instagram.com/cristiano');
  assert.equal(profileOfPost('https://instagram.com/p/C1xYz/'), null, 'a bare short link does not name the owner');
  assert.equal(profileFromAuthor('instagram', '@cristiano'), 'https://instagram.com/cristiano');
  assert.equal(profileFromAuthor('x', 'cristiano'), null, 'x has no profile feed (ADR-017)');
});

test('Download caption: the account names the source and the post text follows it', () => {
  const plan = renderDownload([photo], { title: 'Sunset over the bay', artist: 'cristiano', platform: 'instagram' }, 'https://instagram.com/p/C1xYz/');

  assert.equal(plan.kind, 'rich', 'one rich message per post (ADR-023)');
  assert.match(htmlOf(plan), /<a href="https:\/\/instagram\.com\/p\/C1xYz\/">cristiano<\/a> \| Instagram/, 'the header links the post under the account, and names the platform');
  assert.match(htmlOf(plan), /<blockquote expandable>Sunset over the bay<\/blockquote>/, 'the post text is kept, not dropped');
  assert.match(htmlOf(plan), /<tg-slideshow><img src="tg:\/\/photo\?id=m0"\/><\/tg-slideshow>/, 'the photo rides in the slideshow');
});

test('Download caption: without an author the title stays the source and is not repeated', () => {
  const plan = renderDownload([photo], { title: 'Big Buck Bunny', artist: null, platform: 'youtube' }, 'https://youtu.be/abc');

  assert.match(htmlOf(plan), />Big Buck Bunny<\/a> \| YouTube/);
  assert.doesNotMatch(htmlOf(plan), /<blockquote/, 'no duplicated title');
});

test('Download caption: a flattened numbered list keeps its numbers on their own lines', () => {
  // What TikTok hands over: every item on one line, numbers glued to the previous sentence.
  const flat = '50 websites that feel like the internet’s hidden toolbox 1. http://unpaywall.org — Free research papers 2. http://openlibrary.org — Borrow books online 4. http://alternativeto.net — App alternatives';
  const plan = renderDownload([photo], { title: flat, artist: 'amanyahd', platform: 'tiktok' }, 'https://www.tiktok.com/@amanyahd/video/1');

  assert.match(htmlOf(plan), /hidden toolbox<br\/>1\. <a href="http:\/\/unpaywall\.org">/, 'the numbered entries start their own lines');
  assert.doesNotMatch(htmlOf(plan), /papers 2\./, 'no number left glued to the previous item');
});

test('Download caption: prose with one numbered mention is left alone', () => {
  const prose = 'I tried 2. things today and none of them worked';
  const plan = renderDownload([photo], { title: prose, artist: 'someone', platform: 'tiktok' }, 'https://www.tiktok.com/@someone/video/2');

  assert.ok(htmlOf(plan).includes(prose), 'the sentence keeps its shape');
});

test('Download caption: a words-only post keeps its text, still one rich message', () => {
  const link = 'https://jacobwren.tumblr.com/post/802858401532116992';
  const plan = renderDownload([], { title: 'But AI can’t do your job.', artist: 'jacobwren', publishedAt: Date.UTC(2025, 11, 13, 22, 37), platform: 'tumblr' }, link);

  assert.equal(plan.kind, 'rich', 'no media does not mean no post');
  assert.match(htmlOf(plan), /<a href="[^"]+">jacobwren<\/a> \| Tumblr<\/h5><p>⏱️ <b>Time<\/b>: 13\/12 22:37<\/p>/, 'same h5 heading + day-first time as every other source');
  assert.ok(htmlOf(plan).includes('But AI can’t do your job.'), 'the words survive');
  assert.doesNotMatch(htmlOf(plan), /<tg-slideshow>/, 'no media, no slideshow');
});

/** The same post as the scheduler stamps it; Download Mode only ever has its words and its link. */
const row = (title: string): PostRow => ({
  id: 9,
  source_id: 1,
  guid: 'guid',
  url: 'https://instagram.com/p/C1xYz/',
  published_at: Date.UTC(2025, 11, 13, 22, 37),
  kind: 'video',
  payload_json: JSON.stringify({ title, summary: null, media: [] }),
  first_seen_at: 0,
});

const LARGE: MediaFile = { path: '', kind: 'video', size: 0, url: 'https://cdn.test/large.mp4' };

test('Rich layout: a lone clip renders the same in Download Mode as on the scheduled path', () => {
  const files: MediaFile[] = [{ path: 'v.mp4', kind: 'video', size: 20 * 1024 * 1024, url: 'https://cdn.test/v.mp4' }, LARGE];
  const scheduled = renderPost(row('A clip'), 'video', files, { platform: 'instagram', sourceTitle: 'cristiano', tz: 'Asia/Dhaka' });
  const download = renderDownload(files, { title: 'A clip', artist: 'cristiano', publishedAt: Date.UTC(2025, 11, 13, 22, 37), platform: 'instagram', tz: 'Asia/Dhaka' }, 'https://instagram.com/p/C1xYz/');

  assert.deepEqual(download, scheduled, 'one layout, whichever door the post came through');
});

test('Rich layout: a mixed album renders the same in Download Mode as on the scheduled path', () => {
  const files: MediaFile[] = [
    { path: 'i1.jpg', kind: 'photo', size: 2048, url: 'https://cdn.test/i1.jpg' },
    { path: 'v1.mp4', kind: 'video', size: 20 * 1024 * 1024, url: 'https://cdn.test/v1.mp4' },
    LARGE,
  ];
  const scheduled = renderPost(row('Three things'), 'album', files, { platform: 'instagram', sourceTitle: 'cristiano', tz: 'UTC' });
  const download = renderDownload(files, { title: 'Three things', artist: 'cristiano', publishedAt: Date.UTC(2025, 11, 13, 22, 37), platform: 'instagram', tz: 'UTC' }, 'https://instagram.com/p/C1xYz/');

  assert.deepEqual(download, scheduled);
});