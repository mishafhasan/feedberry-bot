import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Http } from '../../src/platform/http.ts';
import { xFullText } from '../../src/platform/x-text.ts';

const body = JSON.stringify({ tweet: { text: '  The whole note tweet, in full.  ' } });

function httpServing(status: number, payload: string, seen: string[] = []): Http {
  return async (url) => {
    seen.push(url);
    return { status, url, contentType: 'application/json', body: payload };
  };
}

test('x full text: the mirror is asked with the same handle and status id', async () => {
  const seen: string[] = [];
  const text = await xFullText(httpServing(200, body, seen), 'https://x.com/MissDelulu9/status/2116793013774975408');
  assert.equal(text, 'The whole note tweet, in full.');
  assert.deepEqual(seen, ['https://api.fxtwitter.com/MissDelulu9/status/2116793013774975408']);
});

test('x full text: twitter.com and www hosts map to the same mirror call', async () => {
  const seen: string[] = [];
  const http = httpServing(200, body, seen);
  await xFullText(http, 'https://www.twitter.com/blue/status/42');
  assert.deepEqual(seen, ['https://api.fxtwitter.com/blue/status/42']);
});

test('x full text: anything else, a failure or an empty text is null', async () => {
  assert.equal(await xFullText(httpServing(200, body), 'https://x.com/blue'), null, 'not a post link');
  assert.equal(await xFullText(httpServing(500, body), 'https://x.com/blue/status/42'), null);
  assert.equal(await xFullText(httpServing(200, '{"tweet":{}}'), 'https://x.com/blue/status/42'), null);
  assert.equal(
    await xFullText(async () => { throw new Error('network down'); }, 'https://x.com/blue/status/42'),
    null,
    'the caption path must never fail the download',
  );
});
