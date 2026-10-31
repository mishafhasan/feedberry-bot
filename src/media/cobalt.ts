import { download, resolve } from 'cobalt-engine';
import { Coded, E, type ErrorCode } from '../platform/errors.ts';
import type { MediaKind } from '../render/plan.ts';

export interface MediaItem {
  kind: MediaKind;
  url: string;
  /** A carousel item: it must be downloaded through the picker branch, not as a single stream. */
  picker: boolean;
  /** Feed/platform duration hint (§8.6 step 2); null when nobody knows. */
  durationSec?: number | null;
}

export interface ResolvedMedia {
  items: MediaItem[];
  title: string | null;
  /** Who posted it (account or channel), when the extractor names one. */
  artist: string | null;
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
        return kind && pick.url ? [{ kind, url: pick.url, picker: true }] : [];
      });
      if (items.length === 0) throw new Coded(E.NO_MEDIA, 'picker without playable items');
      return { items, title: res.metadata?.title ?? null, artist: res.metadata?.artist ?? null };
    }

    const kind = (res.type && KIND[res.type]) || undefined;
    const first = res.urls?.[0];
    if (!kind || !first) throw new Coded(E.NO_MEDIA, `type ${res.type ?? 'unknown'}`);
    return { items: [{ kind, url: first, picker: false }], title: res.metadata?.title ?? null, artist: res.metadata?.artist ?? null };
  },

  async download(item, dir, signal) {
    const filename = `media-${item.kind}`;
    const input = item.picker
      ? { status: 'ok' as const, picker: [{ type: ENGINE_TYPE[item.kind], url: item.url }], filename }
      : { status: 'ok' as const, type: ENGINE_TYPE[item.kind], urls: [item.url], filename };

    const res = await download(input, { dir, signal, index: 0 });
    const file = res.files?.[0];
    if (res.status !== 'ok' || !file) throw new Coded(errorCode(res.error?.code), 'download failed');
    return file;
  },
};

/** §11 mapping of the engine's error codes; anything unknown is "couldn't extract media". */
function errorCode(code: string | undefined): ErrorCode {
  if (!code) return E.NO_MEDIA;
  if (code.includes('rate')) return E.RATE_LIMIT;
  if (code.includes('auth') || code.includes('cookie') || code.includes('login') || code.includes('private')) return E.COOKIE_REQUIRED;
  if (code.includes('too_long') || code.includes('too_large')) return E.TOO_LARGE;
  return E.NO_MEDIA;
}
