import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectSource, profileFromAuthor, profileOfPost } from '../../src/platform/registry.ts';
import { renderDownload } from '../../src/pipeline/s6-render.ts';

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
  const plan = renderDownload([photo], { title: 'Sunset over the bay', artist: 'cristiano' }, 'https://instagram.com/p/C1xYz/');
  const caption = plan.kind === 'photo' ? plan.caption : '';

  assert.match(caption, /🌐 <a href="https:\/\/instagram\.com\/p\/C1xYz\/">cristiano<\/a>/, 'the header links the post under the account');
  assert.match(caption, /\n\nSunset over the bay$/, 'the post text is kept, not dropped');
});

test('Download caption: without an author the title stays the source and is not repeated', () => {
  const plan = renderDownload([photo], { title: 'Big Buck Bunny', artist: null }, 'https://youtu.be/abc');
  const caption = plan.kind === 'photo' ? plan.caption : '';

  assert.match(caption, />Big Buck Bunny<\/a>/);
  assert.doesNotMatch(caption, /\n\nBig Buck Bunny/, 'no duplicated title');
});
