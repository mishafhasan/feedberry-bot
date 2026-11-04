import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Http } from '../../src/platform/http.ts';
import { pinOwner } from '../../src/platform/pinterest-pin.ts';

const opts = { rsshubBase: 'http://rsshub.test', telegramBeta: false };
const PIN = 'https://www.pinterest.com/pin/1149614242378622706/';

/** A Bot-API-shaped stub: records the URL, answers with the card body. */
function card(body: unknown, status = 200): { http: Http; seen: string[] } {
  const seen: string[] = [];
  const http: Http = async (url) => {
    seen.push(url);
    return { status, url, contentType: 'application/json', body: typeof body === 'string' ? body : JSON.stringify(body) };
  };
  return { http, seen };
}

test('M17 pinterest: the oEmbed card names the pinner, which is the source to offer', async () => {
  const { http, seen } = card({ author_name: 'N A B I L A', author_url: 'https://www.pinterest.com/sabrinaeasminn/' });
  assert.equal(await pinOwner(http, PIN, opts), 'https://pinterest.com/sabrinaeasminn');
  assert.match(String(seen[0]), /^https:\/\/www\.pinterest\.com\/oembed\.json\?url=https%3A%2F%2Fwww\.pinterest\.com%2Fpin%2F/);
});

test('M17 pinterest: anything unreadable is no source, never an error', async () => {
  assert.equal(await pinOwner(card({ error: 'url should be a Pinterest url' }).http, PIN, opts), null);
  assert.equal(await pinOwner(card({ author_url: 'https://www.pinterest.com/sabrinaeasminn/' }, 404).http, PIN, opts), null);
  assert.equal(await pinOwner(card('not json').http, PIN, opts), null);
  assert.equal(await pinOwner(card({ author_name: 'N A B I L A' }).http, PIN, opts), null, 'a display name is not a handle');
  assert.equal(await pinOwner(card({ author_url: 'https://www.pinterest.com/ideas/' }).http, PIN, opts), null, 'a browse page is not an account');
});

test('M17 pinterest: a non-Pinterest link costs no request', async () => {
  const { http, seen } = card({ author_url: 'https://www.pinterest.com/sabrinaeasminn/' });
  assert.equal(await pinOwner(http, 'https://youtu.be/dQw4w9WgXcQ', opts), null);
  assert.equal(seen.length, 0);
});
