import { extractArticle } from '../article/readability.ts';
import { publishArticle, telegraphClient, type TelegraphClient } from '../article/telegraph.ts';
import type { Http } from '../platform/http.ts';
import { isCoded } from '../platform/errors.ts';
import { log } from '../obs/log.ts';
import { postHeader } from '../render/caption.ts';
import { esc, type MessagePlan } from '../render/message-plan.ts';
import { renderArticle } from './render-post.ts';

/** R13 fires below this many readable characters (§8.1). */
export const ARTICLE_MIN_CHARS = 400;

export interface ArticleInput {
  url: string;
  /** The feed item's title, used when extraction returns none. */
  title: string | null;
  publishedAt: number | null;
  /** The source name for the header link; the post title in Download mode. */
  sourceTitle: string | null;
  /** The source's platform, printed as the header's label. */
  platform: string;
  tz?: string;
}

export interface ArticleDeps {
  http: Http;
  telegraph?: TelegraphClient;
}

/**
 * Stages 1b → 6 for a single web page: extract, publish to Telegra.ph, format.
 * Returns null only when extraction itself failed, so the caller can fall back to media.
 * A thin page still produces a plan — a link card — because a blog post is never dropped.
 */
export async function planArticle(deps: ArticleDeps, input: ArticleInput): Promise<MessagePlan | null> {
  try {
    const article = await extractArticle(deps.http, input.url);
    // A downloaded page names itself; the host is the last resort only when it declares no site name.
    const sourceTitle = input.sourceTitle ?? article.siteName ?? new URL(input.url).hostname.replace(/^www\./, '');
    // The feed's date wins; a downloaded page only has its own.
    const header = postHeader({
      sourceTitle,
      url: input.url,
      publishedAt: input.publishedAt ?? article.publishedAt,
      platform: input.platform,
      tz: input.tz,
    });
    if (article.textLength < ARTICLE_MIN_CHARS) {
      return { kind: 'link_only', text: `${header}\n\n${esc(article.title || input.title || '')}\n\n${esc(input.url)}` };
    }
    const ivUrl = await publishArticle(deps.telegraph ?? telegraphClient, article);
    return renderArticle(article, ivUrl, header);
  } catch (err) {
    log('warn', 'article_failed', { url: input.url, code: isCoded(err) ? err.code : 'unknown' });
    return null;
  }
}
