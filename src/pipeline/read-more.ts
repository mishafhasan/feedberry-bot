import { publishArticle, type TelegraphClient } from '../article/telegraph.ts';
import type { PostRow } from '../db/repos/posts.ts';
import { log } from '../obs/log.ts';
import { cutCaption } from '../render/caption.ts';
import { esc, payloadOf, type MessagePlan } from '../render/plan.ts';
import { CAPTION_LIMIT } from '../telegram/api.ts';
import { bodyParts } from './s6-render.ts';

const READ_MORE = '👉🏻 Read more';
const MAX_TITLE = 120;
/** Below this, the caption would be a stub — better to keep today's split behaviour. */
const MIN_BODY = 200;

export interface ReadMoreCtx {
  telegraph?: TelegraphClient;
  sourceTitle: string | null;
}

/** What an Instant View page is built from: a scheduled post, or a Download Mode resolve. */
export interface ReadMorePage {
  /** Cache key; a downloaded link has no `posts` row, so it uses 0. */
  id: number;
  url: string | null;
  publishedAt: number | null;
  /** The source's own headline, when it has one apart from the body. */
  title: string | null;
  /** The post's own words, header excluded. */
  parts: string[];
  /** Image URLs the source already publishes. */
  images: string[];
}

/** The scheduled-post half: the feed payload carries both the text and the pictures. */
export function pageOfPost(post: PostRow): ReadMorePage {
  const payload = payloadOf(post.payload_json);
  // shortcut: only the feed's own enclosures reach the page; cobalt URLs are not persisted.
  return {
    id: post.id,
    url: post.url,
    publishedAt: post.published_at,
    title: payload.title || null,
    parts: bodyParts(post),
    images: payload.media.filter((item) => item.type === 'photo').map((item) => item.url),
  };
}

/**
 * A caption past Telegram's limit keeps the media and trades its tail for a Telegra.ph page that
 * holds the whole post. Any failure returns the plan untouched, so the split still ships.
 */
export async function withReadMore(
  plan: MessagePlan,
  page: ReadMorePage,
  ctx: ReadMoreCtx,
  pages: Map<number, string | null>,
): Promise<MessagePlan> {
  if (!('caption' in plan) || plan.caption.length <= CAPTION_LIMIT || !ctx.telegraph) return plan;

  let url = pages.get(page.id);
  if (url === undefined) {
    url = await pageUrl(ctx.telegraph, ctx, page);
    // A failed publish is remembered too: one attempt per post, not one per chat.
    pages.set(page.id, url);
  }
  if (url === null) return plan;

  const fixed = `...\n\n<a href="${esc(url)}">${READ_MORE}</a>`;
  const budget = CAPTION_LIMIT - fixed.length;
  if (budget < MIN_BODY) return plan;
  log('info', 'readmore_page', { post: page.id });
  return { ...plan, caption: `${cutCaption(plan.caption, budget)}${fixed}` };
}

/** The post's own text and pictures, published as one page; null when Telegraph says no. */
async function pageUrl(client: TelegraphClient, ctx: ReadMoreCtx, page: ReadMorePage): Promise<string | null> {
  try {
    // Telegraph flattens newlines inside a node, so every source line becomes its own paragraph.
    const paragraphs = page.parts.flatMap((part) => part.split(/\n+/).map((line) => line.trim()).filter((line) => line !== ''));
    const title = (page.title || paragraphs[0] || 'Post').slice(0, MAX_TITLE);
    // A headline borrowed from the body must not print the same sentence twice.
    const body = page.title !== null || title !== paragraphs[0] ? paragraphs : paragraphs.slice(1);
    const images = [...new Set(page.images)].filter(isFetchable);
    const html = [
      ...body.map((part) => `<p>${esc(part)}</p>`),
      ...images.map((url) => `<figure><img src="${esc(url)}"/></figure>`),
    ].join('');
    const published = await publishArticle(client, { title, byline: ctx.sourceTitle ?? 'FeedBerry', html, textLength: 0, url: page.url ?? '', publishedAt: page.publishedAt });
    log('info', 'readmore_published', { post: page.id, images: images.length });
    return published;
  } catch (err) {
    log('warn', 'readmore_failed', { post: page.id, cause: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/** Only an absolute http(s) URL may reach the page markup. */
function isFetchable(value: string): boolean {
  try {
    return /^https?:$/.test(new URL(value).protocol);
  } catch {
    return false;
  }
}
