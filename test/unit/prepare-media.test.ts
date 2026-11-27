/**
 * Stage 5 decides from the size, never from the download: a clip past the Bot API ceiling is linked,
 * and X/YouTube step 1080 → 720 → 480 until one rung fits. Nothing here touches the network.
 */
import assert from 'node:assert/strict';
import { closeSync, existsSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { hasFFmpeg } from 'cobalt-engine';
import type { MediaEngine, MediaItem } from '../../src/media/media-engine.ts';
import { DOWNLOAD_BUDGET_MS, EXTRACT_BUDGET_MS, mediaSignal, prepareMedia, withPosters } from '../../src/pipeline/prepare-media.ts';
import { Coded, E } from '../../src/platform/errors.ts';
import { probeDimensions, telegramPhotoFits } from '../../src/media/video-probe.ts';

const MB = 1024 * 1024;
const OVER = 51 * MB;
const POST = 'https://x.com/who/status/1';
const URL_1080 = 'https://cdn.test/1080.mp4';
const URL_720 = 'https://cdn.test/720.mp4';
const URL_480 = 'https://cdn.test/480.mp4';

interface Rung {
  quality: string;
  url: string;
  /** What the host says it will send; null means it will not say. */
  size: number | null;
  /** What the download actually lands; the rung's size unless a host lies. */
  fileSize?: number;
}

const item = (url: string, extra: Partial<MediaItem> = {}): MediaItem => ({ kind: 'video', url, picker: false, ...extra });

/** A fake engine that answers each quality with its rung and reports a size the way a CDN would. */
function engineOf(rungs: Rung[], opts: { size?: boolean; fail?: string } = {}) {
  const asked: Array<string | undefined> = [];
  const downloads: string[] = [];
  const engine: MediaEngine = {
    async resolve(_url, _signal, quality = '1080') {
      asked.push(quality);
      const rung = rungs.find((candidate) => candidate.quality === quality);
      return { items: rung ? [item(rung.url)] : [], title: null, artist: null };
    },
    async download(target, dir) {
      downloads.push(target.url);
      if (opts.fail === target.url) throw new Coded(E.NO_MEDIA, 'host refused');
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `${target.kind}-${downloads.length}.mp4`);
      const fd = openSync(path, 'w');
      ftruncateSync(fd, rungs.find((rung) => rung.url === target.url)?.fileSize ?? 1024);
      closeSync(fd);
      return path;
    },
  };
  if (opts.size !== false) engine.size = async (target) => rungs.find((rung) => rung.url === target.url)?.size ?? null;
  return { engine, asked, downloads };
}

const work = (): string => mkdtempSync(join(tmpdir(), 'feedberry-stage5-'));
const options = (extra: { ladderUrl?: string } = {}) => ({ maxMb: 500, signal: new AbortController().signal, ...extra });
const ppm = (width: number, height: number): Buffer => Buffer.from(`P6\n${width} ${height}\n255\n\0\0\0`);

test('stage 5: a clip under the ceiling is downloaded and rides inline', async () => {
  const dir = work();
  const { engine, downloads } = engineOf([{ quality: '1080', url: URL_1080, size: 40 * MB }]);
  try {
    const files = await prepareMedia(engine, [item(URL_1080)], dir, options());

    assert.deepEqual(downloads, [URL_1080]);
    assert.equal(files[0]?.path === '' ? 'link' : 'inline', 'inline');
    assert.equal(files[0]?.url, URL_1080);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('stage 5: a clip over the ceiling is linked, never downloaded', async () => {
  const dir = work();
  const { engine, downloads } = engineOf([{ quality: '1080', url: URL_1080, size: OVER }]);
  try {
    const files = await prepareMedia(engine, [item(URL_1080)], dir, options());

    assert.deepEqual(downloads, [], 'not one byte of a 51 MB file');
    assert.equal(files[0]?.path, '');
    assert.equal(files[0]?.url, URL_1080, 'the caption has its direct link');
    assert.equal(files[0]?.size, 0, 'and nothing is charged to the upload budget');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('stage 5: X steps down to 720 when the 1080 file is too big', async () => {
  const dir = work();
  const { engine, downloads } = engineOf([
    { quality: '1080', url: URL_1080, size: 200 * MB },
    { quality: '720', url: URL_720, size: 40 * MB },
  ]);
  try {
    const files = await prepareMedia(engine, [item(URL_1080)], dir, options({ ladderUrl: POST }));

    assert.deepEqual(downloads, [URL_720], 'only the rung that fits is pulled');
    assert.equal(files[0]?.path === '' ? 'link' : 'inline', 'inline');
    assert.equal(files[0]?.url, URL_720);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('stage 5: when every rung is too big the 1080 URL is the link', async () => {
  const dir = work();
  const { engine, downloads, asked } = engineOf([
    { quality: '1080', url: URL_1080, size: 491 * MB },
    { quality: '720', url: URL_720, size: 186 * MB },
    { quality: '480', url: URL_480, size: 77 * MB },
  ]);
  try {
    const files = await prepareMedia(engine, [item(URL_1080)], dir, options({ ladderUrl: POST }));

    assert.deepEqual(asked, ['720', '480'], 'both lower rungs were tried; rung one was the caller\'s resolve');
    assert.deepEqual(downloads, [], 'and none was pulled');
    assert.equal(files[0]?.path, '');
    assert.equal(files[0]?.url, URL_1080, 'the best quality the post offers is what the reader can open');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('stage 5: a native 720p clip is not probed twice before 480 is tried', async () => {
  const dir = work();
  const { engine, asked, downloads } = engineOf([
    // Twitter answers the 1080 request with the native 720 file: the same URL twice.
    { quality: '1080', url: URL_720, size: 60 * MB },
    { quality: '720', url: URL_720, size: 60 * MB },
    { quality: '480', url: URL_480, size: 30 * MB },
  ]);
  try {
    const files = await prepareMedia(engine, [item(URL_720)], dir, options({ ladderUrl: POST }));

    assert.deepEqual(asked, ['720', '480'], 'rung one is the resolve the caller already paid for');
    assert.deepEqual(downloads, [URL_480]);
    assert.equal(files[0]?.path === '' ? 'link' : 'inline', 'inline');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('stage 5: a host that will not name the size still cannot slip a big file through', async () => {
  const dir = work();
  const { engine, downloads } = engineOf([{ quality: '1080', url: URL_1080, size: null, fileSize: OVER }], { size: false });
  try {
    const files = await prepareMedia(engine, [item(URL_1080)], dir, options());

    assert.deepEqual(downloads, [URL_1080], 'the only way to learn the size was to pull it');
    assert.equal(files[0]?.path, '', 'and the bytes are gone again');
    assert.equal(files[0]?.url, URL_1080);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('stage 5: a muxed result retains the requested top-quality direct URL', async () => {
  const dir = work();
  const { engine } = engineOf([{ quality: '1080', url: URL_1080, size: 200 * MB }]);
  try {
    const files = await prepareMedia(engine, [item(URL_1080, { audio: 'https://cdn.test/1080.m4a' })], dir, options({ ladderUrl: 'https://youtube.com/watch?v=abc' }));

    assert.equal(files[0]?.path, '');
    assert.equal(files[0]?.url, URL_1080, 'the post page is already linked in the header');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('stage 5: an unknown-size transfer hits the cap and tries the next quality', async () => {
  const dir = work();
  const { engine, asked, downloads } = engineOf([
    { quality: '1080', url: URL_1080, size: null },
    { quality: '720', url: URL_720, size: null },
  ]);
  const save = engine.download;
  engine.download = async (target, into, signal, maxBytes) => {
    assert.equal(maxBytes, 50 * MB, 'the limit reaches the streaming downloader');
    if (target.url === URL_1080) throw new Coded(E.TOO_LARGE, 'stream crossed the cap');
    return save(target, into, signal, maxBytes);
  };
  try {
    const files = await prepareMedia(engine, [item(URL_1080)], dir, options({ ladderUrl: POST }));

    assert.deepEqual(asked, ['720']);
    assert.deepEqual(downloads, [URL_720]);
    assert.notEqual(files[0]?.path, '');
    assert.equal(files[0]?.url, URL_720);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('stage 5: a failed download is a link, not a lost post', async () => {
  const dir = work();
  const { engine } = engineOf([{ quality: '1080', url: URL_1080, size: 10 * MB }], { fail: URL_1080 });
  try {
    const files = await prepareMedia(engine, [item(URL_1080)], dir, options());

    assert.equal(files.length, 1);
    assert.equal(files[0]?.path, '');
    assert.equal(files[0]?.url, URL_1080);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('stage 5: each video of a carousel climbs its own ladder', async () => {
  const dir = work();
  const second = 'https://cdn.test/second-1080.mp4';
  const byQuality: Record<string, Array<{ url: string; size: number }>> = {
    '1080': [{ url: URL_1080, size: 200 * MB }, { url: second, size: 30 * MB }],
    '720': [{ url: URL_720, size: 40 * MB }, { url: 'https://cdn.test/second-720.mp4', size: 20 * MB }],
  };
  const downloads: string[] = [];
  const engine: MediaEngine = {
    async resolve(_url, _signal, quality = '1080') {
      return { items: (byQuality[quality] ?? []).map((rung) => item(rung.url)), title: null, artist: null };
    },
    async size(target) {
      const rung = Object.values(byQuality).flat().find((candidate) => candidate.url === target.url);
      return rung?.size ?? null;
    },
    async download(target, into) {
      downloads.push(target.url);
      mkdirSync(into, { recursive: true });
      const path = join(into, `clip-${downloads.length}.mp4`);
      const fd = openSync(path, 'w');
      ftruncateSync(fd, 1024);
      closeSync(fd);
      return path;
    },
  };
  try {
    const files = await prepareMedia(engine, [item(URL_1080), item(second)], dir, options({ ladderUrl: POST }));

    assert.deepEqual(downloads, [URL_720, second], 'only the first video steps down');
    assert.deepEqual(files.map((file) => file.path === '' ? 'link' : 'inline'), ['inline', 'inline']);
    assert.deepEqual(files.map((file) => file.url), [URL_720, second]);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('ADR-027: a linked clip brings its own poster into the message', async () => {
  const dir = work();
  const poster = 'https://cdn.test/poster.jpg';
  const { engine, downloads } = engineOf([{ quality: '1080', url: URL_1080, size: OVER }]);
  let asked = 0;
  try {
    const files = await prepareMedia(engine, [item(URL_1080, { poster })], dir, { ...options(), poster: async () => { asked++; return null; } });

    assert.deepEqual(downloads, [poster], 'the poster is the only thing pulled');
    assert.deepEqual(files.map((file) => file.kind), ['video', 'photo']);
    assert.equal(files[0]?.path, '', 'the clip itself stays a link');
    assert.equal(files[1]?.url, poster);
    assert.equal(asked, 0, 'the extractor poster answered, so the page was never read');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('ADR-027: without an extractor poster the page\'s own image is used, once', async () => {
  const dir = work();
  const poster = 'https://cdn.test/og.jpg';
  const { engine } = engineOf([{ quality: '1080', url: URL_1080, size: OVER }]);
  let asked = 0;
  try {
    const files = await prepareMedia(engine, [item(URL_1080)], dir, { ...options(), poster: async () => { asked++; return poster; } });

    assert.equal(asked, 1);
    assert.deepEqual(files.map((file) => file.kind), ['video', 'photo']);
    assert.equal(files[1]?.url, poster);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('ADR-027: an inline clip asks for no poster at all', async () => {
  const dir = work();
  const { engine, downloads } = engineOf([{ quality: '1080', url: URL_1080, size: 40 * MB }]);
  let asked = 0;
  try {
    const files = await prepareMedia(engine, [item(URL_1080)], dir, { ...options(), poster: async () => { asked++; return 'https://cdn.test/og.jpg'; } });

    assert.equal(asked, 0, 'no page fetch on the common path');
    assert.deepEqual(downloads, [URL_1080]);
    assert.deepEqual(files.map((file) => file.kind), ['video']);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('ADR-027: a dead poster URL still ships the clip and its label', async () => {
  const dir = work();
  const poster = 'https://cdn.test/dead.jpg';
  const { engine } = engineOf([{ quality: '1080', url: URL_1080, size: OVER }], { fail: poster });
  try {
    const files = await prepareMedia(engine, [item(URL_1080, { poster })], dir, options());

    assert.deepEqual(files.map((file) => file.kind), ['video']);
    assert.equal(files[0]?.path, '');
    assert.equal(files[0]?.url, URL_1080);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('ADR-027: the poster is added once, however many times the pipeline asks', async () => {
  const dir = work();
  const poster = 'https://cdn.test/poster.jpg';
  const { engine, downloads } = engineOf([{ quality: '1080', url: URL_1080, size: OVER }]);
  try {
    const files = await prepareMedia(engine, [item(URL_1080, { poster })], dir, options());
    const again = await withPosters(engine, files, dir, { signal: new AbortController().signal });

    assert.deepEqual(again, [], 'a poster already in the gallery is not uploaded twice');
    assert.deepEqual(downloads, [poster], 'and never re-downloaded');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('stage 5: each album item gets a fresh transfer budget', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const dir = work();
  const signals: AbortSignal[] = [];
  let downloads = 0;
  const engine: MediaEngine = {
    async resolve() { throw new Error('not used'); },
    async download(_item, into, signal) {
      signals.push(signal);
      downloads++;
      if (downloads === 1) {
        await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Coded(E.NO_MEDIA, 'budget expired')), { once: true }));
      }
      const path = join(into, `${downloads}.jpg`);
      writeFileSync(path, 'x');
      return path;
    },
  };
  try {
    const pending = prepareMedia(engine, [
      { kind: 'photo', url: URL_1080, picker: false },
      { kind: 'photo', url: URL_720, picker: false },
      { kind: 'photo', url: URL_480, picker: false },
    ], dir, { maxMb: 500 });
    await Promise.resolve();
    t.mock.timers.tick(DOWNLOAD_BUDGET_MS + 1);
    await Promise.resolve();
    const files = await pending;

    assert.equal(signals.length, 3);
    assert.notEqual(signals[0], signals[1]);
    assert.notEqual(signals[1], signals[2]);
    assert.equal(signals[0]?.aborted, true);
    assert.equal(signals[1]?.aborted, false);
    assert.equal(files.filter((file) => file.path !== '').length, 2, 'the first timeout does not empty the album');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('stage 5: caller cancellation stops the remaining album items', async () => {
  const dir = work();
  const caller = new AbortController();
  let downloads = 0;
  const engine: MediaEngine = {
    async resolve() { throw new Error('not used'); },
    async download(_item, _into, signal) {
      downloads++;
      await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Coded(E.NO_MEDIA, 'cancelled')), { once: true }));
      throw new Error('unreachable');
    },
  };
  try {
    const pending = prepareMedia(engine, [
      { kind: 'photo', url: URL_1080, picker: false },
      { kind: 'photo', url: URL_720, picker: false },
    ], dir, { maxMb: 500, signal: caller.signal });
    await Promise.resolve();
    caller.abort();
    assert.deepEqual(await pending, []);
    assert.equal(downloads, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('stage 5: a poster operation gets a fresh signal after the video size probe', async () => {
  const dir = work();
  const poster = 'https://cdn.test/poster.jpg';
  const signals: AbortSignal[] = [];
  const engine: MediaEngine = {
    async resolve() { throw new Error('not used'); },
    async size(_item, signal) { signals.push(signal); return OVER; },
    async download(_item, into, signal) {
      signals.push(signal);
      const path = join(into, 'poster.jpg');
      writeFileSync(path, 'x');
      return path;
    },
  };
  try {
    const files = await prepareMedia(engine, [item(URL_1080, { poster })], dir, options());
    assert.equal(files[0]?.path, '');
    assert.equal(files[1]?.url, poster);
    assert.equal(signals.length, 2);
    assert.notEqual(signals[0], signals[1]);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('Telegram photo dimensions enforce the sum and aspect-ratio boundaries', () => {
  assert.equal(telegramPhotoFits({ width: 1, height: 1 }), true);
  assert.equal(telegramPhotoFits({ width: 5000, height: 5000 }), true);
  assert.equal(telegramPhotoFits({ width: 5000, height: 5001 }), false);
  assert.equal(telegramPhotoFits({ width: 20, height: 1 }), true);
  assert.equal(telegramPhotoFits({ width: 21, height: 1 }), false);
  for (const dimensions of [{ width: 0, height: 1 }, { width: -1, height: 1 }, { width: 1.5, height: 1 }, { width: NaN, height: 1 }, { width: Infinity, height: 1 }]) {
    assert.equal(telegramPhotoFits(dimensions), false);
  }
});

test('stage 5: ffprobe rejects and deletes a known-invalid photo', { skip: !hasFFmpeg() }, async () => {
  const dir = work();
  const invalid = join(dir, 'invalid.ppm');
  writeFileSync(invalid, ppm(9000, 1001));
  try {
    assert.deepEqual(await probeDimensions(invalid), { width: 9000, height: 1001 });
    const engine: MediaEngine = {
      async resolve() { throw new Error('not used'); },
      async download(_item, into) {
        const path = join(into, 'photo.ppm');
        writeFileSync(path, ppm(9000, 1001));
        return path;
      },
    };
    assert.deepEqual(await prepareMedia(engine, [{ kind: 'photo', url: URL_1080, picker: false }], dir, options()), []);
    assert.equal(existsSync(join(dir, 'photo.ppm')), false);
    assert.equal(await probeDimensions(join(dir, 'missing.jpg')), null);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('stage 5: a known-invalid poster is omitted while its linked video remains', { skip: !hasFFmpeg() }, async () => {
  const dir = work();
  const poster = 'https://cdn.test/poster.jpg';
  const posterPath = join(dir, 'poster.ppm');
  const engine: MediaEngine = {
    async resolve() { throw new Error('not used'); },
    async size() { return OVER; },
    async download(_item, into) {
      const path = join(into, 'poster.ppm');
      writeFileSync(path, ppm(9000, 1001));
      return path;
    },
  };
  try {
    const files = await prepareMedia(engine, [item(URL_1080, { poster })], dir, options());
    assert.deepEqual(files.map((file) => ({ kind: file.kind, path: file.path })), [{ kind: 'video', path: '' }]);
    assert.equal(existsSync(posterPath), false);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('ADR-028: the transfer budget carries a full clip on a slow line, extraction stays short', () => {
  // A 50 MB file inside the budget means the link must stay usable at roughly 1.2 Mbps or better.
  assert.ok((50 * MB) / (DOWNLOAD_BUDGET_MS / 1000) >= 150_000, `${DOWNLOAD_BUDGET_MS} ms is too tight for a 50 MB clip`);
  assert.ok(DOWNLOAD_BUDGET_MS > EXTRACT_BUDGET_MS, 'the transfer is never the short budget');
  assert.equal(mediaSignal(5).aborted, false, 'a fresh signal starts live');
});

test('stage 5: a post over the total cap links its biggest clip and keeps the rest', async () => {
  const dir = work();
  const second = 'https://cdn.test/second.mp4';
  const { engine, downloads } = engineOf([
    { quality: '1080', url: URL_1080, size: 8 * MB, fileSize: 8 * MB },
    { quality: '1080', url: second, size: 4 * MB, fileSize: 4 * MB },
  ]);
  try {
    const files = await prepareMedia(engine, [item(URL_1080), item(second)], dir, { maxMb: 10, signal: new AbortController().signal });

    assert.deepEqual(downloads, [URL_1080, second], 'each clip fits the upload ceiling on its own');
    assert.deepEqual(files.map((file) => (file.path === '' ? 'link' : 'inline')), ['link', 'inline'], 'the biggest gave way, the post still ships');
    assert.equal(files[0]?.url, URL_1080, 'and its label carries the direct URL');
    assert.equal(files[1]?.size, 4 * MB, 'the clip that fits is untouched');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('stage 5: the RSS album keeps the bytes it needs for a stand-in frame', async () => {
  const dir = work();
  const { engine, downloads } = engineOf([{ quality: '1080', url: URL_1080, size: OVER }]);
  try {
    const files = await prepareMedia(engine, [item(URL_1080)], dir, { ...options(), keepOversizedVideo: true });

    assert.deepEqual(downloads, [URL_1080], 'ADR-022 still trades one download for a frame');
    assert.ok(files[0] !== undefined && files[0].path !== '' && existsSync(files[0].path));
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
