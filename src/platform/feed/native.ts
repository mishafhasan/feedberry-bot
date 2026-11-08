import { Coded, E, isCoded, type ErrorCode } from '../errors.ts';
import { FEED_LIMIT, HTML_LIMIT, type Http } from '../http.ts';
import type { SourceRef } from '../registry.ts';

export interface FeedMedia {
  url: string;
  type: 'photo' | 'video' | 'audio' | 'unknown';
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
  const res = await http(url, { maxBytes: FEED_LIMIT, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
  handleFeedStatus(res.status);
  return { ...parseFeed(res.body, res.url), feedUrl: res.url };
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
  if (ref.feedUrl) return fetchAndParse(http, ref.feedUrl);

  const page = await http(ref.canonicalUrl, { maxBytes: HTML_LIMIT });
  handleFeedStatus(page.status);
  if (/xml/.test(page.contentType) || page.body.trimStart().startsWith('<?xml')) return parseFeed(page.body, page.url);

  const alternate = discoverAlternate(page.body, page.url);
  if (alternate) {
    let feed: ParsedFeed;
    try {
      feed = await fetchAndParse(http, alternate);
    } catch (err) {
      if (isCoded(err)) throw new DiscoveredFeedError(err.code, alternate, err.message);
      throw err;
    }
    // A channel page states its avatar; YouTube's own feed carries none, so the preview would be text.
    return feed.avatarUrl === null ? { ...feed, avatarUrl: pageImage(page.body) } : feed;
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
  const feeds: string[] = [];
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    if (!/rel\s*=\s*["']?alternate/i.test(tag)) continue;
    // RSS 1.0 advertises `application/rdf+xml`, older sites plain `application/xml` or `text/xml`.
    if (!/type\s*=\s*["']?(application\/(rss|atom|rdf)\+xml|(application|text)\/xml)(?![-\w])/i.test(tag)) continue;
    const href = attr(tag, 'href');
    if (!href) continue;
    try {
      feeds.push(new URL(decodeEntities(href), baseUrl).toString());
    } catch {
      // A broken href advertises nothing; the next one still counts.
    }
  }
  return feeds;
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
    const bodies = ['description', 'summary', 'content:encoded', 'content']
      .map((tag) => stripTags(firstTag(block, tag), true))
      .filter((candidate) => candidate !== '');
    const summary = bodies.sort((left, right) => right.length - left.length)[0] ?? '';
    items.push({
      guid,
      link,
      // No invented title: the renderer owns the fallbacks, and a copy of the body would repeat it.
      title: stripTags(firstTag(block, 'title')),
      publishedAt: dateOf(firstTag(block, 'pubDate') ?? firstTag(block, 'published') ?? firstTag(block, 'dc:date') ?? firstTag(block, 'updated')),
      summary: summary ? summary.slice(0, SUMMARY_LIMIT) : null,
      media: mediaOf(block, baseUrl),
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

function mediaOf(block: string, baseUrl: string): FeedMedia[] {
  const media: FeedMedia[] = [];
  for (const tag of block.match(/<(enclosure|media:content|media:thumbnail)\b[^>]*>/gi) ?? []) {
    const url = attr(tag, 'url');
    if (!url) continue;
    // A `media:thumbnail` is always a picture, even when it carries no type attribute.
    const type = /^<media:thumbnail/i.test(tag) ? 'photo' : kindOf(attr(tag, 'type'));
    media.push({ url: new URL(decodeEntities(url), baseUrl).toString(), type });
  }
  return media;
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
  const alternate = tags.find((tag) => /rel\s*=\s*["']?alternate/i.test(tag));
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
