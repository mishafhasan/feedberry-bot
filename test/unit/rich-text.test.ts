/** ADR-023: source text → Telegram rich HTML (blocks line by line, styles inline). */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { richBody, truncateParagraphs } from '../../src/render/rich-text.ts';

test('rich text: headings H1–H6 and subheadings', () => {
  assert.equal(richBody('# Title'), '<h1>Title</h1>');
  assert.equal(richBody('### Sub **bold**'), '<h3>Sub <b>bold</b></h3>');
  assert.equal(richBody('###### Small'), '<h6>Small</h6>');
  assert.equal(richBody('#hashtag stays text'), '<p>#hashtag stays text</p>', 'no space after # is not a heading');
});

test('rich text: single, multi-line and nested blockquotes', () => {
  assert.equal(richBody('> one'), '<blockquote>one</blockquote>');
  assert.equal(richBody('> one\n> two'), '<blockquote>one<br/>two</blockquote>');
  assert.equal(richBody('> outer\n>> inner'), '<blockquote>outer<br/><blockquote>inner</blockquote></blockquote>');
});

test('rich text: inline and fenced code, fenced content is not styled', () => {
  assert.equal(richBody('run `npm test` now'), '<p>run <code>npm test</code> now</p>');
  assert.equal(richBody('```ts\nconst a = 1 < 2 && **not bold**;\n```'), '<pre><code class="language-ts">const a = 1 &lt; 2 &amp;&amp; **not bold**;</code></pre>');
  assert.equal(richBody('```\nplain\n```'), '<pre>plain</pre>');
});

test('rich text: unordered, ordered and nested lists', () => {
  assert.equal(richBody('- a\n- b'), '<ul><li>a</li><li>b</li></ul>');
  assert.equal(richBody('• a\n* b'), '<ul><li>a</li><li>b</li></ul>');
  assert.equal(richBody('1. one\n2. two'), '<ol><li>one</li><li>two</li></ol>');
  assert.equal(richBody('- a\n  - b\n- c'), '<ul><li>a<ul><li>b</li></ul></li><li>c</li></ul>');
  assert.equal(richBody('1. one\n2. two\n\nnot a list'), '<ol><li>one</li><li>two</li></ol><p>not a list</p>');
});

test('rich text: bold, italic, underline, strike, spoiler, marked', () => {
  const html = richBody('**bold** __bold__ *it* _it_ ++under++ ~~strike~~ ||spoiler|| ==marked==');
  assert.equal(html, '<p><b>bold</b> <b>bold</b> <i>it</i> <i>it</i> <u>under</u> <s>strike</s> <tg-spoiler>spoiler</tg-spoiler> <mark>marked</mark></p>');
});

test('rich text: markdown anchors, bare URLs, email and phone become our links', () => {
  assert.equal(richBody('[the site](https://example.com/a?b=1)'), '<p><a href="https://example.com/a?b=1">the site</a></p>');
  assert.equal(richBody('see https://x.com/p.'), '<p>see <a href="https://x.com/p">https://x.com/p</a>.</p>', 'trailing punctuation stays out of the href');
  assert.equal(richBody('mail a@b.com'), '<p>mail <a href="mailto:a@b.com">a@b.com</a></p>');
  assert.equal(richBody('call +8801712345678'), '<p>call <a href="tel:+8801712345678">+8801712345678</a></p>');
});

test('rich text: custom emoji and date-time entities', () => {
  assert.equal(richBody('![📸](tg://emoji?id=6282526363559666134)'), '<p><tg-emoji emoji-id="6282526363559666134">📸</tg-emoji></p>');
  assert.equal(
    richBody('![22:45 tomorrow](tg://time?unix=1647531900&format=wDT)'),
    '<p><tg-time unix="1647531900" format="wDT">22:45 tomorrow</tg-time></p>',
  );
});

test('rich text: unsafe links and raw HTML stay literal text', () => {
  assert.equal(richBody('<script>alert(1)</script>'), '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  const bad = richBody('[x](javascript:alert(1))');
  assert.doesNotMatch(bad, /href=/, 'only http(s), mailto and tel become links');
  const injected = richBody('[x](https://e.com/"onmouseover=1)');
  assert.doesNotMatch(injected, /href="https:\/\/e\.com\/"onmouseover/, 'the quote is encoded before it can close the href');
  assert.match(injected, /%22|&quot;/, 'and survives only as an encoded character');
});

test('rich text: a blank line starts a new paragraph, prose line breaks stay', () => {
  assert.equal(richBody('one\ntwo\n\nthree'), '<p>one<br/>two</p><p>three</p>');
  assert.equal(richBody('one\n\n\n\ntwo'), '<p>one</p><p>two</p>', 'runs of blank lines collapse');
  assert.equal(richBody('a < b & c > d'), '<p>a &lt; b &amp; c &gt; d</p>');
});

test('rich text: leading, trailing and whitespace-only lines never print', () => {
  assert.equal(richBody('\n\na\n\n'), '<p>a</p>');
  assert.equal(richBody('a\n   \nb'), '<p>a</p><p>b</p>', 'a spaces-only line is a paragraph break');
  assert.equal(richBody('\n\n- x\n\n'), '<ul><li>x</li></ul>', 'blanks around a block stay out');
});

test('rich text: CRLF and CR line endings behave like LF', () => {
  assert.equal(richBody('a\r\nb'), '<p>a<br/>b</p>');
  assert.equal(richBody('a\r\n\r\nb'), '<p>a</p><p>b</p>');
  assert.equal(richBody('a\rb'), '<p>a<br/>b</p>');
});

test('rich text: blocks between paragraphs keep the paragraph order', () => {
  assert.equal(richBody('a\n\n# H\n\nb'), '<p>a</p><h1>H</h1><p>b</p>');
  assert.equal(richBody('a\n\n- x\n- y\n\nb'), '<p>a</p><ul><li>x</li><li>y</li></ul><p>b</p>');
  assert.equal(richBody('a\n\n> q\n\nb'), '<p>a</p><blockquote>q</blockquote><p>b</p>');
  assert.equal(richBody('```\na\n\nb\n```'), '<pre>a\n\nb</pre>', 'a blank line inside code is preserved');
});

test('rich text: the preview keeps whole paragraphs, two or about 240 chars', () => {
  const text = [1, 2, 3, 4, 5, 6].map((n) => `Paragraph ${n}. ${'word '.repeat(20).trim()}`).join('\n\n');
  const preview = truncateParagraphs(text);

  assert.equal(preview.split('\n\n').length, 2, 'two paragraphs fit the preview');
  assert.match(preview, /Paragraph 2\./);
  assert.doesNotMatch(preview, /Paragraph 3/, 'the cut lands on a paragraph boundary');
  assert.ok(preview.length <= 240, `preview is ${preview.length} chars`);
  assert.equal(truncateParagraphs('one\n\ntwo'), 'one\n\ntwo', 'a short post is untouched');
  assert.equal(truncateParagraphs(`long `.repeat(300).trim()), `long `.repeat(300).trim(), 'one long paragraph is never cut');
  assert.equal(truncateParagraphs('a\nb\n\nc'), 'a\nb\n\nc', 'line breaks inside a kept paragraph stay');
  const titleAndBody = `Title\n\n${'word '.repeat(300).trim()}`;
  assert.equal(truncateParagraphs(titleAndBody), titleAndBody, 'a title never stands alone as the preview');
});

test('rich text: a flattened numbered list is split by the caller, then rendered as an ol', () => {
  // breakNumberedList runs before richBody on the rich path; a bare ol is what it feeds.
  assert.equal(richBody('1. http://site.test — one\n2. http://two.test — two'), '<ol><li><a href="http://site.test">http://site.test</a> — one</li><li><a href="http://two.test">http://two.test</a> — two</li></ol>');
});