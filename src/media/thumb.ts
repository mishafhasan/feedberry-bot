import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { hasFFmpeg } from 'cobalt-engine';
import { log } from '../obs/log.ts';

const run = promisify(execFile);

export type Thumbnailer = (videoFile: string, dir: string) => Promise<string | null>;

/**
 * §8.6: the platform poster first (the caller passes it), else one ffmpeg frame at 1 s.
 * Returns null when ffmpeg is absent — the caller then falls back to a plain link card (R14).
 */
export const ffmpegThumbnail: Thumbnailer = async (videoFile, dir) => {
  if (!hasFFmpeg()) return null;
  const target = join(dir, 'thumb.jpg');
  try {
    await run('ffmpeg', ['-y', '-ss', '1', '-i', videoFile, '-frames:v', '1', '-q:v', '4', target], { timeout: 15_000 });
    return target;
  } catch (err) {
    log('warn', 'thumb_failed', { cause: err instanceof Error ? err.message : String(err) });
    return null;
  }
};
