import type { PostRow } from '../db/repos/posts.ts';
import { payloadOf } from '../render/plan.ts';

/** §5.6 reduced to what M4 can send: text, or a link card for anything with media. */
export type PostKind = 'text' | 'link_only';

export function classifyPost(post: PostRow): PostKind {
  // M4 has no media renderer, so a media post degrades to R14 (text + link). M5 upgrades this.
  return payloadOf(post.payload_json).media.length > 0 ? 'link_only' : 'text';
}
