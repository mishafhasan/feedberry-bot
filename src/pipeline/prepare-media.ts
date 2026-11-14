import { rm, stat } from 'node:fs/promises';
import type { MediaEngine, MediaItem } from '../media/media-engine.ts';
import { log } from '../obs/log.ts';
import { Coded, E, isCoded } from '../platform/errors.ts';
import type { MediaFile } from '../render/message-plan.ts';
import { MAX_UPLOAD_BYTES, overCeiling } from '../render/video.ts';

export interface PrepareOptions {
  maxMb: number;
  signal: AbortSignal;
  /** X and YouTube: the post link to resolve again one rung down instead of pulling a clip too big. */
  ladderUrl?: string;
  /** ADR-022: an RSS album keeps the bytes of an oversized clip, because its stand-in frame is cut from them. */
  keepOversizedVideo?: boolean;
  /**
   * ADR-027, called only when a clip ends up link-only and the extractor named no poster: the page's
   * own `og:image`. One page fetch on the rare oversized post, never on the common inline one.
   */
  poster?: () => Promise<string | null>;
}

/** The quality ladder of X and YouTube; the caller's item is already the top rung. */
const RUNGS = ['1080', '720', '480'] as const;

/**
 * The post link stage 5 may resolve again at a lower rung. Only these platforms publish several
 * renditions of one clip, so only they can trade resolution for a file that fits.
 */
export const ladderFor = (platform: string, url: string | null): string | undefined =>
  url !== null && (platform === 'x' || platform === 'youtube') ? url : undefined;

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
 * ADR-028: the transfer budget is sized by the ceiling, not by a feeling. A 50 MB clip on a 1.5 Mbps
 * line needs ~4.5 minutes, so the old shared 120 s window turned a fine download into a `🎬` label at
 * random — the same post attached or linked depending on the network of the moment. Extraction and
 * metadata stay short, because those are small requests.
 */
export const EXTRACT_BUDGET_MS = 30_000;
export const DOWNLOAD_BUDGET_MS = 300_000;

/**
 * Stage 5: resolve metadata is already done by the caller; this downloads each item into `dir` and
 * enforces MAX_DOWNLOAD_MB.
 * A video is decided by its size, never by a download: past the upload ceiling it keeps a link
 * instead of bytes, and X/YouTube walk the ladder until a rung fits (ADR-026).
 */
export async function prepareMedia(engine: MediaEngine, items: MediaItem[], dir: string, options: PrepareOptions): Promise<MediaFile[]> {
  const files: MediaFile[] = [];
  for (const [index, item] of items.entries()) {
    try {
      files.push(item.kind === 'video' ? await videoFile(engine, item, index, dir, options) : await saved(engine, item, dir, options));
    } catch (err) {
      // A big file is the one most likely to time out mid-transfer, and cobalt reports that as
      // "no media". Keep the post: the video links from the caption, the rest of it still ships.
      log('warn', 'media_item_failed', { kind: item.kind, code: isCoded(err) ? err.code : 'unknown' });
      if (item.kind === 'video') files.push({ path: '', kind: 'video', size: 0, url: item.url, ...(item.poster !== undefined && { poster: item.poster }) });
    }
  }

  // R15: only a video is withheld from every send; every other file is still uploaded, so it still
  // spends the budget that guards the upload.
  const withheld = (file: MediaFile): boolean => file.kind === 'video' && overCeiling(file);
  const total = files.filter((file) => !withheld(file)).reduce((sum, file) => sum + file.size, 0);
  if (total > options.maxMb * 1024 * 1024) throw new Coded(E.TOO_LARGE, `${total} bytes over ${options.maxMb} MB`);
  return [...files, ...(await withPosters(engine, files, dir, options))];
}

/**
 * ADR-027: a clip too big to send still shows its face. The extractor's own poster is free; otherwise
 * the page's `og:image` is asked for once, and the picture rides in the slideshow beside the label.
 * Exported because a page adapter (a YouTube community post) also hands over link-only clips.
 */
export async function withPosters(
  engine: MediaEngine,
  files: MediaFile[],
  dir: string,
  options: Pick<PrepareOptions, 'signal' | 'poster' | 'keepOversizedVideo'>,
): Promise<MediaFile[]> {
  const linked = files.filter((file) => file.kind === 'video' && file.path === '');
  if (linked.length === 0 || options.keepOversizedVideo === true) return [];
  const poster = linked.map((file) => file.poster).find((url) => url !== undefined) ?? (await options.poster?.() ?? null);
  // The post may already upload this very picture; twice would look like a broken gallery.
  if (poster === null || files.some((file) => file.url === poster)) return [];
  const photo = await posterFile(engine, poster, dir, options.signal);
  return photo === null ? [] : [photo];
}

/** The poster as an uploadable photo; a dead image URL never costs the post. */
async function posterFile(engine: MediaEngine, url: string, dir: string, signal: AbortSignal): Promise<MediaFile | null> {
  try {
    const path = await engine.download({ kind: 'photo', url, picker: false }, dir, signal);
    return { path, kind: 'photo', size: (await stat(path)).size, url };
  } catch (err) {
    log('warn', 'poster_failed', { code: isCoded(err) ? err.code : 'unknown' });
    return null;
  }
}

/** Every other kind: pull it and report what landed. */
async function saved(engine: MediaEngine, item: MediaItem, dir: string, options: PrepareOptions): Promise<MediaFile> {
  const path = await engine.download(item, dir, options.signal);
  return { path, kind: item.kind, size: (await stat(path)).size, url: item.url };
}

/**
 * The first rung whose file fits the Bot API ceiling, or no bytes at all. The link keeps the best
 * quality the post offers: rung one's URL, or the post itself when the file is two tracks and so no
 * single URL plays.
 */
async function videoFile(engine: MediaEngine, first: MediaItem, index: number, dir: string, options: PrepareOptions): Promise<MediaFile> {
  const url = options.ladderUrl;
  // Rung one is the resolve the caller already paid for; only the rungs below it cost another.
  const rungs: Array<string | null> = url === undefined ? [null] : [null, ...RUNGS.slice(1)];
  const tried: string[] = [];
  for (const quality of rungs) {
    const item = quality === null || url === undefined ? first : await lowerRung(engine, url, quality, index, options.signal);
    // A host that answers every rung with the same file costs one probe, and the rung below still counts.
    if (item === null || tried.includes(item.url)) continue;
    tried.push(item.url);
    const file = await fitting(engine, item, dir, options);
    if (file !== null) return file;
  }
  return { path: '', kind: 'video', size: 0, url: first.url, ...(first.poster !== undefined && { poster: first.poster }) };
}

/** The clip on disk when it fits, null when it does not — the next rung may still. */
async function fitting(engine: MediaEngine, item: MediaItem, dir: string, options: PrepareOptions): Promise<MediaFile | null> {
  const keep = options.keepOversizedVideo === true;
  const known = keep ? null : await engine.size?.(item, options.signal) ?? null;
  if (known !== null && known > MAX_UPLOAD_BYTES) return null;
  let path: string;
  try {
    // The downloader stops the stream at the ceiling, so a host that never names a size cannot slip one past.
    path = await engine.download(item, dir, options.signal, keep ? undefined : MAX_UPLOAD_BYTES);
  } catch (err) {
    if (isCoded(err) && err.code === E.TOO_LARGE) return null;
    throw err;
  }
  const size = (await stat(path)).size;
  // A host that would not name the size can still hand back more than Telegram takes.
  if (!keep && size > MAX_UPLOAD_BYTES) {
    await rm(path, { force: true });
    return null;
  }
  return { path, kind: 'video', size, url: item.url };
}

/** One rung down, matched by position: a carousel keeps its items in order across qualities. */
async function lowerRung(engine: MediaEngine, url: string, quality: string, index: number, signal: AbortSignal): Promise<MediaItem | null> {
  try {
    const resolved = await engine.resolve(url, signal, quality);
    const same = resolved.items[index];
    return same?.kind === 'video' ? same : null;
  } catch (err) {
    log('warn', 'media_quality_failed', { quality, code: isCoded(err) ? err.code : 'unknown' });
    return null;
  }
}
