import { Coded, E, isCoded, type ErrorCode } from '../errors.ts';
import { FEED_LIMIT, HTML_LIMIT, type Http } from '../http.ts';
import { backgroundImages, imageSource, usableUrl } from '../media-urls.ts';
import type { SourceRef } from '../registry.ts';

export interface FeedMedia {
  url: string;
  type: 'photo' | 'video' | 'audio' | 'unknown';
  /** The size the feed or the tag itself declares (MRSS attributes, `<img width height>`); absent when unknown. */
  width?: number;
  height?: number;
}

export interface FeedItem {
  guid: string;
  link: string;
  title: string;
  publishedAt: number | null;
  summary: string | null;
  media: FeedMedia[];
  /** `<category>` tags: the only thing a site-wide feed says about which section an item belongs to. */
  categories?: string[];
}

export interface ParsedFeed {
  title: string | null;
  avatarUrl: string | null;
  items: FeedItem[];
  /** The URL that actually answered with the feed, so a discovered one can be stored (stage 2). */
  feedUrl?: string | null;
}

/** §11: the status of a feed response decides the user-visible code. */
export function handleFeedStatus(status: number): void {
  if (status === 401 || status === 403) throw new Coded(E.COOKIE_REQUIRED, `feed replied ${status}`);
  if (status === 429) throw new Coded(E.RATE_LIMIT, 'feed replied 429');
  if (status === 404 || status === 410) throw new Coded(E.NO_FEED, `feed replied ${status}`);
  if (status >= 500 || status === 0) throw new Coded(E.FEED_DOWN, `feed replied ${status}`);
  if (status >= 400) throw new Coded(E.NO_FEED, `feed replied ${status}`);
}

export async function fetchAndParse(http: Http, url: string, timeoutMs?: number): Promise<ParsedFeed> {
  const res = await load(http, url, timeoutMs);
  return { ...parseFeed(res.body, res.url), feedUrl: res.url };
}

/**
 * The page list a site with no feed publishes (ADR-021). Only discovery's last guess and the URL it
 * stores read a sitemap: a `rel=alternate application/xml` is as often a sitemap as a feed, and that
 * one must still fall through to the conventional paths (ADR-019).
 */
export async function fetchSitemap(http: Http, url: string, timeoutMs?: number): Promise<ParsedFeed> {
  const res = await load(http, url, timeoutMs);
  return { ...parseSitemap(res.body, res.url), feedUrl: res.url };
}

async function load(http: Http, url: string, timeoutMs?: number) {
  const res = await http(url, { maxBytes: FEED_LIMIT, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
  handleFeedStatus(res.status);
  return res;
}

/**
 * A feed the page advertised that then refused. Keeping the URL lets the caller store it and key a
 * fallback route by the channel id it carries, exactly like a source added from a channel URL.
 */
export class DiscoveredFeedError extends Coded {
  readonly feedUrl: string;

  constructor(code: ErrorCode, feedUrl: string, message: string) {
    super(code, message);
    this.feedUrl = feedUrl;
  }
}

/** Stage 2 for `native_rss`: use the feed, or discover `rel=alternate` / common paths. */
export async function fetchNativeFeed(http: Http, ref: SourceRef, budgetMs = 20_000): Promise<ParsedFeed> {
  // A stored fallback is a sitemap by name, which is the one thing this reader can tell without a fetch.
  if (ref.feedUrl) return isSitemapUrl(ref.feedUrl) ? fetchSitemap(http, ref.feedUrl) : fetchAndParse(http, ref.feedUrl);

  const page = await http(ref.canonicalUrl, { maxBytes: HTML_LIMIT });
  handleFeedStatus(page.status);
  if (/xml/.test(page.contentType) || page.body.trimStart().startsWith('<?xml')) return parseFeed(page.body, page.url);

  for (const candidate of discoverAlternateLinks(page.body, page.url)) {
    try {
      const feed = await fetchAndParse(http, candidate.url);
      // A channel page states its avatar; YouTube's own feed carries none, so the preview would be text.
      return feed.avatarUrl === null ? { ...feed, avatarUrl: pageImage(page.body) } : feed;
    } catch (err) {
      if (!isCoded(err)) throw err;
      // rss/atom/rdf is a promise the page made. A plain `application/xml` alternate may be a sitemap,
      // so it falls through to the next candidate and then to the guessed paths.
      if (candidate.strong) throw new DiscoveredFeedError(err.code, candidate.url, err.message);
    }
  }

  // Five guesses at the 20 s default would hold one check for 100 s; the budget is the whole search.
  const deadline = Date.now() + budgetMs;
  for (const path of ['/feed', '/rss', '/feed.xml', '/rss.xml', '/atom.xml']) {
    const left = deadline - Date.now();
    if (left <= 0) break;
    try {
      const candidate = new URL(path, page.url).toString();
      const feed = await fetchAndParse(http, candidate, left);
      if (feed.items.length > 0) return feed;
    } catch {
      // A 404 on a guessed path is expected; try the next one.
    }
  }

  // A site with no feed of its own still lists its pages, and that list is the last resort (ADR-021).
  const left = deadline - Date.now();
  if (left > 0) {
    try {
      return await fetchSitemap(http, new URL('/sitemap.xml', page.url).toString(), left);
    } catch {
      // Most sites have no sitemap either; NO_FEED below is the honest answer.
    }
  }
  throw new Coded(E.NO_FEED, 'no feed discovered');
}

/** The page's own card image (`og:image`): the avatar a feed without an `<image>` cannot offer. */
function pageImage(html: string): string | null {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    if (!/property\s*=\s*["']og:image["']/i.test(tag)) continue;
    const content = attr(tag, 'content');
    if (content) return decodeEntities(content);
  }
  return null;
}

export function discoverAlternates(html: string, baseUrl: string): string[] {
  return discoverAlternateLinks(html, baseUrl).map((link) => link.url);
}

/**
 * Alternates in trust order: rss/atom/rdf first, a plain `application/xml` last — that one is as often a
 * sitemap as a feed, so its failure must not end discovery. Stable within each rank.
 */
function discoverAlternateLinks(html: string, baseUrl: string): Array<{ url: string; strong: boolean }> {
  const strong: Array<{ url: string; strong: boolean }> = [];
  const weak: Array<{ url: string; strong: boolean }> = [];
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    if (!/rel\s*=\s*["']?alternate/i.test(tag)) continue;
    const typed = /type\s*=\s*["']?application\/(rss|atom|rdf)\+xml/i.test(tag);
    // RSS 1.0 advertises `application/rdf+xml`, older sites plain `application/xml` or `text/xml`.
    if (!typed && !/type\s*=\s*["']?(application|text)\/xml(?![-\w])/i.test(tag)) continue;
    const href = attr(tag, 'href');
    if (!href) continue;
    try {
      (typed ? strong : weak).push({ url: new URL(decodeEntities(href), baseUrl).toString(), strong: typed });
    } catch {
      // A broken href advertises nothing; the next one still counts.
    }
  }
  return [...strong, ...weak];
}

export function discoverAlternate(html: string, baseUrl: string): string | null {
  return discoverAlternates(html, baseUrl)[0] ?? null;
}

/**
 * RSS 2.0 / Atom reader.
 * shortcut: regex parser for well-formed feeds; a feed that breaks it needs a real XML parser.
 */
export function parseFeed(xml: string, baseUrl: string): ParsedFeed {
  const head = xml.split(/<(item|entry)\b/i)[0] ?? xml;
  const blocks = [...xml.matchAll(/<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi)].map((m) => m[2] ?? '');

  const items: FeedItem[] = [];
  const seen = new Set<string>();
  for (const block of blocks) {
    const link = linkOf(block, baseUrl);
    const guid = text(firstTag(block, 'guid') ?? firstTag(block, 'id')) || link;
    if (!guid || seen.has(guid)) continue;
    seen.add(guid);
    // A feed may carry a short `description` beside the full `content:encoded`. The longest is
    // the post; picking the first tag drops the caption entirely on CMS feeds.
    const html = bodyOf(block);
    const images = inlineImages(html, link, baseUrl);
    const summary = summaryOf(html, images, baseUrl);
    items.push({
      guid,
      link,
      // No invented title: the renderer owns the fallbacks, and a copy of the body would repeat it.
      title: stripTags(firstTag(block, 'title')),
      publishedAt: dateOf(firstTag(block, 'pubDate') ?? firstTag(block, 'published') ?? firstTag(block, 'dc:date') ?? firstTag(block, 'updated')),
      summary: summary || null,
      media: mediaOf(block, images, baseUrl),
      categories: categoriesOf(block),
    });
  }

  if (items.length === 0) {
    // "No items" reads like an empty feed; the message has to tell an empty channel from a broken page.
    const feedish = /<rss\b|<feed\b|<rdf:RDF/i.test(xml);
    throw new Coded(E.NO_FEED, feedish ? 'feed has no readable items' : `not a feed: ${text(xml.slice(0, 80))}`);
  }

  return {
    title: stripTags(firstTag(head, 'title')) || null,
    avatarUrl: avatarOf(head, baseUrl),
    items,
  };
}

/** The name a sitemap is stored under: `<origin>/sitemap.xml`, or one the user pasted as a feed. */
const SITEMAP_URL = /^sitemap/i;

/** The URL discovery falls back to, and stores, for a site that publishes no feed. */
function isSitemapUrl(url: string): boolean {
  try {
    return SITEMAP_URL.test(new URL(url).pathname.split('/').pop() ?? '');
  } catch {
    return false;
  }
}

/** How many of a sitemap's pages one source follows: a sitemap is an inventory, not a 20-item feed. */
const SITEMAP_ITEMS = 50;
/** An undated sitemap cannot be ordered, so its whole list is the source; this only bounds the parse. */
const SITEMAP_MAX = 1000;

/**
 * Last resort for a site that publishes no feed at all (ADR-021): a beehiiv newsletter with RSS
 * switched off still lists its posts in a sitemap. Only the path segment that holds most of the
 * sitemap is followed — a newsletter's `/p/…`, a blog's `/blog/…` — because `/about` and
 * `/subscribe` are the site, not its posts. With no such directory the whole sitemap is the blog.
 * shortcut: `<urlset>` only; a `<sitemapindex>` needs its children fetched, and such a site has a feed.
 */
export function parseSitemap(xml: string, baseUrl: string): ParsedFeed {
  const entries: Array<{ url: string; at: number | null }> = [];
  const seen = new Set<string>();
  for (const match of xml.matchAll(/<url>([\s\S]*?)<\/url>/gi)) {
    const block = match[1] ?? '';
    const raw = text(firstTag(block, 'loc'));
    if (raw === '') continue;
    let url: URL;
    try {
      url = new URL(decodeEntities(raw), baseUrl);
    } catch {
      continue; // A broken <loc> lists nothing.
    }
    if (!/^https?:$/.test(url.protocol) || url.pathname === '/') continue;
    const href = url.toString();
    if (seen.has(href)) continue;
    seen.add(href);
    entries.push({ url: href, at: dateOf(firstTag(block, 'lastmod')) });
  }

  const directory = postDirectory(entries);
  const pages = entries.filter((entry) => directory === null || pathSegment(entry.url) === directory);
  // A dated sitemap is read newest first and only its window is followed; the rest is history. An
  // undated one cannot be ordered, so every page counts — a fixed first-N window would freeze the
  // source on whichever pages the file happens to list first and never deliver again.
  const window = pages.some((entry) => entry.at !== null)
    ? [...pages].sort((left, right) => (right.at ?? 0) - (left.at ?? 0)).slice(0, SITEMAP_ITEMS)
    : pages.slice(0, SITEMAP_MAX);
  const items: FeedItem[] = window.map((entry) => ({
    guid: entry.url,
    link: entry.url,
    // A sitemap carries no titles; the page's own slug is the one line a list can print.
    title: slugTitle(entry.url),
    publishedAt: entry.at,
    summary: null,
    media: [],
  }));
  if (items.length === 0) throw new Coded(E.NO_FEED, 'sitemap lists no pages');
  return { title: null, avatarUrl: null, items };
}

/** The first path segment that holds at least half the sitemap, or null when the paths are flat. */
function postDirectory(entries: Array<{ url: string }>): string | null {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const segment = pathSegment(entry.url);
    if (segment !== '') counts.set(segment, (counts.get(segment) ?? 0) + 1);
  }
  const top = [...counts.entries()].sort((left, right) => right[1] - left[1])[0];
  return top !== undefined && top[1] * 2 >= entries.length ? top[0] : null;
}

function pathSegment(url: string): string {
  try {
    return new URL(url).pathname.split('/').find((part) => part !== '') ?? '';
  } catch {
    return '';
  }
}

/** `nvidia-ceo-admits-affair` for a page whose sitemap entry names nothing else. */
function slugTitle(url: string): string {
  const tail = url.split('/').filter(Boolean).at(-1) ?? '';
  let last = tail;
  try {
    last = decodeURIComponent(tail);
  } catch {
    // A malformed escape keeps its raw spelling.
  }
  const words = last.replace(/[-_]+/g, ' ').trim();
  return words.length <= 120 ? words : `${words.slice(0, 119)}…`;
}

function avatarOf(head: string, baseUrl: string): string | null {
  const image = firstTag(head, 'image');
  const itunesImage = head.match(/<itunes:image\b[^>]*>/i)?.[0];
  const candidate =
    (image ? text(firstTag(image, 'url')) : null) ?? // RSS <image><url>child</url></image>
    (itunesImage ? attr(itunesImage, 'href') : null) ??
    text(firstTag(head, 'logo')) ??
    text(firstTag(head, 'icon'));
  if (!candidate) return null;
  try {
    return new URL(decodeEntities(candidate), baseUrl).toString();
  } catch {
    return null;
  }
}

/** RSS puts the label in the body, Atom in `term`; both may repeat, and a duplicate is noise. */
function categoriesOf(block: string): string[] | undefined {
  const tags: string[] = [];
  for (const match of block.matchAll(/<category\b([^>]*)>([\s\S]*?)<\/category>|<category\b([^>]*)\/>/gi)) {
    const attrs = match[1] ?? match[3] ?? '';
    const label = decodeEntities(/\bterm\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1] ?? stripTags(match[2] ?? '')).trim();
    if (label !== '' && !tags.includes(label)) tags.push(label);
  }
  return tags.length === 0 ? undefined : tags;
}

function mediaOf(block: string, images: MediaImage[], baseUrl: string): FeedMedia[] {
  const media: FeedMedia[] = [];
  const seen = new Set<string>();
  const add = (entry: FeedMedia): void => {
    if (seen.has(entry.url)) return;
    seen.add(entry.url);
    media.push(entry);
  };
  for (const tag of block.match(/<(enclosure|media:content|media:thumbnail)\b[^>]*>/gi) ?? []) {
    const url = attr(tag, 'url');
    if (!url) continue;
    // A `media:thumbnail` is always a picture, even when it carries no type attribute.
    const type = /^<media:thumbnail/i.test(tag) ? 'photo' : kindOf(attr(tag, 'type'));
    try {
      add({ url: new URL(decodeEntities(url), baseUrl).toString(), type, ...sizeOf({ width: attr(tag, 'width'), height: attr(tag, 'height') }) });
    } catch {
      // A broken enclosure URL is not media, and it must not cost the item.
    }
  }
  for (const image of images) add({ url: image.url, type: 'photo', ...sizeOf(image) });
  // A gallery bigger than this is a datasheet, not a post; every URL would land in one payload row.
  return media.length > MEDIA_PER_POST ? media.slice(0, MEDIA_PER_POST) : media;
}

/** shortcut: 50 pictures per post; raise it if a feed ever ships a real gallery past that. */
const MEDIA_PER_POST = 50;

/** MRSS and `<img>` state a picture's size in attributes; a size that is not a number is not a size. */
function sizeOf(source: { width?: string | number | null; height?: string | number | null }): { width?: number; height?: number } {
  const size: { width?: number; height?: number } = {};
  const width = Number(source.width ?? NaN);
  const height = Number(source.height ?? NaN);
  if (Number.isInteger(width) && width > 0) size.width = width;
  if (Number.isInteger(height) && height > 0) size.height = height;
  return size;
}

/** One picture a post body carries, with the size its own tag declared. */
interface MediaImage {
  url: string;
  width?: number;
  height?: number;
}

/** The picture tags a post body can carry, and any tag that paints one in CSS. */
const IMAGE_TAG = /<img\b[^>]*>|<source\b[^>]*>|<[a-z][^>]*\bstyle\s*=\s*(?:"[^"]*"|'[^']*')[^>]*>/gi;

/**
 * Every picture the post's own HTML carries, in post order (ADR-021). A CMS that ships its gallery
 * only inside `content:encoded` left `FeedItem.media` empty, so Telegram got a bare link card.
 * `page` is the post itself: an image pointing back at it is a broken picture, not media.
 */
function inlineImages(html: string | null, baseUrl: string, page: string): MediaImage[] {
  if (!html) return [];
  const found = new Map<string, MediaImage>();
  const add = (url: string | null, size: { width?: number; height?: number } = {}): void => {
    if (url !== null && !found.has(url)) found.set(url, { url, ...size });
  };
  for (const [tag] of html.matchAll(IMAGE_TAG)) {
    if (/^<img\b/i.test(tag)) {
      // A lazy image keeps its real file in `data-src` while `src` is a data: URI or a spacer.
      const lazy = attr(tag, 'data-src') ?? attr(tag, 'data-lazy-src') ?? attr(tag, 'data-original');
      add(
        imageSource(attr(tag, 'srcset'), attr(tag, 'src'), baseUrl, page) ?? imageSource(null, lazy, baseUrl, page),
        sizeOf({ width: attr(tag, 'width'), height: attr(tag, 'height') }),
      );
    } else if (/^<source\b/i.test(tag)) {
      // Medium spells its picture only on `<source>`; the `<img>` under it has no source at all.
      add(imageSource(attr(tag, 'srcset') ?? attr(tag, 'data-srcset'), null, baseUrl, page));
    }
    // A CSS background is a picture the post never spelled as one. `attr` cannot read this one: a
    // quoted `url('…')` closes its match early, so the style is parsed whole.
    const style = /\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
    for (const raw of backgroundImages(style?.[1] ?? style?.[2])) add(usableUrl(decodeEntities(raw), baseUrl, page));
  }
  return [...found.values()];
}

/** The item's longest body, still as the HTML it was written in: its pictures and embeds live there. */
function bodyOf(block: string): string | null {
  let best: string | null = null;
  let bestLength = 0;
  for (const tag of ['description', 'summary', 'content:encoded', 'content']) {
    const raw = firstTag(block, tag);
    if (raw === null) continue;
    // A body is sometimes escaped instead of wrapped in CDATA (`&lt;img …&gt;`), and then no tag
    // rule can see its pictures. Only media markup counts: `<p>` is a topic, not a body.
    const html = ESCAPED_MARKUP.test(raw) && !REAL_MARKUP.test(raw) ? decodeEntities(raw) : raw;
    const length = stripTags(html, true).length;
    if (length > bestLength) {
      best = html;
      bestLength = length;
    }
  }
  return best;
}

const ESCAPED_MARKUP = /&lt;\s*(?:img|picture|source|iframe|video|embed)\b/i;
const REAL_MARKUP = /<\s*(?:img|picture|source|iframe|video|embed)\b/i;

/** The post's words, then a line per player and per animation: a caption can play neither (ADR-021). */
function summaryOf(html: string | null, images: MediaImage[], baseUrl: string): string {
  // The words are what a reader can live without at the cap; a player line must never be the part cut.
  const text = stripTags(html, true).slice(0, SUMMARY_LIMIT);
  const players = embedLinks(html, baseUrl).map((url) => `🎬 ${url}`);
  // A remote `.gif` reaches Telegram as a still picture, so the animation also gets a tappable link.
  const loops = images.filter((image) => /\.gif$/i.test(pathOf(image.url))).map((image) => `🎞️ ${image.url}`);
  return [text, ...players, ...loops].filter((part) => part !== '').join('\n\n');
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return '';
  }
}

/** Hosts and files whose embed URL is a video rather than a picture or an audio clip. */
const VIDEO_URL = /(?:^|\.)(?:youtube\.com|youtu\.be|vimeo\.com|dailymotion\.com|streamable\.com|loom\.com)$|^player\.twitch\.tv$|\.(?:mp4|webm|mov|m3u8)$/i;

/** Every video the post's HTML embeds, so the caption carries a link Telegram can actually play. */
function embedLinks(html: string | null, baseUrl: string): string[] {
  if (!html) return [];
  const found: string[] = [];
  for (const tag of html.match(/<(?:iframe|video|embed|source)\b[^>]*>/gi) ?? []) {
    const raw = attr(tag, 'src') ?? attr(tag, 'data-src');
    if (raw === null) continue;
    try {
      const url = new URL(decodeEntities(raw), baseUrl);
      // An audio or poster <source> is not a video; only a player URL earns a line.
      if (VIDEO_URL.test(url.hostname) || VIDEO_URL.test(url.pathname)) found.push(url.toString());
    } catch {
      // A broken embed URL embeds nothing.
    }
  }
  return [...new Set(found)];
}

function kindOf(type: string | null): FeedMedia['type'] {
  if (!type) return 'unknown';
  if (type.startsWith('video')) return 'video';
  if (type.startsWith('audio')) return 'audio';
  if (type.startsWith('image')) return 'photo';
  return 'unknown';
}

/** RSS puts the URL in the body, Atom in `href`; an entry's own page is `rel=alternate` (RFC 4287 §4.2.7.1). */
function linkOf(block: string, baseUrl: string): string {
  const tags = block.match(/<link\b[^>]*>/gi) ?? [];
  const alternate = tags.find((tag) => /rel\s*=\s*["']?alternate/i.test(tag) && attr(tag, 'href') !== null);
  const plain = tags.find((tag) => !/rel\s*=/i.test(tag));
  const href = text(firstTag(block, 'link')) || attr(alternate ?? plain ?? tags[0] ?? '', 'href');
  if (!href) return baseUrl;
  try {
    return new URL(decodeEntities(href), baseUrl).toString();
  } catch {
    return baseUrl;
  }
}

function dateOf(raw: string | null): number | null {
  if (!raw) return null;
  const parsed = Date.parse(text(raw));
  return Number.isNaN(parsed) ? null : parsed;
}

function firstTag(block: string, name: string): string | null {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i').exec(block);
  return m ? (m[1] ?? null) : null;
}

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(tag);
  return m ? (m[1] ?? null) : null;
}

/** CDATA first, then tags, then entities — in that order or a CDATA block is eaten as markup. */
function stripTags(raw: string | null, keepParagraphs = false): string {
  if (!raw) return '';
  const html = decodeEntities(raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1'));
  if (!keepParagraphs) return text(html.replace(/<[^>]*>/g, ' '));
  // Block ends become a blank line, <br> a line, so a caption keeps the post's own paragraphs.
  const spaced = html
    .replace(/<\s*br\s*\/?>/gi, '\u000A')
    .replace(/<\s*\/\s*(?:p|div|li|h[1-6]|blockquote|tr)\s*>/gi, '\u000A\u000A')
    .replace(/<[^>]*>/g, ' ');
  return spaced
    .replace(/[^\S\u000A]+/g, ' ')
    .replace(/ *\u000A */g, '\u000A')
    .replace(/\u000A{3,}/g, '\u000A\u000A')
    .trim();
}

/** A post's body is kept whole up to one message; the renderer splits anything longer. */
export const SUMMARY_LIMIT = 4000;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Also used by the meta-description reader: feed and page share one entity vocabulary. */
export function decodeEntities(raw: string): string {
  return raw
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&(\w+);/g, (match, name: string) => ENTITIES[name.toLowerCase()] ?? match);
}

function text(raw: string | null): string {
  return (raw ?? '').replace(/\s+/g, ' ').trim();
}
