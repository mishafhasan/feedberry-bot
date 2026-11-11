import { download, resolve, type EngineResult } from 'cobalt-engine';
import { Coded, E, isCoded, type ErrorCode } from '../platform/errors.ts';
import type { MediaKind } from '../render/message-plan.ts';

export interface MediaItem {
  kind: MediaKind;
  url: string;
  /** A carousel item: it must be downloaded through the picker branch, not as a single stream. */
  picker: boolean;
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
  resolve(url: string, signal: AbortSignal): Promise<ResolvedMedia>;
  download(item: MediaItem, dir: string, signal: AbortSignal): Promise<string>;
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

export const cobaltEngine: MediaEngine = {
  async resolve(url, signal) {
    const res = await resolve(url, { signal });
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
    return { items: [{ kind, url: first, picker: false, headers: res.headers }], title: res.metadata?.title ?? null, artist: res.metadata?.artist ?? null, publishedAt: res.metadata?.publishedAt ?? null };
  },

  async download(item, dir, signal) {
    try {
      const res = await download(downloadInput(item, `media-${item.kind}`), { dir, signal, index: 0 });
      const file = res.files?.[0];
      if (res.status !== 'ok' || !file) throw new Coded(errorCode(res.error?.code), 'download failed');
      return file;
    } catch (err) {
      // A media host that refuses us is not a bot bug; the caller falls back to the link.
      if (isCoded(err)) throw err;
      throw new Coded(E.NO_MEDIA, err instanceof Error ? err.message : String(err));
    }
  },
};

/**
 * Pure so the headers the extractor attached survive the adapter hop: TikTok's CDN answers 403 to
 * a request without its referer + user agent, even when resolve() just succeeded.
 */
export function downloadInput(item: MediaItem, filename: string): EngineResult {
  const headers = item.headers;
  return item.picker
    ? { status: 'ok', picker: [{ type: ENGINE_TYPE[item.kind], url: item.url }], filename, ...(headers && { headers }) }
    : { status: 'ok', type: ENGINE_TYPE[item.kind], urls: [item.url], filename, ...(headers && { headers }) };
}

/** §11 mapping of the engine's error codes; anything unknown is "couldn't extract media". */
function errorCode(code: string | undefined): ErrorCode {
  if (!code) return E.NO_MEDIA;
  if (code.includes('rate')) return E.RATE_LIMIT;
  if (code.includes('auth') || code.includes('cookie') || code.includes('login') || code.includes('private')) return E.COOKIE_REQUIRED;
  if (code.includes('too_long') || code.includes('too_large')) return E.TOO_LARGE;
  return E.NO_MEDIA;
}
