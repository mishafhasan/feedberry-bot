/**
 * ADR-029's message, offline: the English and Tamil layouts, the slideshow shapes, the trust boundary
 * (model output is escaped, never markup) and the three split budgets.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_PART_MEDIA, renderDigest, type RenderInput } from '../../src/digest/render.ts';
import type { DigestItem } from '../../src/digest/summarise.ts';

const item = (over: Partial<DigestItem> = {}): DigestItem => ({
  postId: 1,
  headline: 'A quiet headline',
  originalTitle: null,
  description: 'Two sentences about what happened.',
  points: ['first fact', 'second fact'],
  images: [],
  link: 'https://telegra.ph/Post-11-16',
  url: 'https://blog.test/post',
  publishedAt: Date.UTC(2026, 10, 16, 4, 40),
  sourceTitle: 'Blog',
  ...over,
});

const input = (over: Partial<RenderInput> = {}): RenderInput => ({
  lang: 'en',
  date: 'Mon, 16 Nov 2026',
  tz: 'UTC',
  sourceCount: 1,
  items: [item()],
  extra: [],
  postCount: 1,
  audio: null,
  ...over,
});

const htmlOf = (plans: ReturnType<typeof renderDigest>, index = 0): string => {
  const plan = plans[index];
  assert.equal(plan?.kind, 'rich');
  return plan?.kind === 'rich' ? plan.html : '';
};

test('digest: the English layout carries every block in order', () => {
  const plans = renderDigest(input({ audio: { file: '/tmp/a.mp3', seconds: 372 } }));
  assert.equal(plans.length, 1);
  const html = htmlOf(plans);

  assert.match(html, /^<h2>🫐 Daily Digest<\/h2>/);
  assert.match(html, /📅 Mon, 16 Nov 2026 · 🗞 1 posts · 1 sources/);
  assert.match(html, /<audio src="tg:\/\/audio\?id=overview"><\/audio>/);
  assert.match(html, /🎧 Audio overview · 6 min/);
  assert.match(html, /<h3>1\. A quiet headline<\/h3>/);
  assert.match(html, /\| RSS<\/h5>/);
  assert.match(html, /⏱️ <b>Time<\/b>: 16\/11 04:40/);
  assert.match(html, /Two sentences about what happened\./);
  assert.match(html, /🔑 Key points<\/b><\/p><ul><li>first fact<\/li><li>second fact<\/li><\/ul>/);
  assert.match(html, /📖 Read full article — <a href="https:\/\/telegra\.ph\/Post-11-16">/);
  assert.match(html, /<footer>🤖 AI-generated summary of 1 posts/);
  assert.doesNotMatch(html, /<p><i>A quiet headline<\/i><\/p>/, 'the original title is Tamil-only');
  const plan = plans[0];
  assert.deepEqual(plan?.kind === 'rich' ? plan.media : [], [{ id: 'overview', file: '/tmp/a.mp3', kind: 'audio' }]);
});

test('digest: Tamil swaps every label and prints the original title under the headline', () => {
  const html = htmlOf(
    renderDigest(
      input({
        lang: 'ta',
        items: [item({ headline: 'புதிய GPU திட்டம்', originalTitle: 'A new GPU plan' })],
        date: 'திங்கள், 16 நவ., 2026',
      }),
    ),
  );
  assert.match(html, /🫐 தினசரி சுருக்கம்/);
  assert.match(html, /இடுகைகள்/);
  assert.match(html, /<p><i>A new GPU plan<\/i><\/p>/);
  assert.match(html, /🔑 முக்கிய குறிப்புகள்/);
  assert.match(html, /📖 முழு கட்டுரையைப் படிக்க/);
  assert.match(html, /🤖 1 இடுகைகளின் AI சுருக்கம்/);
});

test('digest: one image is a bare img, three ride in a slideshow, a fourth is dropped', () => {
  const none = htmlOf(renderDigest(input()));
  assert.doesNotMatch(none, /<img src/);

  const one = htmlOf(renderDigest(input({ items: [item({ images: ['/a.jpg'] })] })));
  assert.match(one, /<img src="tg:\/\/photo\?id=i1m0"\/>/);
  assert.doesNotMatch(one, /tg-slideshow/);

  const three = htmlOf(renderDigest(input({ items: [item({ images: ['/a.jpg', '/b.jpg', '/c.jpg', '/d.jpg'] })] })));
  assert.match(three, /<tg-slideshow><img src="tg:\/\/photo\?id=i1m0"\/><img src="tg:\/\/photo\?id=i1m1"\/><img src="tg:\/\/photo\?id=i1m2"\/><\/tg-slideshow>/);
  assert.equal(three.match(/<img /g)?.length, 3, 'the renderer keeps its own three-image ceiling');
});

test('digest: model output is text, never markup — only our Telegraph link is an anchor', () => {
  const html = htmlOf(
    renderDigest(
      input({
        items: [
          item({
            headline: 'A <b>bold</b> claim & "quotes"',
            description: '<a href="https://evil.test">click</a>',
            points: ['5 < 6 & 7 > 6'],
            link: 'https://telegra.ph/Post',
            url: null,
          }),
        ],
      }),
    ),
  );
  assert.match(html, /A &lt;b&gt;bold&lt;\/b&gt; claim &amp; "quotes"/);
  assert.match(html, /&lt;a href="https:\/\/evil\.test"&gt;click&lt;\/a&gt;/);
  assert.doesNotMatch(html, /<a href="https:\/\/evil/, 'the escaped text is not an anchor');
  assert.match(html, /5 &lt; 6 &amp; 7 &gt; 6/);
  assert.equal(html.match(/<a href=/g)?.length, 1, 'only the read-full link');
});

test('digest: no audio prints the unavailable line, not a player', () => {
  const html = htmlOf(renderDigest(input({ audio: null })));
  assert.doesNotMatch(html, /tg:\/\/audio/);
  assert.match(html, /🎧 Audio unavailable today/);
});

test('digest: an empty window is one message and no audio line', () => {
  const plans = renderDigest(input({ items: [], audio: null, postCount: 0, sourceCount: 0 }));
  assert.equal(plans.length, 1);
  const html = htmlOf(plans);
  assert.match(html, /Daily Digest/);
  assert.match(html, /No new posts from your digest sources in the last 24 hours\./);
  assert.doesNotMatch(html, /Audio unavailable/);
  assert.doesNotMatch(html, /<footer>/);
});

test('digest: the media budget splits the message and only Part 1 carries the player', () => {
  const items = Array.from({ length: 20 }, (_, index) => item({ postId: index + 1, images: ['/a.jpg', '/b.jpg', '/c.jpg'] }));
  const plans = renderDigest(input({ items, postCount: items.length, audio: { file: '/tmp/a.mp3', seconds: 60 } }));
  assert.ok(plans.length > 1, 'sixty photos cannot ride in one message');

  const first = plans[0];
  const media = first?.kind === 'rich' ? first.media : [];
  assert.equal(media.length, MAX_PART_MEDIA, '48 photos plus the audio fill Part 1 to 49');
  assert.equal(media.filter((entry) => entry.kind === 'audio').length, 1);

  const rest = plans.slice(1).flatMap((plan) => (plan.kind === 'rich' ? plan.media : []));
  assert.equal(rest.filter((entry) => entry.kind === 'audio').length, 0, 'the player is Part 1 only');
  assert.equal(htmlOf(plans, 1).match(/<h3>/)?.[0] !== undefined, true);
  assert.match(htmlOf(plans, 1), /<h3>17\. /, 'numbering continues across parts');
  assert.match(htmlOf(plans, 1), /Part 2\/2/);
  assert.doesNotMatch(htmlOf(plans, 0), /<footer>/);
  assert.match(htmlOf(plans, plans.length - 1), /<footer>/);
});

test('digest: the text and block budgets split before Telegram rejects a part', () => {
  const long = Array.from({ length: 20 }, (_, index) => item({ postId: index + 1, description: 'x'.repeat(2000) }));
  const byText = renderDigest(input({ items: long, postCount: long.length }));
  assert.ok(byText.length > 1);
  for (const plan of byText) {
    assert.ok((plan.kind === 'rich' ? plan.html.length : 0) <= 32_768, 'each part stays under the rich-text cap');
  }

  const many = Array.from({ length: 40 }, (_, index) => item({ postId: index + 1, points: ['a', 'b', 'c', 'd', 'e', 'f'] }));
  const byBlocks = renderDigest(input({ items: many, postCount: many.length }));
  assert.ok(byBlocks.length > 1, 'forty items with six points each pass the 480-block cap');
  const firstItems = (htmlOf(byBlocks).match(/<h3>/g) ?? []).length;
  assert.ok(firstItems <= 33, `Part 1 holds ${firstItems} items, each about 14 blocks`);
});

test('digest: posts past the cap are numbered headline links under "Also today"', () => {
  const html = htmlOf(
    renderDigest(
      input({
        postCount: 2,
        extra: [{ headline: 'Older story', url: 'https://blog.test/older' }],
      }),
    ),
  );
  assert.match(html, /Also today<\/b><\/p><ul><li><a href="https:\/\/blog\.test\/older">2\. Older story<\/a><\/li><\/ul>/);
  assert.match(html, /<footer>🤖 AI-generated summary of 2 posts/);
});
