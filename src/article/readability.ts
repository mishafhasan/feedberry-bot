import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import sanitizeHtml from 'sanitize-html';
import { Coded, E } from '../platform/errors.ts';
import { HTML_LIMIT, type Http } from '../platform/http.ts';

export interface Article {
  title: string;
  byline: string | null;
  /** The page's own site name (`og:site_name`), when it declares one. */
  siteName: string | null;
  html: string;
  /** Readable text length; R13 fires below 400 characters. */
  textLength: number;
  url: string;
  /** What the page declares as its own publication time, when it declares one. */
  publishedAt: number | null;
}

/** Telegraph understands a small HTML subset; anything else is stripped before conversion. */
const ALLOWED_TAGS = ['p', 'a', 'b', 'strong', 'i', 'em', 'u', 's', 'del', 'code', 'pre', 'blockquote', 'h3', 'h4', 'ul', 'ol', 'li', 'figure', 'figcaption', 'img', 'br', 'hr', 'iframe'];

/**
 * §5.6 article path: fetch through the §12.2 guard, Readability, sanitize, then the image-URL
 * fixes of formatbot1 (relative → absolute, drop sprites and non-http sources).
 */
export async function extractArticle(http: Http, url: string): Promise<Article> {
  const res = await http(url, { maxBytes: HTML_LIMIT });
  if (res.status === 401 || res.status === 403) throw new Coded(E.COOKIE_REQUIRED, `page replied ${res.status}`);
  if (res.status >= 400) throw new Coded(E.FEED_DOWN, `page replied ${res.status}`);

  const dom = new JSDOM(res.body, { url: res.url });
  const parsed = new Readability(dom.window.document).parse();
  if (!parsed?.content) throw new Coded(E.NO_FEED, 'readability extracted nothing');

  const clean = sanitizeHtml(parsed.content, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: { a: ['href'], img: ['src', 'alt'], iframe: ['src'] },
    allowedSchemes: ['http', 'https'],
  });
  const html = fixImageUrls(clean, res.url);

  return {
    title: (parsed.title ?? '').trim() || url,
    byline: parsed.byline?.trim() || null,
    siteName: parsed.siteName?.trim() || null,
    html,
    textLength: textOf(html).length,
    url: res.url,
    publishedAt: parseDate(parsed.publishedTime),
  };
}

function parseDate(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/** formatbot1's rule set: absolutize, drop style/sprite paths, drop anything not http(s). */
export function fixImageUrls(html: string, baseUrl: string): string {
  const dom = new JSDOM(`<body>${html}</body>`, { url: baseUrl });
  for (const img of dom.window.document.querySelectorAll('img')) {
    const raw = img.getAttribute('src') ?? '';
    try {
      const absolute = new URL(raw, baseUrl);
      if (!/^https?:$/.test(absolute.protocol) || /styles/i.test(absolute.pathname)) {
        img.remove();
        continue;
      }
      img.setAttribute('src', absolute.toString());
    } catch {
      img.remove();
    }
  }
  return dom.window.document.body.innerHTML;
}

export function textOf(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** R12's one-line lead: the first ~160 characters of readable text. */
export function leadOf(html: string): string {
  const text = textOf(html);
  if (text.length <= 160) return text;
  const cut = text.lastIndexOf(' ', 160);
  return `${text.slice(0, cut > 0 ? cut : 160)}…`;
}
