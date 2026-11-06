import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Coded, E } from '../../src/platform/errors.ts';
import { fetchRsshubFeed } from '../../src/platform/feed/rsshub.ts';
import type { Http } from '../../src/platform/http.ts';
import type { SourceRef } from '../../src/platform/registry.ts';

const ref: SourceRef = {
  platform: 'facebook',
  canonicalUrl: 'https://facebook.com/TrollMafia01',
  externalId: 'TrollMafia01',
  feedUrl: 'http://rsshub.test/facebook/page/TrollMafia01',
  strategy: 'rsshub',
};

const reply =
  (status: number, body: string): Http =>
  async (url) => ({ status, url, contentType: 'text/html', body });

const codeOf = async (http: Http): Promise<string | undefined> => {
  try {
    await fetchRsshubFeed(http, ref);
    return undefined;
  } catch (err) {
    assert.ok(err instanceof Coded);
    return err.code;
  }
};

test('rsshub: its rate-limit error page is a rate limit, not an outage', async () => {
  const page = '<html><body>Error Message: Error: Facebook GraphQL failed: Rate limit exceeded</body></html>';
  assert.equal(await codeOf(reply(503, page)), E.RATE_LIMIT);
  // The Russian and English templates both spell it "rate limit"; the dash form is accepted too.
  assert.equal(await codeOf(reply(503, 'rate-limit')), E.RATE_LIMIT);
});

test('rsshub: a plain 503 keeps the network ladder', async () => {
  assert.equal(await codeOf(reply(503, 'Bad gateway')), E.FEED_DOWN);
  assert.equal(await codeOf(reply(502, 'rate limit')), E.FEED_DOWN, 'only 503 is RSSHub itself talking');
});
