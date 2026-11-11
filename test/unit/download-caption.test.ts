import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectSource, profileFromAuthor, profileOfPost } from '../../src/platform/registry.ts';
import { renderDownload } from '../../src/pipeline/render-post.ts';

const opts = { rsshubBase: 'http://rsshub.test', telegramBeta: false };
const photo = { path: 'work/media-photo', kind: 'photo' as const, size: 1024 };

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
  const caption = plan.kind === 'photo' ? plan.caption : '';

  assert.match(caption, /🌐 <a href="https:\/\/instagram\.com\/p\/C1xYz\/">cristiano<\/a> \| Instagram/, 'the header links the post under the account, and names the platform');
  assert.match(caption, /\n\nSunset over the bay$/, 'the post text is kept, not dropped');
});

test('Download caption: without an author the title stays the source and is not repeated', () => {
  const plan = renderDownload([photo], { title: 'Big Buck Bunny', artist: null, platform: 'youtube' }, 'https://youtu.be/abc');
  const caption = plan.kind === 'photo' ? plan.caption : '';

  assert.match(caption, />Big Buck Bunny<\/a> \| YouTube/);
  assert.doesNotMatch(caption, /\n\nBig Buck Bunny/, 'no duplicated title');
});

test('Download caption: a flattened numbered list gets its own lines back', () => {
  // What TikTok hands over: every item on one line, numbers glued to the previous sentence.
  const flat = '50 websites that feel like the internet’s hidden toolbox 1. http://unpaywall.org — Free research papers 2. http://openlibrary.org — Borrow books online 4. http://alternativeto.net — App alternatives';
  const plan = renderDownload([photo], { title: flat, artist: 'amanyahd', platform: 'tiktok' }, 'https://www.tiktok.com/@amanyahd/video/1');
  const caption = plan.kind === 'photo' ? plan.caption : '';

  assert.match(caption, /hidden toolbox\n1\. http:\/\/unpaywall\.org — Free research papers\n2\. http:\/\/openlibrary\.org/, 'one item per line');
  assert.doesNotMatch(caption, /papers 2\./, 'no number left glued to the previous item');
});

test('Download caption: prose with one numbered mention is left alone', () => {
  const prose = 'I tried 2. things today and none of them worked';
  const plan = renderDownload([photo], { title: prose, artist: 'someone', platform: 'tiktok' }, 'https://www.tiktok.com/@someone/video/2');
  const caption = plan.kind === 'photo' ? plan.caption : '';

  assert.ok(caption.endsWith(prose), 'the sentence keeps its shape');
});

test('Download caption: a words-only post keeps its text and its link', () => {
  const link = 'https://jacobwren.tumblr.com/post/802858401532116992';
  const plan = renderDownload([], { title: 'But AI can’t do your job.', artist: 'jacobwren', publishedAt: Date.UTC(2025, 11, 13, 22, 37), platform: 'tumblr' }, link);
  const text = plan.kind === 'link_only' ? plan.text : '';

  assert.equal(plan.kind, 'link_only', 'no media does not mean no post');
  assert.match(text, /🌐 <a href="[^"]+">jacobwren<\/a> \| Tumblr\n⏱️ Time: 12\/13 22:37/, 'same header + time as every other source');
  assert.ok(text.includes('But AI can’t do your job.'), 'the words survive');
  assert.ok(text.endsWith(link), 'and the post is one tap away');
});
