import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import sanitizeHtml from 'sanitize-html';
import { Coded, E } from '../platform/errors.ts';
import { HTML_LIMIT, type Http } from '../platform/http.ts';
import { backgroundImages, imageSource, usableUrl } from '../platform/media-urls.ts';

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

/**
 * Every block Telegra.ph has no node for is kept until `telegraph.ts` flattens it: h1-h6 map onto
 * h3/h4, and a table becomes one paragraph per row.
 */
const ALLOWED_TAGS = [
  'p', 'a', 'b', 'strong', 'i', 'em', 'u', 's', 'del', 'code', 'pre', 'blockquote', 'aside',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'table', 'caption', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
  'figure', 'figcaption', 'img', 'video', 'br', 'hr', 'iframe',
];

/**
 * §5.6 article path: fetch through the §12.2 guard, Readability, sanitize, then the image-URL
 * fixes of formatbot1 (relative → absolute, drop sprites and non-http sources).
 */
export async function extractArticle(http: Http, url: string): Promise<Article> {
  const res = await http(url, { maxBytes: HTML_LIMIT });
  if (res.status === 401 || res.status === 403) throw new Coded(E.COOKIE_REQUIRED, `page replied ${res.status}`);
  if (res.status >= 400) throw new Coded(E.FEED_DOWN, `page replied ${res.status}`);

  const dom = new JSDOM(res.body, { url: res.url });
  // The page is materialised before the reader sees it: Medium's post pictures sit in
  // `<picture><source srcset>` beside an `<img>` that has no source, and Readability drops both.
  resolveMedia(dom.window.document, res.url);
  const parsed = new Readability(dom.window.document).parse();
  if (!parsed?.content) throw new Coded(E.NO_FEED, 'readability extracted nothing');

  // The image rules run before sanitizing: Medium keeps a post's picture in `<picture><source
  // srcset>` and sanitize-html drops that wrapper, which used to delete every photo in the post.
  const clean = sanitizeHtml(fixImageUrls(parsed.content, res.url), {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: { a: ['href'], img: ['src', 'srcset', 'alt'], iframe: ['src'], video: ['src'] },
    allowedSchemes: ['http', 'https'],
  });

  return {
    title: (parsed.title ?? '').trim() || url,
    byline: parsed.byline?.trim() || null,
    siteName: parsed.siteName?.trim() || null,
    html: clean,
    textLength: textOf(clean).length,
    url: res.url,
    publishedAt: parseDate(parsed.publishedTime),
  };
}

function parseDate(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * formatbot1's rule set: absolutize, drop style/sprite paths, drop anything not http(s).
 * `srcset` is read first: picture-heavy sites (BBC) leave a grey placeholder in `src` and put the
 * real file only in `srcset`, and an image without a source renders as a white box in Instant View.
 */
export function fixImageUrls(html: string, baseUrl: string): string {
  const dom = new JSDOM(`<body>${html}</body>`, { url: baseUrl });
  resolveMedia(dom.window.document, baseUrl);
  return dom.window.document.body.innerHTML;
}

/**
 * The rules above, on a live document: the raw page and the reader's HTML both go through them.
 * Links and embeds are made absolute here too — Telegra.ph resolves a relative URL against itself.
 */
export function resolveMedia(document: Document, baseUrl: string): void {
  const page = new URL(baseUrl).href.replace(/#.*$/, '');
  for (const img of document.querySelectorAll('img')) {
    const chosen = imageOf(img, baseUrl, page);
    img.removeAttribute('srcset');
    if (chosen === null) img.remove();
    else img.setAttribute('src', chosen);
  }
  // Readability drops an `<img>` that carries no source, which leaves Medium's
  // `<picture><source srcset>` orphaned: the sources themselves are the picture.
  for (const picture of document.querySelectorAll('picture')) {
    const chosen = sourceOf(picture, baseUrl, page);
    if (chosen === null || picture.querySelector('img') !== null) continue;
    const img = document.createElement('img');
    img.setAttribute('src', chosen);
    picture.appendChild(img);
  }
  // A hero drawn as a CSS background carries no `<img>` at all; Instant View needs one it can fetch.
  // Only the article's own container counts, or every banner and icon sprite becomes a picture.
  const painted = new Set<string>();
  for (const element of (document.querySelector('article, main') ?? document.body).querySelectorAll('[style]')) {
    const chosen = backgroundImages(element.getAttribute('style')).map((url) => usableUrl(url, baseUrl, page)).find((url) => url !== null);
    if (chosen === undefined || painted.has(chosen) || element.querySelector('img') !== null) continue;
    painted.add(chosen);
    const img = document.createElement('img');
    img.setAttribute('src', chosen);
    element.appendChild(img);
  }
  // `<video><source>` spells the file one level down; Telegra.ph's video node takes it as `src`.
  for (const video of document.querySelectorAll('video')) {
    const chosen = usableUrl(video.getAttribute('src') ?? video.querySelector('source')?.getAttribute('src') ?? '', baseUrl, page);
    if (chosen === null) video.remove();
    else video.setAttribute('src', chosen);
  }
  for (const iframe of document.querySelectorAll('iframe[src]')) {
    const chosen = absoluteUrl(iframe.getAttribute('src'), baseUrl);
    if (chosen === null) iframe.remove();
    else iframe.setAttribute('src', chosen);
  }
  // A relative href would be resolved against telegra.ph, not the publisher.
  for (const anchor of document.querySelectorAll('a[href]')) {
    const chosen = absoluteUrl(anchor.getAttribute('href'), baseUrl);
    if (chosen === null) anchor.removeAttribute('href');
    else anchor.setAttribute('href', chosen);
  }
}

/** An http(s) link in absolute form; a fragment or a `mailto:` has no place on a Telegraph page. */
function absoluteUrl(raw: string | null | undefined, baseUrl: string): string | null {
  if (!raw || raw.trim().startsWith('#')) return null;
  try {
    const url = new URL(raw, baseUrl);
    return /^https?:$/.test(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * The picture an `<img>` stands for. Medium ships the real file only in `<picture><source srcset>`
 * and leaves the `<img>` without a `src`; lazy images keep theirs in `data-src` behind a spacer.
 */
function imageOf(img: Element, baseUrl: string, page: string): string | null {
  const direct = imageSource(img.getAttribute('srcset'), img.getAttribute('src'), baseUrl, page);
  if (direct !== null) return direct;
  const picture = img.closest('picture');
  const fromSource = picture === null ? null : sourceOf(picture, baseUrl, page);
  if (fromSource !== null) return fromSource;
  return imageSource(null, img.getAttribute('data-src') ?? img.getAttribute('data-lazy-src'), baseUrl, page);
}

/** The widest candidate a `<picture>`'s own `<source srcset>` elements offer. */
function sourceOf(picture: Element, baseUrl: string, page: string): string | null {
  for (const source of picture.querySelectorAll('source')) {
    const chosen = imageSource(source.getAttribute('srcset') ?? source.getAttribute('data-srcset'), null, baseUrl, page);
    if (chosen !== null) return chosen;
  }
  return null;
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
