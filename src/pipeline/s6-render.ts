import type { PostRow } from '../db/repos/posts.ts';
import type { Article } from '../article/readability.ts';
import { leadOf } from '../article/readability.ts';
import { clampMessage, esc, payloadOf, type MediaFile, type MessagePlan } from '../render/plan.ts';
import { postHeader } from '../render/caption.ts';
import { renderVideo } from '../render/video.ts';
import type { PostKind } from './s3-classify.ts';

/** R9/R7/R8 need facts about the downloaded video; other rows ignore them. */
export interface RenderExtras {
  durationSec?: number | null;
  thumbnail?: string | null;
  /** true when `thumbnail` is a platform poster URL rather than a local frame. */
  thumbnailRemote?: boolean;
  /** Every post opens with the source it came from, so the renderer needs its title. */
  sourceTitle?: string | null;
  /** The reader's timezone for the `⏱️ Time:` line; UTC until a user timezone is stored. */
  tz?: string;
}

/** Stage 6 (R1/R2/R3/R5/R6-R9/R10/R11/R14). Stage 7 owns splitting and the reply chain. */
export function renderPost(post: PostRow, kind: PostKind, files: MediaFile[], extras: RenderExtras = {}): MessagePlan {
  const caption = bodyOf(post, extras);
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
      if (!file) return { kind: 'text', text: clampMessage(caption) };
      return renderVideo(file, caption, {
        durationSec: extras.durationSec ?? null,
        thumbnail: extras.thumbnail ?? null,
        thumbnailRemote: extras.thumbnailRemote ?? false,
        link: post.url ?? '',
      });
    }
    case 'album':
      return files.length > 0 ? { kind, items: asItems, caption } : { kind: 'text', text: clampMessage(caption) };
  }
}

/** R12: the Instant View link, opened by Telegraph (ADR-007, OQ-13/OQ-14). */
export function renderArticle(article: Article, ivUrl: string): MessagePlan {
  const lead = leadOf(article.html);
  return { kind: 'text', text: [`<b>${esc(article.title)}</b>`, esc(lead), esc(ivUrl)].filter(Boolean).join('\n\n') };
}

/** R13: the extraction was thin or failed, so the reader gets the original link. */
export function renderArticleFallback(post: PostRow, title: string | null): MessagePlan {
  const payload = payloadOf(post.payload_json);
  const heading = title ?? payload.title;
  return { kind: 'link_only', text: `${esc(heading)}\n\n${esc(post.url ?? '')}` };
}

/** Download mode has no `posts` row, so the title comes from the engine and the link is the input. */
export function renderDownload(files: MediaFile[], title: string, link: string): MessagePlan {
  const caption = postHeader({ sourceTitle: title || null, url: link, publishedAt: null });
  const asItems = files.map((file) => ({ file: file.path, kind: file.kind === 'video' ? ('video' as const) : ('photo' as const) }));
  if (files.length === 0) return { kind: 'link_only', text: esc(link) };

  const kinds = new Set(files.map((file) => file.kind));
  if (kinds.has('audio') && files.length === 1) return { kind: 'audio', file: files[0]?.path ?? '', caption };
  if (files.length === 1) {
    const only = files[0];
    if (!only) return { kind: 'link_only', text: esc(link) };
    // A link the user asked for is uploaded when it fits; the duration rule is for scheduled posts.
    if (only.kind === 'video') return renderVideo(only, caption, { durationSec: null, thumbnail: null, link });
    return { kind: only.kind === 'animation' ? 'animation' : 'photo', file: only.path, caption };
  }
  return { kind: 'album', items: asItems, caption };
}

function bodyOf(post: PostRow, extras: RenderExtras): string {
  const payload = payloadOf(post.payload_json);
  const title = esc(payload.title);
  const body = payload.summary && payload.summary !== payload.title ? `${title}\n\n${esc(payload.summary)}` : title;
  const header = postHeader({ sourceTitle: extras.sourceTitle ?? null, url: post.url, publishedAt: post.published_at, tz: extras.tz });
  return body ? `${header}\n\n${body}` : header;
}
