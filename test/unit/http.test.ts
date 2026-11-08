import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { test } from 'node:test';
import { Coded, E } from '../../src/platform/errors.ts';
import { decodeBody, trustedFetch } from '../../src/platform/http.ts';

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

test('decode: the document outranks the header, a BOM outranks both, and no label is fatal', () => {
  const cp1251 = readFileSync(new URL('../fixtures/windows-1251.bin', import.meta.url));

  assert.equal(
    decodeBody(cp1251, 'application/rss+xml; charset=utf-8'),
    '<?xml version="1.0" encoding="windows-1251"?><t>Привет</t>',
    'the declaration is right and the header is wrong',
  );
  assert.equal(decodeBody(Buffer.from([0xcf, 0xf0]), 'text/xml; charset=windows-1251'), 'Пр', 'no declaration: the header decides');
  assert.equal(decodeBody(Buffer.from('plain', 'utf8'), 'text/xml; charset=x-nonsense'), 'plain', 'an unknown label falls back');
  assert.equal(decodeBody(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('café', 'utf8')]), 'text/xml'), 'café', 'BOM wins');
});
