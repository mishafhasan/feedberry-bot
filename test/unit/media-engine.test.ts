/**
 * The engine's descriptor is the only thing cobalt's downloader sees: a merged YouTube result is
 * two URLs, and the size probe must read the total a CDN reports without pulling the file.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { bytesFrom, cobaltEngine, downloadInput, pickerItems, type MediaItem } from '../../src/media/media-engine.ts';
import { mediaSignal } from '../../src/pipeline/prepare-media.ts';

const video: MediaItem = { kind: 'video', url: 'https://cdn.test/v.mp4', picker: false };

test('the descriptor carries the audio track, so YouTube lands with sound', () => {
  const merged = downloadInput({ ...video, audio: 'https://cdn.test/a.m4a' });

  assert.deepEqual(merged.urls, ['https://cdn.test/v.mp4', 'https://cdn.test/a.m4a']);
  assert.equal(merged.type, 'video');
  assert.equal(merged.filename, 'media-video.mp4', 'a muxed write needs its container in the name');
});

test('a carousel item still travels through the picker branch', () => {
  const picker = downloadInput({ kind: 'photo', url: 'https://cdn.test/p.jpg', picker: true, audio: 'https://cdn.test/a.m4a' });

  assert.deepEqual(picker.picker, [{ type: 'photo', url: 'https://cdn.test/p.jpg' }], 'a carousel item has no second track');
  assert.equal(picker.urls, undefined);
  assert.equal(picker.filename, 'media-photo.jpg');
});

test('a picker of four photos is four items, each downloaded through the picker branch', () => {
  const items = pickerItems([
    { type: 'photo', url: 'https://cdn.test/1.jpg' },
    { type: 'video', url: 'https://cdn.test/2.mp4', thumb: 'https://cdn.test/2.jpg' },
    { type: 'photo', url: 'https://cdn.test/3.jpg' },
    { type: 'photo', url: 'https://cdn.test/4.jpg' },
  ], { cookie: 'c=1' });

  assert.deepEqual(items.map((item) => item.kind), ['photo', 'video', 'photo', 'photo'], 'the post order is kept');
  assert.ok(items.every((item) => item.picker), 'an album item is never resolved as one stream');
  assert.equal(items[1]?.poster, 'https://cdn.test/2.jpg', 'a clip keeps the thumb the platform stated');
  assert.deepEqual(downloadInput(items[0] ?? video), {
    status: 'ok',
    picker: [{ type: 'photo', url: 'https://cdn.test/1.jpg' }],
    filename: 'media-photo.jpg',
    headers: { cookie: 'c=1' },
  });
  assert.deepEqual(pickerItems([{ type: 'unknown', url: 'https://cdn.test/x' }]), [], 'an unplayable entry is dropped');
});

test('a size probe reads the total of a ranged answer before the plain length', () => {
  assert.equal(bytesFrom(new Headers({ 'content-range': 'bytes 0-0/491858616' })), 491858616);
  assert.equal(bytesFrom(new Headers({ 'content-length': '99' })), 99, 'a plain answer only names its length');
  assert.equal(bytesFrom(new Headers({})), null, 'a host that will not say is null, never zero');
  assert.equal(bytesFrom(new Headers({ 'content-range': 'bytes 0-0/*' })), null);
});

test('two photos served as PNG never overwrite each other', async () => {
  // Every photo is named `media-photo.jpg`; a sniffed rename to `.png` must not free that name again,
  // or item 2 lands on item 1's file and the album shows one picture N times.
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const bodies: Record<string, Buffer> = {
    '/one': Buffer.concat([png, Buffer.from('first picture')]),
    '/two': Buffer.concat([png, Buffer.from('second picture')]),
  };
  const server = createServer((request, response) => {
    const body = bodies[request.url ?? ''];
    if (body === undefined) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'image/png', 'content-length': body.length }).end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const dir = mkdtempSync(join(tmpdir(), 'cobalt-overwrite-'));

  try {
    const files: string[] = [];
    for (const name of ['one', 'two']) {
      files.push(await cobaltEngine.download({ kind: 'photo', url: `${base}/${name}`, picker: true }, dir, mediaSignal(10_000)));
    }

    assert.notEqual(files[0], files[1], 'the second photo keeps its own file');
    assert.notDeepEqual(readFileSync(files[0] ?? ''), readFileSync(files[1] ?? ''));
  } finally {
    server.closeAllConnections();
    server.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
