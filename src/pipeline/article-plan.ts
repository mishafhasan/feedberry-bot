import { extractArticle } from '../article/readability.ts';
import { publishArticle, telegraphClient, type TelegraphClient } from '../article/telegraph.ts';
import type { Http } from '../platform/http.ts';
import { isCoded } from '../platform/errors.ts';
import { log } from '../obs/log.ts';
import { postHeader } from '../render/caption.ts';
import { esc, type MessagePlan } from '../render/plan.ts';
import { renderArticle } from './s6-render.ts';

/** R13 fires below this many readable characters (§8.1). */
export const ARTICLE_MIN_CHARS = 400;

export interface ArticleInput {
  url: string;
  /** The feed item's title, used when extraction returns none. */
  title: string | null;
  publishedAt: number | null;
  /** The source name for the header link; the post title in Download mode. */
  sourceTitle: string | null;
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
    // The feed's date wins; a downloaded page only has its own.
    const header = postHeader({
      sourceTitle: input.sourceTitle,
      url: input.url,
      publishedAt: input.publishedAt ?? article.publishedAt,
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
