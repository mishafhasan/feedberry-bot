import type { MediaItem } from '../media/cobalt.ts';

/** §5.6 plus the M5 media rows; 'mixed' is R5 (photo + video, sent one by one). */
export type PostKind = 'text' | 'link_only' | 'article' | 'photo' | 'album' | 'video' | 'mixed' | 'animation' | 'audio';

/**
 * Stage 3. `items` is cobalt's metadata-only view of the post URL; `hadFeedMedia` is the feed's own
 * hint, used to tell "a text post" from "media we failed to extract" (R14 vs R1). A post with no
 * media from a website and no body in the feed is an article (R12/R13).
 */
export function classifyMedia(items: MediaItem[], hadFeedMedia: boolean, options: { platform: string; hasBody: boolean }): PostKind {
  if (items.length === 0) {
    if (options.platform === 'rss' && !options.hasBody) return 'article';
    return hadFeedMedia ? 'link_only' : 'text';
  }

  const kinds = new Set(items.map((item) => item.kind));
  if (items.length === 1) {
    const only = items[0]?.kind;
    return only === 'video' ? 'video' : only === 'animation' ? 'animation' : only === 'audio' ? 'audio' : 'photo';
  }
  if (kinds.has('photo') && kinds.has('video')) return 'mixed';
  return 'album';
}
