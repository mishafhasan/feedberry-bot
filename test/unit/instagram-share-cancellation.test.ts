import assert from 'node:assert/strict';
import { test } from 'node:test';

test('Instagram share redirects honor cancellation before post extraction', async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  let seen: AbortSignal | null | undefined;
  let calls = 0;

  globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
    calls++;
    seen = init?.signal;
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal === null || signal === undefined) return;
      const abort = () => reject(new DOMException('The operation was aborted', 'AbortError'));
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    });
  }) as typeof fetch;

  try {
    const { resolve } = await import('../../cobalt-engine/src/engine.js');
    const pending = resolve('https://www.instagram.com/share/Df4_7w4gBZC/', { signal: controller.signal }) as Promise<{ status: string; error?: { code?: string } }>;
    await new Promise<void>((done) => setImmediate(done));

    assert.equal(seen, controller.signal, 'the caller signal reaches the share redirect request');
    controller.abort();
    const result = await pending;

    assert.equal(result.status, 'error');
    assert.equal(result.error?.code, 'error.request.cancelled');
    assert.equal(calls, 1, 'cancellation does not start the GET fallback or post extraction');
  } finally {
    controller.abort();
    globalThis.fetch = originalFetch;
  }
});
