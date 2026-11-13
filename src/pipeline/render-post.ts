import type { PostRow } from '../db/repos/posts.ts';
import type { Article } from '../article/readability.ts';
import { leadOf } from '../article/readability.ts';
import { log } from '../obs/log.ts';
import { clampMessage, esc, payloadOf, RICH_TEXT_LIMIT, type MediaFile, type MediaKind, type MessagePlan } from '../render/message-plan.ts';
import { breakNumberedList, postHeader } from '../render/caption.ts';
import { expandableQuote } from '../render/rich-text.ts';
import { renderAlbum, renderVideo, unsendable, withVideoLinks } from '../render/video.ts';
import type { PostKind } from './classify-media.ts';

/** R9/R7/R8 need facts about the downloaded video; other rows ignore them. */
export interface RenderExtras {
  durationSec?: number | null;
  thumbnail?: string | null;
  /** true when `thumbnail` is a platform poster URL rather than a local frame. */
  thumbnailRemote?: boolean;
  /** Every post opens with the source it came from, so the renderer needs its title. */
  sourceTitle?: string | null;
  /** The source's platform, printed as the header's label; the feed's own type, never the post URL's. */
  platform: string;
  /** The reader's timezone for the `⏱️ Time:` line; UTC until a user timezone is stored. */
  tz?: string;
  /** Used when the feed carried no title; the media engine usually knows one. */
  titleFallback?: string | null;
}

/** Stage 6 (R1/R2/R3/R5/R6-R9/R10/R11/R14/R15). Stage 7 owns splitting and the reply chain. */
export function renderPost(post: PostRow, kind: PostKind, files: MediaFile[], extras: RenderExtras): MessagePlan {
  // ADR-023: every non-RSS post is one rich message; the rows below are the RSS/blog layout.
  if (extras.platform !== 'rss') return renderRichPost(post, files, extras);
  const caption = bodyOf(post, extras);

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
      // R15: an oversized video keeps its frame and a link; the rest of the post still ships as one album.
      return renderAlbum(files, caption);
  }
}

/** R12: the Instant View link, opened by Telegraph (ADR-007, OQ-13/OQ-14). */
export function renderArticle(article: Article, ivUrl: string, header: string): MessagePlan {
  const lead = leadOf(article.html);
  // The headline stays readable text; the arrows point at the Instant View card Telegram shows below.
  const title = article.title === '' ? esc(ivUrl) : `<b>${esc(article.title)}</b>`;
  return {
    kind: 'text',
    text: [header, title, esc(lead), `<a href="${esc(ivUrl)}">👇🏼👇🏼👇🏼</a>`].filter(Boolean).join('\n\n'),
    // The preview must open the Instant View copy, not the original page the header links.
    previewUrl: ivUrl,
  };
}

/** Download mode has no `posts` row, so the engine supplies the text and the link is the input. */
export function renderDownload(files: MediaFile[], meta: { title: string | null; artist: string | null; publishedAt?: number | null; platform: string; tz?: string }, link: string): MessagePlan {
  // The account names the source; its caption is the post's own words underneath.
  const artist = meta.artist ?? null;
  const title = meta.title ?? null;
  const header = postHeader({ sourceTitle: artist ?? title, url: link, publishedAt: meta.publishedAt ?? null, platform: meta.platform, tz: meta.tz, rich: true });
  // A title that IS the source name must not print again as the body (the scheduled de-dup rule).
  const parts = artist !== null && title !== null ? [breakNumberedList(title)] : [];
  return richPlan(header, parts, files);
}

/** ADR-023: the scheduled half of the rich layout — same header, the feed's de-duplicated words. */
function renderRichPost(post: PostRow, files: MediaFile[], extras: RenderExtras): MessagePlan {
  const header = postHeader({ sourceTitle: extras.sourceTitle ?? null, url: post.url, publishedAt: post.published_at, platform: extras.platform, tz: extras.tz, rich: true });
  const parts = bodyParts(post, extras).map((part) => breakNumberedList(part));
  return richPlan(header, parts, files);
}

/**
 * One rich message: heading + time, a slideshow of the post's own media, the whole post inside one
 * expandable quote framed by two rules, then one labelled link per video that cannot upload (ADR-025).
 */
function richPlan(header: string, parts: string[], files: MediaFile[]): MessagePlan {
  // shortcut: media past the 50-attachment ceiling is dropped, upgrade when a real source exceeds it.
  const sendable = files.filter((file) => !unsendable(file)).slice(0, 50);
  const media = sendable.map((file, index) => ({ id: `m${index}`, file: file.path, kind: file.kind }));
  const ref = (index: number, kind: MediaKind): string =>
    kind === 'photo' ? `<img src="tg://photo?id=m${index}"/>` : kind === 'audio' ? `<audio src="tg://audio?id=m${index}"></audio>` : `<video src="tg://video?id=m${index}"></video>`;
  const indexed = sendable.map((file, index) => ({ file, index }));
  const visual = indexed.filter((x) => x.file.kind !== 'audio');
  // Audio cannot ride in a slideshow (Telegram hoists it out), so it stands as its own block.
  const audio = indexed.filter((x) => x.file.kind === 'audio');
  const links = withVideoLinks('', files).trim();
  const compose = (bodyPlain: string): string => {
    const body = expandableQuote(bodyPlain);
    return [
      header,
      visual.length > 0 ? `<tg-slideshow>${visual.map((x) => ref(x.index, x.file.kind)).join('')}</tg-slideshow>` : '',
      ...audio.map((x) => ref(x.index, x.file.kind)),
      // Two rules frame the quote, so the post reads as one block of content under the heading.
      body === '' ? '' : `<hr/>${body}<hr/>`,
      links === '' ? '' : `<p>${links.replace(/\n/g, '<br/>')}</p>`,
    ].filter((block) => block !== '').join('');
  };

  let bodyPlain = parts.join('\n\n');
  let html = compose(bodyPlain);
  if (html.length > RICH_TEXT_LIMIT) {
    // shortcut: >32,768-char posts are clamped, upgrade when a real source exceeds it.
    log('warn', 'rich_clamped', { chars: html.length });
    bodyPlain = clampMessage(bodyPlain, bodyPlain.length - (html.length - RICH_TEXT_LIMIT));
    html = compose(bodyPlain);
  }
  return { kind: 'rich', html, media };
}

function bodyOf(post: PostRow, extras: RenderExtras): string {
  const header = postHeader({ sourceTitle: extras.sourceTitle ?? null, url: post.url, publishedAt: post.published_at, platform: extras.platform, tz: extras.tz });
  return [header, ...bodyParts(post, extras).map((part) => esc(breakNumberedList(part)))].filter((part) => part !== '').join('\n\n');
}

/** The post's own words — title and body, de-duplicated — without the source header. */
export function bodyParts(post: PostRow, extras: Pick<RenderExtras, 'titleFallback'> = {}): string[] {
  const payload = payloadOf(post.payload_json);
  const title = payload.title || extras.titleFallback || '';
  const summary = payload.summary ?? '';
  // Feeds put the post's opening in both fields, cut short in the title: print that text once.
  const body = summary === '' ? [title] : cutsOff(title, summary) ? [summary] : cutsOff(summary, title) ? [title] : [title, summary];
  return body.filter((part) => part !== '');
}

/** The body already prints the title — at its opening, or inside a reblog chain above it. */
function cutsOff(preview: string, full: string): boolean {
  // A cut is marked with `…`, `...`, or the entity a double-encoded feed leaves behind.
  const head = flat(preview).replace(/(?:[.…]+|&(?:amp;)?hellip;)$/u, '').trim();
  return head !== '' && flat(full).includes(head);
}

/** Titles arrive single-line, bodies keep their paragraphs: compare both on flattened text. */
function flat(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}
