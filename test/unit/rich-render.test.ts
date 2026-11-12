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

/** The header every rich post opens with: a heading source line, then the bold, live time line. */
const HEADER = /^<h3><tg-emoji emoji-id="\d+">📸<\/tg-emoji> <a href="https:\/\/www\.instagram\.com\/p\/DfJ2075AGx3\/">Evolving AI<\/a> \| Instagram<\/h3><p>⏱️ <b>Time<\/b>: <tg-time unix="1793505660" format="r">[^<]*<\/tg-time><\/p>/;

test('rich: heading + bold relative time, slideshow ref, and the body in one message', () => {
  const plan = rich('Hello world', [photo()]);
  assert.match(plan.html, HEADER);
  assert.match(plan.html, /<tg-slideshow><img src="tg:\/\/photo\?id=m0"\/><\/tg-slideshow>/);
  assert.match(plan.html, /<p>Hello world<\/p>$/);
  assert.deepEqual(plan.media, [{ id: 'm0', file: 'a.jpg', kind: 'photo' }]);
});

test('rich: original line breaks become <br/>, paragraphs stay blocks, source values are escaped', () => {
  const plan = rich('line one\nline two\n\na < b & c > d', []);
  assert.match(plan.html, /<p>line one<br\/>line two<\/p><p>a &lt; b &amp; c &gt; d<\/p>/);
});

test('rich: no media still ships header + time + text, no slideshow', () => {
  const plan = rich('words only', []);
  assert.doesNotMatch(plan.html, /<tg-slideshow>/);
  assert.deepEqual(plan.media, []);
  assert.match(plan.html, /<p>words only<\/p>/);
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
  assert.match(plan.html, /…<\/blockquote>$/, 'the ellipsis closes the folded tail');
});

test('rich: an RSS post keeps the classic layout, never rich', () => {
  const plan = renderPost(post('body'), 'photo', [photo()], { platform: 'rss', sourceTitle: 'My Blog' });
  assert.equal(plan.kind, 'photo');
});

test('rich: a long post folds its tail into an expandable quote', () => {
  const paragraphs = [1, 2, 3, 4, 5, 6].map((n) => `Para ${n}: ${'word '.repeat(20).trim()}`);
  const plan = rich(paragraphs.join('\n\n'), []);

  assert.match(plan.html, /^[\s\S]*<p>Para 1:[\s\S]*<\/p><blockquote expandable>/);
  const quote = /<blockquote expandable>([\s\S]*)<\/blockquote>/.exec(plan.html)?.[1] ?? '';
  assert.match(quote, /^Para 3:/, 'the tail starts at the first line past the preview budget');
  assert.match(quote, /Para 6:/, 'to the last paragraph');
  assert.doesNotMatch(quote, /Para [12]:/, 'the preview stays outside the quote');
});

test('rich: a 50-item list folds too, no blank line needed', () => {
  const items = Array.from({ length: 50 }, (_, i) => `${i + 1}. A site worth keeping in the toolbox`);
  const plan = rich(`50 websites\n${items.join('\n')}`, []);
  const quote = /<blockquote expandable>([\s\S]*)<\/blockquote>/.exec(plan.html)?.[1] ?? '';

  assert.match(plan.html, /<ol><li>/, 'the open part keeps its list');
  assert.match(quote, /50\. A site worth keeping/, 'the tail reaches the last item');
  assert.doesNotMatch(quote, /<ol|<li/, 'and is inline only');
});

test('rich: the hidden tail holds inline RichText only, or the client drops the toggle', () => {
  const filler = 'The tail is what the reader has to tap to see. '.repeat(20).trim();
  const body = [filler, '', '# a heading', '> a quote', '- a bullet', '```js', 'const a = 1;', '```', 'last'].join('\n');
  const plan = rich(body, []);
  const quote = /<blockquote expandable>([\s\S]*)<\/blockquote>/.exec(plan.html)?.[1] ?? '';

  assert.ok(quote !== '', 'the body overflows the preview');
  assert.doesNotMatch(quote, /<(?:p|h[1-6]|pre|ul|ol|li|blockquote|table|details|aside|tg-math-block|tg-button-row)\b/, 'no block element inside the quote');
  assert.match(quote, /<b>a heading<\/b>/, 'a heading line keeps its emphasis');
  assert.match(quote, /• a bullet/, 'a dash bullet keeps a bullet');
  assert.match(quote, /a quote/, 'the quote marker is dropped, not printed');
  assert.doesNotMatch(quote, /```/, 'the fence never prints');
  assert.match(quote, /<br\/>/, 'line breaks stay explicit');
});

test('rich: a post that fits the preview keeps no quote, a longer one folds', () => {
  assert.doesNotMatch(rich('one\n\ntwo', []).html, /<blockquote/);
  const long = rich('word '.repeat(300).trim(), []);
  assert.match(long.html, /<blockquote expandable>/, 'one long line folds as well');

  const tinyTail = rich('word '.repeat(50).trim(), []);
  assert.doesNotMatch(tinyTail.html, /<blockquote/, 'a tail too short to fold would only draw a dead quote');
  assert.match(tinyTail.html, /<p>word word /, 'so its text stays in the open');
});