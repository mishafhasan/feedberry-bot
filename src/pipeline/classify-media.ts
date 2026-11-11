import type { MediaItem } from '../media/media-engine.ts';

/** §5.6 plus the M5 media rows. A photo+video post is still one album: Telegram groups accept both. */
export type PostKind = 'text' | 'link_only' | 'photo' | 'album' | 'video' | 'animation' | 'audio';

/**
 * Stage 3. `items` is cobalt's metadata-only view of the post URL; `hadFeedMedia` is the feed's own
 * hint, used to tell "a text post" from "media we failed to extract" (R14 vs R1).
 */
export function classifyMedia(items: MediaItem[], hadFeedMedia: boolean): PostKind {
  if (items.length === 0) return hadFeedMedia ? 'link_only' : 'text';

  if (items.length === 1) {
    const only = items[0]?.kind;
    return only === 'video' ? 'video' : only === 'animation' ? 'animation' : only === 'audio' ? 'audio' : 'photo';
  }
  return 'album';
}
