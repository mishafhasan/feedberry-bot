import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { test } from 'node:test';
import { Coded, E } from '../../src/platform/errors.ts';
import { trustedFetch } from '../../src/platform/http.ts';

/** A port nothing listens on: bind it, note the number, release it. */
function closedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as { port: number };
      server.close(() => resolve(address.port));
    });
  });
}

test('trusted fetch: a refused connection is a source that is down, not an unknown bug', async () => {
  const port = await closedPort();

  await assert.rejects(trustedFetch(`http://127.0.0.1:${port}/instagram/user/someone`, { maxBytes: 1024, timeoutMs: 3000 }), (err: unknown) => {
    assert.ok(err instanceof Coded, `expected a Coded error, got ${String(err)}`);
    assert.equal(err.code, E.FEED_DOWN, 'the user is told the source is unreachable, not "something went wrong"');
    return true;
  });
});
