import type { PostRow } from '../db/repos/posts.ts';
import { clampMessage, esc, payloadOf, type MessagePlan } from '../render/plan.ts';
import type { PostKind } from './s3-classify.ts';

/**
 * Stage 6 for text (R1) and for everything media-shaped until M5 (R14): body text, plus the
 * original link when the post cannot be re-created as media.
 */
export function renderPost(post: PostRow, kind: PostKind): MessagePlan {
  const payload = payloadOf(post.payload_json);
  const title = esc(payload.title);
  const body = payload.summary && payload.summary !== payload.title ? `${title}\n\n${esc(payload.summary)}` : title;

  if (kind === 'link_only') return { kind, text: `${clampMessage(body, 4000)}\n\n${esc(post.url ?? '')}` };
  return { kind, text: clampMessage(body) };
}
