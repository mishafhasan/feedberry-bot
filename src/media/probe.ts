import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { hasFFmpeg } from 'cobalt-engine';

const run = promisify(execFile);

/**
 * §8.6 order: ffprobe first (when ffmpeg is installed), then whatever the feed or the platform
 * already told us, then "unknown". cobalt exposes no duration today, hence the fallbacks.
 */
export async function probeDuration(file: string): Promise<number | null> {
  if (!hasFFmpeg()) return null;
  try {
    const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { timeout: 5000 });
    const seconds = Number.parseFloat(stdout.trim());
    return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
  } catch {
    return null;
  }
}

/** The feed's `itunes:duration` / `media:content duration`, when the platform provided one. */
export function durationFromHint(hint: number | null | undefined): number | null {
  return typeof hint === 'number' && Number.isFinite(hint) && hint > 0 ? hint : null;
}
