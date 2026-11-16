/**
 * Telegra.ph answers FLOOD_WAIT_n when pages arrive too fast — a digest publishes dozens at once.
 * The client waits the seconds the API names and retries, then gives up and the caller keeps the post URL.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { telegraphClient } from '../../src/article/telegraph.ts';

const page = { title: 'Title', authorName: 'FeedBerry', content: '[]' };

async function withReplies<T>(replies: unknown[], fn: () => Promise<T>): Promise<{ result: T; calls: number }> {
  const original = globalThis.fetch;
  const token = process.env.TELEGRAPH_TOKEN;
  const queue = [...replies];
  let calls = 0;
  process.env.TELEGRAPH_TOKEN = 'test-token';
  globalThis.fetch = (async () => {
    calls++;
    return new Response(JSON.stringify(queue.shift()), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    return { result: await fn(), calls };
  } finally {
    globalThis.fetch = original;
    if (token === undefined) delete process.env.TELEGRAPH_TOKEN;
    else process.env.TELEGRAPH_TOKEN = token;
  }
}

test('createPage waits out FLOOD_WAIT and retries the same page', async () => {
  const { result, calls } = await withReplies([{ ok: false, error: 'FLOOD_WAIT_0' }, { ok: true, result: { url: 'https://telegra.ph/ok' } }], () => telegraphClient.createPage(page));
  assert.equal(result, 'https://telegra.ph/ok');
  assert.equal(calls, 2);
});

test('createPage gives up after three waits and reports the flood', async () => {
  const flood = { ok: false, error: 'FLOOD_WAIT_0' };
  const { calls } = await withReplies([flood, flood, flood, flood], () => assert.rejects(() => telegraphClient.createPage(page), /FLOOD_WAIT_0/));
  assert.equal(calls, 4, 'one request and three retries');
});
