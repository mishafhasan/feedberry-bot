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
  /** Used when the feed carried no title; the media engine usually knows one. */
  titleFallback?: string | null;
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
export function renderArticle(article: Article, ivUrl: string, header: string): MessagePlan {
  const lead = leadOf(article.html);
  return {
    kind: 'text',
    text: [header, `<b>${esc(article.title)}</b>`, esc(lead), esc(ivUrl)].filter(Boolean).join('\n\n'),
    // The header link points at the original post; the preview must open the Instant View copy.
    previewUrl: ivUrl,
  };
}

/** Download mode has no `posts` row, so the engine supplies the text and the link is the input. */
export function renderDownload(files: MediaFile[], meta: { title: string | null; artist: string | null }, link: string): MessagePlan {
  // The account names the source; its caption is the post's own words underneath.
  const artist = meta.artist ?? null;
  const title = meta.title ?? null;
  const header = postHeader({ sourceTitle: artist ?? title, url: link, publishedAt: null });
  const caption = artist !== null && title !== null ? `${header}\n\n${esc(title)}` : header;
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
  const title = payload.title || extras.titleFallback || '';
  const summary = payload.summary ?? '';
  // Feeds put the post's opening in both fields, cut short in the title: print that text once.
  const body = summary === '' ? [title] : cutsOff(title, summary) ? [summary] : cutsOff(summary, title) ? [title] : [title, summary];
  const header = postHeader({ sourceTitle: extras.sourceTitle ?? null, url: post.url, publishedAt: post.published_at, tz: extras.tz });
  return [header, ...body.map((part) => esc(part))].filter((part) => part !== '').join('\n\n');
}

/** `preview` is `full`, or its opening with the ellipsis a feed adds when it cuts the text. */
function cutsOff(preview: string, full: string): boolean {
  const head = flat(preview).replace(/[.…]+$/u, '').trim();
  return head !== '' && flat(full).startsWith(head);
}

/** Titles arrive single-line, bodies keep their paragraphs: compare both on flattened text. */
function flat(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}
