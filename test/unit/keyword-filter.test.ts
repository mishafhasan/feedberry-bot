/**
 * ADR-020: the keyword filter is a pure predicate. These cases pin the rules the UI promises —
 * any-of, case-insensitive substring, tags count, and an empty list never mutes a source.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { parseFeed } from '../../src/platform/feed/native.ts';
import { effectiveKeywords, formatKeywords, parseKeywords, passesFilter, type FilterText } from '../../src/pipeline/keyword-filter.ts';

const fixture = readFileSync(new URL('../fixtures/keyword-feed.rss', import.meta.url), 'utf8');
const post = (over: Partial<FilterText> = {}): FilterText => ({ title: '', summary: null, categories: [], ...over });

test('filter: an empty list lets everything through', () => {
  assert.equal(passesFilter(post({ title: 'Anything at all' }), []), true);
  // A row of stray commas is a list of no words, not a mute button.
  assert.equal(passesFilter(post({ title: 'Anything at all' }), ['', '   ']), true);
});

test('filter: the match is case-insensitive and may sit anywhere in a word', () => {
  const item = post({ title: 'OpenAI ships a model', summary: 'Nothing else.' });
  assert.equal(passesFilter(item, ['openai']), true);
  assert.equal(passesFilter(item, ['OpenAI']), true);
  assert.equal(passesFilter(item, ['aEn']), false);
  // Documented limit of a substring filter: "ai" also matches "said".
  assert.equal(passesFilter(post({ summary: 'He said so' }), ['ai']), true);
});

test('filter: the body alone is enough, and tags count as content', () => {
  assert.equal(passesFilter(post({ title: 'Weekly roundup', summary: 'Local models ship today.' }), ['local models']), true);
  const tagged = post({ title: 'Football final', summary: 'Match report from the stadium.', categories: ['Sport'] });
  assert.equal(passesFilter(tagged, ['sport']), true, 'a <category> tag matches');
  assert.equal(passesFilter(tagged, ['football', 'zzz']), true, 'any keyword of the list is enough');
  assert.equal(passesFilter(tagged, ['zzz', 'nothing']), false);
});

test('filter: a captured RSS feed keeps its tags and they match', () => {
  const feed = parseFeed(fixture, 'https://keyword.test/feed');
  const [first, second, third] = feed.items;
  assert.deepEqual(first?.categories, ['AI']);
  assert.deepEqual(third?.categories, ['Sport']);

  assert.equal(passesFilter(first!, ['ai']), true);
  assert.equal(passesFilter(second!, ['ai']), false, 'a body that never says "ai" is dropped');
  // The third item matches only through its tag: neither title nor summary carries the word.
  assert.equal(passesFilter(third!, ['sport']), true);
  assert.equal(passesFilter(third!, ['football final']), true);
});

test('filter: parseKeywords trims, drops blanks, dedupes and keeps the user spelling', () => {
  assert.deepEqual(parseKeywords(' AI, telegram ,, ai '), ['AI', 'telegram']);
  assert.deepEqual(parseKeywords(null), []);
  assert.equal(formatKeywords([]), null);
  assert.equal(formatKeywords(['ai', 'telegram']), 'ai,telegram');
});

test('filter: a row own list wins over the user default', () => {
  assert.deepEqual(effectiveKeywords('sport', 'ai'), ['sport']);
  assert.deepEqual(effectiveKeywords(null, 'ai'), ['ai']);
  assert.deepEqual(effectiveKeywords('', 'ai'), ['ai']);
  assert.deepEqual(effectiveKeywords(null, null), []);
});

test('filter: 1 000 posts × 20 keywords stay inside a delivery tick budget', () => {
  const body = 'word '.repeat(800);
  const items = Array.from({ length: 1000 }, (_, index) => post({ title: `Post ${index}`, summary: body, categories: ['Gear'] }));
  const keywords = Array.from({ length: 20 }, (_, index) => `keyword${index}`);

  const started = performance.now();
  for (const item of items) passesFilter(item, keywords);
  const elapsed = performance.now() - started;

  // The whole suite runs the media pipeline on a 120 s timeout; 500 ms for 20 000 scans is a
  // regression alarm, not a benchmark.
  assert.ok(elapsed < 500, `filtering kept ${elapsed.toFixed(0)} ms`);
});
