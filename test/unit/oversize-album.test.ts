/**
 * R15 (§8.1): a video past the Bot API's 50 MB ceiling cannot ride in an album. It leaves a frame
 * and one clickable line in the caption behind, and the rest of the post still ships.
 */
import assert from 'node:assert/strict';
import { closeSync, copyFileSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { PostRow } from '../../src/db/repos/posts.ts';
import type { MediaEngine, MediaItem } from '../../src/media/media-engine.ts';
import { standInFrames } from '../../src/media/thumbnail.ts';
import { prepareMedia } from '../../src/pipeline/prepare-media.ts';
import { renderDownload, renderPost } from '../../src/pipeline/render-post.ts';
import { Coded, E, isCoded } from '../../src/platform/errors.ts';
import type { MediaFile } from '../../src/render/message-plan.ts';
import { renderVideo } from '../../src/render/video.ts';

const PHOTO = fileURLToPath(new URL('../fixtures/media/photo.jpg', import.meta.url));
const OVER = 51 * 1024 * 1024;
const BIG = 'https://video.twimg.com/amplify_video/2120186300917542912/vid/avc1/848x464/M_Hex2T7T_vKTl70.mp4?tag=29';

const post: PostRow = {
  id: 7,
  source_id: 1,
  guid: 'guid',
  url: 'https://x.com/Royal/status/1',
  published_at: Date.UTC(2026, 10, 10, 16, 7),
  kind: 'album',
  payload_json: JSON.stringify({ title: 'Three clips, one too big', summary: null, media: [] }),
  first_seen_at: 0,
};

/** Two clips that fit, one that does not, two photos, and the frame standing in for the big clip. */
const poster = (): MediaFile[] => [
  { path: 'v1.mp4', kind: 'video', size: 20 * 1024 * 1024, url: 'https://cdn.test/v1.mp4' },
  { path: 'v2.mp4', kind: 'video', size: 20 * 1024 * 1024, url: 'https://cdn.test/v2.mp4' },
  { path: 'v3.mp4', kind: 'video', size: OVER, url: BIG },
  { path: 'i1.jpg', kind: 'photo', size: 1024, url: 'https://cdn.test/i1.jpg' },
  { path: 'i2.jpg', kind: 'photo', size: 1024, url: 'https://cdn.test/i2.jpg' },
  { path: 'thumb-1.jpg', kind: 'photo', size: 1024 },
];

test('R15: a video past the ceiling links from the caption and never enters the album', () => {
  const plan = renderPost(post, 'album', poster(), { platform: 'x', sourceTitle: '@Royal' });
  assert.equal(plan.kind, 'album');
  if (plan.kind !== 'album') return;

  assert.deepEqual(
    plan.items.map((item) => item.file),
    ['v1.mp4', 'v2.mp4', 'i1.jpg', 'i2.jpg', 'thumb-1.jpg'],
    'the 51 MB clip is left out; its frame takes the last slot',
  );
  assert.match(plan.caption, /^🌐 <a href="https:\/\/x\.com\/Royal\/status\/1">@Royal<\/a> \| X\n⏱️ Time: 11\/10 16:07/);
  assert.ok(plan.caption.endsWith(`🎬 ${BIG}`), `the caption ends with the direct link:\n${plan.caption}`);
  assert.equal(plan.caption.match(/🎬/g)?.length, 1, 'one line per oversized video');
});

test('R15: an album with nothing left to upload still ships its words and every link', () => {
  const plan = renderPost(post, 'album', [{ path: 'v3.mp4', kind: 'video', size: OVER, url: BIG }], { platform: 'x', sourceTitle: '@Royal' });

  assert.equal(plan.kind, 'text', 'no empty sendMediaGroup is ever attempted');
  assert.ok(plan.kind === 'text' && plan.text.endsWith(`🎬 ${BIG}`));
});

test('R15: one survivor travels as a single video, never a one-item group', () => {
  const files: MediaFile[] = [
    { path: 'v1.mp4', kind: 'video', size: 1024, url: 'https://cdn.test/v1.mp4' },
    { path: 'v3.mp4', kind: 'video', size: OVER, url: BIG },
  ];
  const plan = renderPost(post, 'album', files, { platform: 'x', sourceTitle: '@Royal' });

  assert.equal(plan.kind, 'video', 'sendMediaGroup refuses fewer than two items');
  assert.ok(plan.kind === 'video' && plan.caption.endsWith(`🎬 ${BIG}`));
});

test('R15: Download Mode applies the same rule to a carousel', () => {
  const plan = renderDownload(poster(), { title: 'Three clips', artist: '@Royal', platform: 'x' }, 'https://x.com/Royal/status/1');

  assert.equal(plan.kind, 'album');
  if (plan.kind !== 'album') return;
  assert.deepEqual(plan.items.map((item) => item.file), ['v1.mp4', 'v2.mp4', 'i1.jpg', 'i2.jpg', 'thumb-1.jpg']);
  assert.ok(plan.caption.endsWith(`🎬 ${BIG}`));
});

/** A fake engine whose files land as sparse bytes of the requested size. */
const engineOf = (sizes: number[]): MediaEngine => {
  let n = 0;
  return {
    async resolve() {
      return { items: [], title: null, artist: null };
    },
    async download(item, dir) {
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `${item.kind}-${++n}`);
      const size = sizes.shift() ?? 0;
      if (size > 0) {
        const fd = openSync(path, 'w');
        ftruncateSync(fd, size);
        closeSync(fd);
      } else copyFileSync(PHOTO, path);
      return path;
    },
  };
};

const video = (url: string): MediaItem => ({ kind: 'video', url, picker: false });
const photo = (url: string): MediaItem => ({ kind: 'photo', url, picker: false });

test('R15: the download budget counts only what can be uploaded', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-r15-'));
  try {
    // A 10 MB budget: the 51 MB clip alone tripped it before R15 and the whole post became a link.
    const files = await prepareMedia(engineOf([OVER, 0]), [video(BIG), photo('https://cdn.test/i.jpg')], dir, { maxMb: 10, signal: new AbortController().signal });

    assert.equal(files.length, 2, 'the clip stays on disk, for its frame');
    assert.equal(files[0]?.url, BIG, 'and the caption has something to link');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('R15: a frame is only asked for where a video was withheld', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-r15-frames-'));
  const asked: string[] = [];
  const thumbnail = async (video: string, into: string): Promise<string | null> => {
    asked.push(video);
    const path = join(into, `frame-${asked.length}.jpg`);
    copyFileSync(PHOTO, path);
    return path;
  };

  try {
    const frames = await standInFrames(poster(), dir, thumbnail);

    assert.deepEqual(asked, ['v3.mp4'], 'the two clips that fit and the photos are never asked for');
    assert.deepEqual(frames.map((frame) => frame.kind), ['photo']);
    assert.ok(frames[0] !== undefined && frames[0].size > 0, 'the frame lands as a real photo item');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('R15: a download that fails is a link, not a lost post', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-r15-fail-'));
  const engine: MediaEngine = {
    async resolve() {
      return { items: [], title: null, artist: null };
    },
    async download(item, into) {
      // The 51 MB wall in the wild: a transfer that times out and reports "no media".
      if (item.url === BIG) throw new Coded(E.NO_MEDIA, 'HTTP 403 for media URL');
      mkdirSync(into, { recursive: true });
      const path = join(into, 'photo.jpg');
      copyFileSync(PHOTO, path);
      return path;
    },
  };

  try {
    const files = await prepareMedia(engine, [video(BIG), photo('https://cdn.test/i1.jpg')], dir, { maxMb: 10, signal: new AbortController().signal });

    assert.equal(files.length, 2, 'the photo still arrives');
    assert.equal(files[0]?.path, '', 'the video left no bytes behind');
    assert.equal(files[0]?.url, BIG, 'but its link is kept');

    const plan = renderPost(post, 'album', files, { platform: 'x', sourceTitle: '@Royal' });
    assert.equal(plan.kind, 'photo', 'the photo is not dragged into a one-item group');
    assert.ok(plan.kind === 'photo' && plan.caption.endsWith(`🎬 ${BIG}`), 'and the caption still links the clip');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('R15: a lone oversized video links its own media file, not the post page', () => {
  const plan = renderVideo({ path: 'v.mp4', kind: 'video', size: OVER, url: BIG }, 'body', { durationSec: null, thumbnail: null, link: 'https://x.com/Royal/status/1' });

  assert.equal(plan.kind, 'link_only');
  assert.ok(plan.kind === 'link_only' && plan.text.endsWith(`🎬 ${BIG}`), 'the reader can play what we could not upload');
  assert.ok(plan.kind === 'link_only' && !plan.text.includes('https://x.com/Royal/status/1'), 'the post page is already the header link');
});

test('R15: the preview caption names the file, and the post link stays the follow-up message', () => {
  const plan = renderVideo({ path: 'v.mp4', kind: 'video', size: OVER, url: BIG }, 'body', { durationSec: null, thumbnail: 'thumb.jpg', link: 'https://x.com/Royal/status/1' });

  assert.equal(plan.kind, 'thumbnail');
  assert.ok(plan.kind === 'thumbnail' && plan.caption.endsWith(`🎬 ${BIG}`));
  assert.ok(plan.kind === 'thumbnail' && plan.link === 'https://x.com/Royal/status/1');
});

test('R8: a long clip that fits still links the post, because the file is playable at the source', () => {
  const plan = renderVideo({ path: 'v.mp4', kind: 'video', size: 1024, url: BIG }, 'body', { durationSec: 250, thumbnail: null, link: 'https://x.com/Royal/status/1' });

  assert.equal(plan.kind, 'link_only');
  assert.ok(plan.kind === 'link_only' && plan.text.endsWith('https://x.com/Royal/status/1'));
  assert.doesNotMatch(plan.kind === 'link_only' ? plan.text : '', /🎬/);
});

test('R15: the upload budget still refuses a batch that only just fits nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-r15-cap-'));
  try {
    const engine = engineOf([11 * 1024 * 1024]);
    await assert.rejects(
      prepareMedia(engine, [photo('https://cdn.test/big.jpg')], dir, { maxMb: 10, signal: new AbortController().signal }),
      (err: unknown) => isCoded(err) && err.code === E.TOO_LARGE,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
