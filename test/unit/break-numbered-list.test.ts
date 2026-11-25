import assert from 'node:assert/strict';
import { test } from 'node:test';
import { breakNumberedList } from '../../src/render/caption.ts';

const FLAT =
  '50 websites that feel like the internet’s hidden toolbox ' +
  '1. http://a.test — Free papers 2. http://b.test — Borrow books 4. http://c.test — App alternatives ' +
  'Save this. You’ll definitely need some of these later. 🔖 #ai #aiwebsites #aitools';

test('breakNumberedList: a flattened list gets its items back on separate lines', () => {
  const lines = breakNumberedList(FLAT).split('\n');
  assert.equal(lines[0], '50 websites that feel like the internet’s hidden toolbox', 'intro stays its own line');
  assert.match(lines[1] ?? '', /^1\. http:\/\/a\.test/);
  assert.match(lines[3] ?? '', /^4\. http:\/\/c\.test/, 'the source numbering is kept as written');
});

test('breakNumberedList: the glued CTA and hashtag block get their own lines', () => {
  const lines = breakNumberedList(FLAT).split('\n');
  assert.equal(lines.at(-3), 'Save this. You’ll definitely need some of these later.', 'the CTA is no longer inside the last item');
  assert.equal(lines.at(-2), '', 'the hashtags keep their blank line');
  assert.equal(lines.at(-1), '🔖 #ai #aiwebsites #aitools', 'and the hashtags are a separate block');
});

test('breakNumberedList: a trailing hashtag block without an emoji also splits', () => {
  const lines = breakNumberedList('intro 1. a 2. b 3. c tail #one #two').split('\n');
  assert.equal(lines.at(-3), '3. c tail');
  assert.equal(lines.at(-2), '');
  assert.equal(lines.at(-1), '#one #two');
});

test('breakNumberedList: a description starting with a CTA after the dash is not split', () => {
  const lines = breakNumberedList('intro 1. a 2. b 3. c — Check data breaches').split('\n');
  assert.equal(lines.at(-1), '3. c — Check data breaches', 'space before the verb is the item, not the glue');
});

test('breakNumberedList: prose with fewer than three markers is untouched', () => {
  assert.equal(breakNumberedList('I tried 1. one and 2. two today'), 'I tried 1. one and 2. two today');
});