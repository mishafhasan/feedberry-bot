import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { download } from 'cobalt-engine';

const LIMIT = 16 * 1024;

// Removing the downloader's byte cap must fail both the advertised and chunked cases.
for (const picker of [false, true]) {
  for (const mode of ['fits', 'advertised', 'chunked']) {
    test(`download cap: ${picker ? 'picker' : 'single'} ${mode}`, async () => {
      const dir = await mkdtemp(join(tmpdir(), 'download-cap-'));
      let requests = 0;
      let sent = 0;
      const server = createServer((_req, res) => {
        requests++;
        res.setHeader('content-type', 'video/mp4');
        const size = mode === 'fits' ? LIMIT : LIMIT * 8;
        if (mode !== 'chunked') res.setHeader('content-length', size);
        res.flushHeaders();
        const timer = setInterval(() => {
          res.write(Buffer.alloc(1024));
          sent += 1024;
          if (sent >= size) { clearInterval(timer); res.end(); }
        }, 2);
        res.on('close', () => clearInterval(timer));
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/video.mp4`;
      try {
        const result = download({ status: 'ok', filename: 'clip.mp4', ...(picker ? { picker: [{ type: 'video', url }] } : { urls: [url], type: 'video' }) }, { dir, maxBytes: LIMIT });
        if (mode === 'fits') {
          const done = await result;
          assert.equal((await stat(done.files![0]!)).size, LIMIT, 'exactly the ceiling is allowed');
        } else {
          await assert.rejects(result, { code: 'error.content.too_large' });
          assert.deepEqual(await readdir(dir), [], 'no partial file remains');
          assert.ok(sent < LIMIT * 8, 'transfer stops before consuming the full video');
        }
        assert.equal(requests, 1, 'a size rejection is never retried');
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
}

test('download cap: video and audio share one byte budget', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'download-tracks-'));
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': LIMIT });
    res.end(Buffer.alloc(LIMIT));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await assert.rejects(download({ status: 'ok', filename: 'clip.mp4', type: 'video', urls: [`${url}/v.mp4`, `${url}/a.m4a`] }, { dir, maxBytes: LIMIT, mux: false }), { code: 'error.content.too_large' });
    assert.deepEqual(await readdir(dir), []);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
