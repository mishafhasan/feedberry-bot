/** ADR-025: source text → the inline RichText of the expandable quote (block markers flattened). */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expandableQuote } from '../../src/render/rich-text.ts';

/** The html of a post with no line break, without the quote wrapper. */
const inlineOf = (text: string): string =>
  expandableQuote(text).replace(/^<blockquote expandable>/, '').replace(/<\/blockquote>$/, '');

test('rich text: a heading line keeps its emphasis, never a block element', () => {
  assert.equal(inlineOf('# Title'), '<b>Title</b>');
  assert.equal(inlineOf('### Sub **bold**'), '<b>Sub <b>bold</b></b>');
  assert.equal(inlineOf('#hashtag stays text'), '#hashtag stays text', 'no space after # is not a heading');
});

test('rich text: quote, bullet and fence markers flatten instead of printing', () => {
  assert.equal(inlineOf('> one\n>> two'), 'one<br/>two', 'the quote marker is dropped');
  assert.equal(inlineOf('- a\n* b\n• c'), '• a<br/>• b<br/>• c');
  assert.equal(inlineOf('1. one\n2. two'), '1. one<br/>2. two', 'numbers print as text');
  assert.equal(
    expandableQuote('```ts\nconst a = 1 < 2 && **bold**;\n```'),
    '<blockquote expandable>const a = 1 &lt; 2 &amp;&amp; <b>bold</b>;</blockquote>',
    'the fence line never prints; the code stays escaped text',
  );
});

test('rich text: inline code, bold, italic, underline, strike, spoiler, marked', () => {
  assert.equal(inlineOf('run `npm test` now'), 'run <code>npm test</code> now');
  assert.equal(
    inlineOf('**bold** __bold__ *it* _it_ ++under++ ~~strike~~ ||spoiler|| ==marked=='),
    '<b>bold</b> <b>bold</b> <i>it</i> <i>it</i> <u>under</u> <s>strike</s> <tg-spoiler>spoiler</tg-spoiler> <mark>marked</mark>',
  );
});

test('rich text: markdown anchors, bare URLs, email and phone become our links', () => {
  assert.equal(inlineOf('[the site](https://example.com/a?b=1)'), '<a href="https://example.com/a?b=1">the site</a>');
  assert.equal(inlineOf('see https://x.com/p.'), 'see <a href="https://x.com/p">https://x.com/p</a>.', 'trailing punctuation stays out of the href');
  assert.equal(inlineOf('mail a@b.com'), 'mail <a href="mailto:a@b.com">a@b.com</a>');
  assert.equal(inlineOf('call +8801712345678'), 'call <a href="tel:+8801712345678">+8801712345678</a>');
});

test('rich text: custom emoji and date-time entities', () => {
  assert.equal(inlineOf('![📸](tg://emoji?id=6282526363559666134)'), '<tg-emoji emoji-id="6282526363559666134">📸</tg-emoji>');
  assert.equal(
    inlineOf('![22:45 tomorrow](tg://time?unix=1647531900&format=wDT)'),
    '<tg-time unix="1647531900" format="wDT">22:45 tomorrow</tg-time>',
  );
});

test('rich text: unsafe links and raw HTML stay literal text', () => {
  assert.equal(inlineOf('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  const bad = expandableQuote('[x](javascript:alert(1))');
  assert.doesNotMatch(bad, /href=/, 'only http(s), mailto and tel become links');
  const injected = expandableQuote('[x](https://e.com/"onmouseover=1)');
  assert.doesNotMatch(injected, /href="https:\/\/e\.com\/"onmouseover/, 'the quote is encoded before it can close the href');
  assert.match(injected, /%22|&quot;/, 'and survives only as an encoded character');
});

test('rich text: the whole post is one quote, blank lines are the only paragraph gap', () => {
  assert.equal(expandableQuote('one\ntwo'), '<blockquote expandable>one<br/>two</blockquote>');
  assert.equal(expandableQuote('one\n\nthree'), '<blockquote expandable>one<br/><br/>three</blockquote>');
  assert.equal(expandableQuote('one\n\n\n\nthree'), '<blockquote expandable>one<br/><br/>three</blockquote>', 'a run of blank lines is one gap');
  assert.equal(expandableQuote('a < b & c > d'), '<blockquote expandable>a &lt; b &amp; c &gt; d</blockquote>');
  assert.equal(expandableQuote('a\n   \nb'), '<blockquote expandable>a<br/><br/>b</blockquote>', 'a spaces-only line is a gap, not a line of spaces');
});

test('rich text: leading, trailing and empty content never print, and an empty post has no quote', () => {
  assert.equal(expandableQuote('\n\na\n\n'), '<blockquote expandable>a</blockquote>');
  assert.equal(expandableQuote('\n\n- x\n\n'), '<blockquote expandable>• x</blockquote>');
  assert.equal(expandableQuote('   \n\n '), '', 'a post with no words gets no quote at all');
});

test('rich text: CRLF and CR line endings behave like LF', () => {
  assert.equal(expandableQuote('a\r\nb'), '<blockquote expandable>a<br/>b</blockquote>');
  assert.equal(expandableQuote('a\r\n\r\nb'), '<blockquote expandable>a<br/><br/>b</blockquote>');
  assert.equal(expandableQuote('a\rb'), '<blockquote expandable>a<br/>b</blockquote>');
});

test('rich text: a numbered list with links keeps its numbers and its links', () => {
  assert.equal(
    inlineOf('1. http://site.test — one\n2. http://two.test — two'),
    '1. <a href="http://site.test">http://site.test</a> — one<br/>2. <a href="http://two.test">http://two.test</a> — two',
  );
});
