import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { hasFFmpeg } from 'cobalt-engine';
import { log } from '../obs/log.ts';
import type { MediaFile } from '../render/plan.ts';
import { overCeiling } from '../render/video.ts';

const run = promisify(execFile);
let frameSeq = 0;

export type Thumbnailer = (videoFile: string, dir: string) => Promise<string | null>;

/**
 * §8.6: the platform poster first (the caller passes it), else one ffmpeg frame at 1 s.
 * Returns null when ffmpeg is absent — the caller then falls back to a plain link card (R14).
 */
export const ffmpegThumbnail: Thumbnailer = async (videoFile, dir) => {
  if (!hasFFmpeg()) return null;
  // One post can need a frame per oversized video (R15), so two calls must not share a name.
  const target = join(dir, `thumb-${++frameSeq}.jpg`);
  try {
    await run('ffmpeg', ['-y', '-ss', '1', '-i', videoFile, '-frames:v', '1', '-q:v', '4', target], { timeout: 15_000 });
    return target;
  } catch (err) {
    log('warn', 'thumb_failed', { cause: err instanceof Error ? err.message : String(err) });
    return null;
  }
};

/** R15: one frame per oversized video, so an album still shows what it could not upload. */
export async function standInFrames(files: MediaFile[], dir: string, thumbnail: Thumbnailer): Promise<MediaFile[]> {
  const frames: MediaFile[] = [];
  for (const file of files) {
    if (file.kind !== 'video' || !overCeiling(file)) continue;
    const path = await thumbnail(file.path, dir);
    if (path !== null) frames.push({ path, kind: 'photo', size: (await stat(path)).size });
  }
  return frames;
}
