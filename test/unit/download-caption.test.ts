import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectSource, profileFromAuthor, profileOfPost } from '../../src/platform/registry.ts';
import { renderDownload } from '../../src/pipeline/render-post.ts';

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
  assert.match(htmlOf(plan), /<p>Sunset over the bay<\/p>/, 'the post text is kept, not dropped');
  assert.match(htmlOf(plan), /<tg-slideshow><img src="tg:\/\/photo\?id=m0"\/><\/tg-slideshow>/, 'the photo rides in the slideshow');
});

test('Download caption: without an author the title stays the source and is not repeated', () => {
  const plan = renderDownload([photo], { title: 'Big Buck Bunny', artist: null, platform: 'youtube' }, 'https://youtu.be/abc');

  assert.match(htmlOf(plan), />Big Buck Bunny<\/a> \| YouTube/);
  assert.doesNotMatch(htmlOf(plan), /<p>Big Buck Bunny<\/p>/, 'no duplicated title');
});

test('Download caption: a flattened numbered list becomes an ordered list', () => {
  // What TikTok hands over: every item on one line, numbers glued to the previous sentence.
  const flat = '50 websites that feel like the internet’s hidden toolbox 1. http://unpaywall.org — Free research papers 2. http://openlibrary.org — Borrow books online 4. http://alternativeto.net — App alternatives';
  const plan = renderDownload([photo], { title: flat, artist: 'amanyahd', platform: 'tiktok' }, 'https://www.tiktok.com/@amanyahd/video/1');

  assert.match(htmlOf(plan), /hidden toolbox<\/p><ol><li>/, 'the numbered entries start an ordered list');
  assert.match(htmlOf(plan), /unpaywall\.org[\s\S]*<\/li><li>[\s\S]*openlibrary\.org/, 'one list item per entry');
  assert.doesNotMatch(htmlOf(plan), /papers 2\./, 'no number left glued to the previous item');
});

test('Download caption: prose with one numbered mention is left alone', () => {
  const prose = 'I tried 2. things today and none of them worked';
  const plan = renderDownload([photo], { title: prose, artist: 'someone', platform: 'tiktok' }, 'https://www.tiktok.com/@someone/video/2');

  assert.ok(htmlOf(plan).includes(`<p>${prose}</p>`), 'the sentence keeps its shape');
});

test('Download caption: a words-only post keeps its text, still one rich message', () => {
  const link = 'https://jacobwren.tumblr.com/post/802858401532116992';
  const plan = renderDownload([], { title: 'But AI can’t do your job.', artist: 'jacobwren', publishedAt: Date.UTC(2025, 11, 13, 22, 37), platform: 'tumblr' }, link);

  assert.equal(plan.kind, 'rich', 'no media does not mean no post');
  assert.match(htmlOf(plan), /<a href="[^"]+">jacobwren<\/a> \| Tumblr<br\/>⏱️ Time: 13\/12 22:37/, 'same header + day-first time as every other source');
  assert.ok(htmlOf(plan).includes('But AI can’t do your job.'), 'the words survive');
  assert.doesNotMatch(htmlOf(plan), /<tg-slideshow>/, 'no media, no slideshow');
});