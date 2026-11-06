import { normalizeHost, platformForHost } from './allowlist.ts';
import type { FeedItem } from './feed/native.ts';

/**
 * YouTube publishes three kinds on one channel and a subscription picks which ones arrive.
 * `/shorts/` and `/post/` are the two shapes the uploads feed and the posts page spell out; every
 * other YouTube permalink (`watch?v=`, `youtu.be`, `/live/`) is a regular video.
 */
export const CONTENT_KINDS = ['video', 'short', 'post'] as const;

export type ContentKind = (typeof CONTENT_KINDS)[number];

export function youtubeKindOf(link: string | null | undefined): ContentKind | null {
  if (!link) return null;
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  if (platformForHost(normalizeHost(url.hostname)) !== 'youtube') return null;

  const [first] = url.pathname.split('/').filter(Boolean);
  if (first === 'shorts') return 'short';
  if (first === 'post') return 'post';
  return first === 'watch' || first === 'live' || normalizeHost(url.hostname) === 'youtu.be' ? 'video' : null;
}

/** `null` means "everything": rows from before the picker existed, and every non-YouTube source. */
export function parseContentTypes(raw: string | null | undefined): ContentKind[] | null {
  if (raw === null || raw === undefined) return null;
  const kinds = raw
    .split(',')
    .map((part) => part.trim())
    .filter((part): part is ContentKind => (CONTENT_KINDS as readonly string[]).includes(part));
  return kinds.length === 0 ? null : [...new Set(kinds)];
}

/** One stable spelling, in the picker's own order, so the row reads the same wherever it is shown. */
export function formatContentTypes(kinds: ContentKind[]): string {
  return CONTENT_KINDS.filter((kind) => kinds.includes(kind)).join(',');
}

/** A post no rule can place (a channel link, another platform) is always allowed. */
export function allowsContent(selected: ContentKind[] | null, kind: ContentKind | null): boolean {
  return selected === null || kind === null || selected.includes(kind);
}

/** The items a subscription actually watches, for the preview and for what gets recorded fresh. */
export function filterByContentTypes(platform: string, items: FeedItem[], selected: ContentKind[] | null): FeedItem[] {
  return platform === 'youtube' ? items.filter((item) => allowsContent(selected, youtubeKindOf(item.link))) : items;
}
