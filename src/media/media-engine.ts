import { download, resolve, type EngineResult } from 'cobalt-engine';
import { Coded, E, isCoded, type ErrorCode } from '../platform/errors.ts';
import type { MediaKind } from '../render/message-plan.ts';

export interface MediaItem {
  kind: MediaKind;
  url: string;
  /** A carousel item: it must be downloaded through the picker branch, not as a single stream. */
  picker: boolean;
  /** The second track of a merged result (YouTube); cobalt muxes it back on download. */
  audio?: string;
  /** Feed/platform duration hint (§8.6 step 2); null when nobody knows. */
  durationSec?: number | null;
  /** Headers the extractor attaches to the media host; TikTok's CDN 403s without referer + UA. */
  headers?: Record<string, string>;
}

export interface ResolvedMedia {
  items: MediaItem[];
  title: string | null;
  /** Who posted it (account or channel), when the extractor names one. */
  artist: string | null;
  /** When it went out (epoch ms), when the platform states it; the page may know it otherwise. */
  publishedAt?: number | null;
}

/** The pipeline's only door to cobalt (ADR-005); tests swap in a fixture-backed fake. */
export interface MediaEngine {
  /** `quality` is a height ceiling ("1080", "720", "480"); cobalt keeps the best variant under it. */
  resolve(url: string, signal: AbortSignal, quality?: string): Promise<ResolvedMedia>;
  download(item: MediaItem, dir: string, signal: AbortSignal): Promise<string>;
  /** What the file will weigh, without pulling it; null when the host will not say (stage 5 then downloads). */
  size?(item: MediaItem, signal: AbortSignal): Promise<number | null>;
}

const KIND: Record<string, MediaKind> = {
  photo: 'photo',
  video: 'video',
  audio: 'audio',
  gif: 'animation',
  mute: 'video',
  hls: 'video',
};

/** The engine's own type names, for building a download descriptor. */
const ENGINE_TYPE: Record<MediaKind, string> = { photo: 'photo', video: 'video', audio: 'audio', animation: 'gif' };

/** A muxed download writes through ffmpeg, which reads the container from the name. */
const FILE_EXT: Record<MediaKind, string> = { photo: 'jpg', video: 'mp4', audio: 'm4a', animation: 'mp4' };

export const cobaltEngine: MediaEngine = {
  async resolve(url, signal, quality) {
    const res = await resolve(url, { signal, ...(quality !== undefined && { quality }) });
    if (res.status !== 'ok') throw new Coded(errorCode(res.error?.code), res.error?.code);

    if (res.picker?.length) {
      const items = res.picker.flatMap((pick) => {
        const kind = KIND[pick.type];
        return kind && pick.url ? [{ kind, url: pick.url, picker: true, headers: res.headers }] : [];
      });
      if (items.length === 0) throw new Coded(E.NO_MEDIA, 'picker without playable items');
      return { items, title: res.metadata?.title ?? null, artist: res.metadata?.artist ?? null, publishedAt: res.metadata?.publishedAt ?? null };
    }

    const kind = (res.type && KIND[res.type]) || undefined;
    const first = res.urls?.[0];
    // A words-only post (a Tumblr text post) resolves with no media but with its text: keep the words.
    if (!first && res.metadata?.title) return { items: [], title: res.metadata.title, artist: res.metadata.artist ?? null, publishedAt: res.metadata?.publishedAt ?? null };
    if (!kind || !first) throw new Coded(E.NO_MEDIA, `type ${res.type ?? 'unknown'}`);
    // A merged result (YouTube) is video + audio; dropping the second URL shipped a silent file.
    const audio = res.urls?.[1];
    return { items: [{ kind, url: first, picker: false, ...(kind === 'video' && audio && { audio }), headers: res.headers }], title: res.metadata?.title ?? null, artist: res.metadata?.artist ?? null, publishedAt: res.metadata?.publishedAt ?? null };
  },

  async download(item, dir, signal) {
    try {
      const res = await download(downloadInput(item), { dir, signal, index: 0 });
      const file = res.files?.[0];
      if (res.status !== 'ok' || !file) throw new Coded(errorCode(res.error?.code), 'download failed');
      return file;
    } catch (err) {
      // A media host that refuses us is not a bot bug; the caller falls back to the link.
      if (isCoded(err)) throw err;
      throw new Coded(E.NO_MEDIA, err instanceof Error ? err.message : String(err));
    }
  },

  async size(item, signal) {
    const track = (url: string, headers?: Record<string, string>): Promise<number | null> => remoteBytes(url, headers, signal);
    const video = await track(item.url, item.headers);
    if (video === null || item.audio === undefined) return video;
    // A muxed file is both tracks; measuring one would pass a clip that lands past the ceiling.
    const audio = await track(item.audio, item.headers);
    return audio === null ? null : video + audio;
  },
};

/**
 * Pure so the headers the extractor attached survive the adapter hop: TikTok's CDN answers 403 to
 * a request without its referer + user agent, even when resolve() just succeeded. The name carries
 * the container because a two-track result is merged by ffmpeg, which cannot guess it from `media-video`.
 */
export function downloadInput(item: MediaItem): EngineResult {
  const headers = item.headers;
  const filename = `media-${item.kind}.${FILE_EXT[item.kind]}`;
  if (item.picker) return { status: 'ok', picker: [{ type: ENGINE_TYPE[item.kind], url: item.url }], filename, ...(headers && { headers }) };
  const urls = item.audio === undefined ? [item.url] : [item.url, item.audio];
  return { status: 'ok', type: ENGINE_TYPE[item.kind], urls, filename, ...(headers && { headers }) };
}

/** The total a media host will send: a ranged answer names it, a plain one only calls it length. */
export function bytesFrom(headers: { get(name: string): string | null }): number | null {
  const range = /^bytes \d+-\d+\/(\d+)$/.exec(headers.get('content-range') ?? '');
  const total = Number(range?.[1] ?? headers.get('content-length') ?? '');
  return Number.isFinite(total) && total > 0 ? total : null;
}

/**
 * One byte, then hang up. A HEAD is not enough: TikTok answers that with a JSON stub, while the same
 * host names the real total in `content-range` for a ranged GET.
 */
async function remoteBytes(url: string, headers: Record<string, string> | undefined, signal: AbortSignal): Promise<number | null> {
  try {
    const res = await fetch(url, { headers: { ...headers, range: 'bytes=0-0' }, signal });
    await res.body?.cancel();
    return bytesFrom(res.headers);
  } catch {
    return null;
  }
}

/** §11 mapping of the engine's error codes; anything unknown is "couldn't extract media". */
function errorCode(code: string | undefined): ErrorCode {
  if (!code) return E.NO_MEDIA;
  if (code.includes('rate')) return E.RATE_LIMIT;
  if (code.includes('auth') || code.includes('cookie') || code.includes('login') || code.includes('private')) return E.COOKIE_REQUIRED;
  if (code.includes('too_long') || code.includes('too_large')) return E.TOO_LARGE;
  return E.NO_MEDIA;
}
