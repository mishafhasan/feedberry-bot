import type { PostRow } from '../db/repos/posts.ts';
import { clampMessage, esc, payloadOf, type MediaFile, type MessagePlan } from '../render/plan.ts';
import { renderVideo } from '../render/video.ts';
import type { PostKind } from './s3-classify.ts';

/** Stage 6 (R1/R2/R3/R5/R9/R10/R11/R14). Stage 7 owns splitting and the reply chain. */
export function renderPost(post: PostRow, kind: PostKind, files: MediaFile[]): MessagePlan {
  const caption = bodyOf(post);
  const asItems = files.map((file) => ({ file: file.path, kind: file.kind === 'video' ? ('video' as const) : ('photo' as const) }));

  switch (kind) {
    case 'text':
      return { kind, text: clampMessage(caption) };
    case 'link_only':
      return { kind, text: `${clampMessage(caption, 4000)}\n\n${esc(post.url ?? '')}` };
    case 'photo':
    case 'animation':
    case 'audio': {
      const file = files[0];
      return file ? { kind, file: file.path, caption } : { kind: 'text', text: clampMessage(caption) };
    }
    case 'video': {
      const file = files[0];
      return file ? renderVideo(file, caption, post.url ?? '') : { kind: 'text', text: clampMessage(caption) };
    }
    case 'album':
      return files.length > 0 ? { kind, items: asItems, caption } : { kind: 'text', text: clampMessage(caption) };
    case 'mixed':
      return files.length > 0 ? { kind: 'sequential', items: asItems, caption } : { kind: 'text', text: clampMessage(caption) };
  }
}

/** Download mode has no `posts` row, so the title comes from the engine and the link is the input. */
export function renderDownload(files: MediaFile[], title: string, link: string): MessagePlan {
  const caption = esc(title);
  const asItems = files.map((file) => ({ file: file.path, kind: file.kind === 'video' ? ('video' as const) : ('photo' as const) }));
  if (files.length === 0) return { kind: 'link_only', text: esc(link) };

  const kinds = new Set(files.map((file) => file.kind));
  if (kinds.has('audio') && files.length === 1) return { kind: 'audio', file: files[0]?.path ?? '', caption };
  if (files.length === 1) {
    const only = files[0];
    if (!only) return { kind: 'link_only', text: esc(link) };
    if (only.kind === 'video') return renderVideo(only, caption, link);
    return { kind: only.kind === 'animation' ? 'animation' : 'photo', file: only.path, caption };
  }
  return kinds.size > 1 ? { kind: 'sequential', items: asItems, caption } : { kind: 'album', items: asItems, caption };
}

function bodyOf(post: PostRow): string {
  const payload = payloadOf(post.payload_json);
  const title = esc(payload.title);
  return payload.summary && payload.summary !== payload.title ? `${title}\n\n${esc(payload.summary)}` : title;
}
