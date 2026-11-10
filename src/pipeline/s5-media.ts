import { stat } from 'node:fs/promises';
import type { MediaEngine, MediaItem } from '../media/cobalt.ts';
import { Coded, E } from '../platform/errors.ts';
import type { MediaFile } from '../render/plan.ts';
import { overCeiling } from '../render/video.ts';

export interface PrepareOptions {
  maxMb: number;
  signal: AbortSignal;
}

/**
 * A media operation must not outlive a job. `AbortSignal.timeout` would hold the process open for
 * its whole duration, so the timer is unref'd here.
 */
export function mediaSignal(ms = 120_000): AbortSignal {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  timer.unref?.();
  return controller.signal;
}

/**
 * Stage 5: resolve metadata is already done by the caller; this downloads each item into `dir` and
 * enforces MAX_DOWNLOAD_MB.
 * shortcut: the cap is checked after the bytes land because resolve() reports no size; the
 * protected resource is the upload, not the disk. A video past the upload ceiling is therefore
 * downloaded once for its frame and then withheld from every send (R15).
 */
export async function prepareMedia(engine: MediaEngine, items: MediaItem[], dir: string, options: PrepareOptions): Promise<MediaFile[]> {
  const files: MediaFile[] = [];
  for (const item of items) {
    const path = await engine.download(item, dir, options.signal);
    files.push({ path, kind: item.kind, size: (await stat(path)).size, url: item.url });
  }

  // R15: only a video is withheld from every send; every other file is still uploaded, so it still
  // spends the budget that guards the upload.
  const withheld = (file: MediaFile): boolean => file.kind === 'video' && overCeiling(file);
  const total = files.filter((file) => !withheld(file)).reduce((sum, file) => sum + file.size, 0);
  if (total > options.maxMb * 1024 * 1024) throw new Coded(E.TOO_LARGE, `${total} bytes over ${options.maxMb} MB`);
  return files;
}
