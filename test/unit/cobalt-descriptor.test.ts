import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { cobaltEngine, downloadInput, type MediaItem } from '../../src/media/cobalt.ts';
import { isCoded } from '../../src/platform/errors.ts';

const headers = { 'user-agent': 'Mozilla/5.0', referer: 'https://www.tiktok.com/' };

test('media descriptor: the extractor headers are forwarded to the download', () => {
  const item: MediaItem = { kind: 'video', url: 'https://v16.tiktokcdn.example/x.mp4', picker: false, headers };
  const input = downloadInput(item, 'media-video');
  assert.equal(input.status, 'ok');
  assert.deepEqual(input.headers, headers, 'without referer + UA the TikTok CDN answers 403');
  assert.deepEqual(input.urls, [item.url]);
});

test('media descriptor: carousel items keep the headers too', () => {
  const item: MediaItem = { kind: 'photo', url: 'https://p16.tiktokcdn.example/x.jpg', picker: true, headers };
  const input = downloadInput(item, 'media-photo');
  assert.deepEqual(input.headers, headers);
  assert.deepEqual(input.picker, [{ type: 'photo', url: item.url }]);
});

test('media descriptor: an item without headers stays header-free', () => {
  const input = downloadInput({ kind: 'photo', url: 'https://cdn.example/x.jpg', picker: false }, 'media-photo');
  assert.equal('headers' in input, false);
});

test('media download: a refused host becomes a coded media error, never an unknown failure', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-cobalt-'));
  try {
    // Port 9 (discard) on loopback refuses the connection: deterministic, no external network.
    await assert.rejects(
      cobaltEngine.download({ kind: 'video', url: 'http://127.0.0.1:9/x.mp4', picker: false }, dir, AbortSignal.timeout(10_000)),
      (err: unknown) => isCoded(err) && err.code === 'E_NO_MEDIA',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
