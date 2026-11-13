/** ADR-025: every non-RSS post is one rich message — heading, time, slideshow, words, big-video links. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PostRow } from '../../src/db/repos/posts.ts';
import { renderPost } from '../../src/pipeline/render-post.ts';
import { RICH_TEXT_LIMIT, type MediaFile } from '../../src/render/message-plan.ts';

const post = (summary: string): PostRow => ({
  id: 1,
  source_id: 1,
  guid: 'g',
  url: 'https://www.instagram.com/p/DfJ2075AGx3/',
  published_at: Date.UTC(2026, 10, 1, 4, 1),
  kind: 'photo',
  payload_json: JSON.stringify({ title: '', summary, media: [] }),
  first_seen_at: 0,
});
const extras = { platform: 'instagram', sourceTitle: 'Evolving AI' };
const photo = (path = 'a.jpg'): MediaFile => ({ path, kind: 'photo', size: 1024 });
const rich = (summary: string, files: MediaFile[]) => {
  const plan = renderPost(post(summary), 'album', files, extras);
  assert.equal(plan.kind, 'rich');
  return plan.kind === 'rich' ? plan : { html: '', media: [] };
};

/** The header every rich post opens with: an h5 source line, then the bold DD/MM HH:MM time line. */
const HEADER = /^<h5><tg-emoji emoji-id="\d+">📸<\/tg-emoji> <a href="https:\/\/www\.instagram\.com\/p\/DfJ2075AGx3\/">Evolving AI<\/a> \| Instagram<\/h5><p>⏱️ <b>Time<\/b>: 01\/11 04:01<\/p>/;

test('rich: h5 heading + time, slideshow ref, and the whole body in one framed quote', () => {
  const plan = rich('Hello world', [photo()]);
  assert.match(plan.html, HEADER);
  assert.match(plan.html, /<tg-slideshow><img src="tg:\/\/photo\?id=m0"\/><\/tg-slideshow>/);
  assert.match(plan.html, /<hr\/><blockquote expandable>Hello world<\/blockquote><hr\/>$/);
  assert.deepEqual(plan.media, [{ id: 'm0', file: 'a.jpg', kind: 'photo' }]);
});

test('rich: line breaks stay <br/>, a blank line is the only paragraph gap, source values are escaped', () => {
  const plan = rich('line one\nline two\n\na < b & c > d', []);
  assert.match(plan.html, /<blockquote expandable>line one<br\/>line two<br\/><br\/>a &lt; b &amp; c &gt; d<\/blockquote>/);
});

test('rich: no media still ships header + time + the quoted body, no slideshow', () => {
  const plan = rich('words only', []);
  assert.doesNotMatch(plan.html, /<tg-slideshow>/);
  assert.deepEqual(plan.media, []);
  assert.match(plan.html, /<hr\/><blockquote expandable>words only<\/blockquote><hr\/>$/);
});

test('rich: a post with no words ships no empty quote, and no rules around nothing', () => {
  const plan = rich('   ', [photo()]);
  assert.doesNotMatch(plan.html, /<blockquote/);
  assert.doesNotMatch(plan.html, /<hr\/>/, 'a rule would frame an empty space');
  assert.match(plan.html, /<tg-slideshow>/, 'the media still goes out');
});

test('rich: audio stands as its own block, never inside the slideshow', () => {
  const plan = rich('a song', [{ path: 's.mp3', kind: 'audio', size: 1024 }, photo()]);
  assert.match(plan.html, /<tg-slideshow><img src="tg:\/\/photo\?id=m1"\/><\/tg-slideshow>/);
  assert.match(plan.html, /<audio src="tg:\/\/audio\?id=m0"><\/audio>/);
  const slide = plan.html.match(/<tg-slideshow>.*?<\/tg-slideshow>/)?.[0] ?? '';
  assert.ok(!slide.includes('<audio'), 'no audio inside the slideshow');
  assert.deepEqual(plan.media.map((m) => m.kind), ['audio', 'photo']);
});

test('rich: a video over 50 MB never uploads, it keeps a labelled link', () => {
  const big = 'https://cdn.test/big.mp4';
  const plan = rich('clip', [photo(), { path: 'big.mp4', kind: 'video', size: 51 * 1024 * 1024, url: big }]);
  assert.deepEqual(plan.media.map((m) => m.file), ['a.jpg']);
  assert.match(plan.html, /<p>🎬 <a href="https:\/\/cdn\.test\/big\.mp4">Video 1<\/a><\/p>$/);
});

test('rich: a failed download keeps its link, two big clips get their own numbers', () => {
  const plan = rich('clips', [
    { path: '', kind: 'video', size: 0, url: 'https://cdn.test/v1.mp4' },
    { path: 'v2.mp4', kind: 'video', size: 51 * 1024 * 1024, url: 'https://cdn.test/v2.mp4' },
  ]);
  assert.deepEqual(plan.media, []);
  assert.match(plan.html, /<p>🎬 <a href="https:\/\/cdn\.test\/v1\.mp4">Video 1<\/a><br\/>🎬 <a href="https:\/\/cdn\.test\/v2\.mp4">Video 2<\/a><\/p>$/);
});

test('rich: a video that fits rides in the slideshow as a video ref', () => {
  const plan = rich('clip', [{ path: 'v.mp4', kind: 'video', size: 1024 }]);
  assert.match(plan.html, /<tg-slideshow><video src="tg:\/\/video\?id=m0"><\/video><\/tg-slideshow>/);
  assert.deepEqual(plan.media, [{ id: 'm0', file: 'v.mp4', kind: 'video' }]);
});

test('rich: media past the 50-attachment ceiling is dropped', () => {
  const files = Array.from({ length: 55 }, (_, i) => photo(`p${i}.jpg`));
  const plan = rich('many', files);
  assert.equal(plan.media.length, 50);
  assert.match(plan.html, /tg:\/\/photo\?id=m49/);
  assert.doesNotMatch(plan.html, /id=m50/);
});

test('rich: a body over 32,768 chars is clamped at a word boundary with an ellipsis', () => {
  const plan = rich('word '.repeat(7000).trim(), []);
  assert.ok(plan.html.length <= RICH_TEXT_LIMIT, `html is ${plan.html.length} chars`);
  assert.match(plan.html, /…<\/blockquote><hr\/>$/, 'the ellipsis closes the folded text');
});

test('rich: an RSS post keeps the classic layout, never rich', () => {
  const plan = renderPost(post('body'), 'photo', [photo()], { platform: 'rss', sourceTitle: 'My Blog' });
  assert.equal(plan.kind, 'photo');
});

test('rich: the whole post sits in the quote, so the client fold is the only preview', () => {
  const paragraphs = [1, 2, 3, 4, 5, 6].map((n) => `Para ${n}: ${'word '.repeat(20).trim()}`);
  const plan = rich(paragraphs.join('\n\n'), []);

  const quote = /<blockquote expandable>([\s\S]*)<\/blockquote>/.exec(plan.html)?.[1] ?? '';
  assert.match(quote, /^Para 1:/, 'the first line is inside the quote');
  assert.match(quote, /Para 6:/, 'and so is the last paragraph');
  assert.doesNotMatch(plan.html, /<p>Para /, 'nothing of the body is left outside it');
});

test('rich: a 50-item list is quoted whole, numbers print, no list element', () => {
  const items = Array.from({ length: 50 }, (_, i) => `${i + 1}. A site worth keeping in the toolbox`);
  const plan = rich(`50 websites\n${items.join('\n')}`, []);
  const quote = /<blockquote expandable>([\s\S]*)<\/blockquote>/.exec(plan.html)?.[1] ?? '';

  assert.match(quote, /^50 websites<br\/>1\. A site worth keeping/);
  assert.match(quote, /50\. A site worth keeping/, 'the last item is inside too');
  assert.doesNotMatch(plan.html, /<ol|<li/, 'no list element anywhere');
});

test('rich: the quote holds inline RichText only, or the client drops the toggle', () => {
  const filler = 'The rest of the post is what the reader taps to see. '.repeat(20).trim();
  const body = [filler, '', '# a heading', '> a quote', '- a bullet', '```js', 'const a = 1;', '```', 'last'].join('\n');
  const plan = rich(body, []);
  const quote = /<blockquote expandable>([\s\S]*)<\/blockquote>/.exec(plan.html)?.[1] ?? '';

  assert.ok(quote !== '', 'the body is in the quote');
  assert.doesNotMatch(quote, /<(?:p|h[1-6]|pre|ul|ol|li|blockquote|table|details|aside|tg-math-block|tg-button-row)\b/, 'no block element inside the quote');
  assert.match(quote, /<b>a heading<\/b>/, 'a heading line keeps its emphasis');
  assert.match(quote, /• a bullet/, 'a dash bullet keeps a bullet');
  assert.match(quote, /a quote/, 'the quote marker is dropped, not printed');
  assert.doesNotMatch(quote, /```/, 'the fence never prints');
  assert.match(quote, /<br\/>/, 'line breaks stay explicit');
});

test('rich: every post gets the quote, even a one-liner', () => {
  assert.match(rich('one\n\ntwo', []).html, /<hr\/><blockquote expandable>one<br\/><br\/>two<\/blockquote><hr\/>$/);
  assert.match(rich('word '.repeat(300).trim(), []).html, /<blockquote expandable>/, 'a long single line too');
});