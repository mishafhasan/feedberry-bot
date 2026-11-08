import { Coded, E } from '../errors.ts';
import { HTML_LIMIT, type Http } from '../http.ts';
import { decodeEntities, discoverAlternates, fetchAndParse, handleFeedStatus, parseFeed, type FeedItem, type ParsedFeed } from './native.ts';
import type { SourceRef } from '../registry.ts';

/** Feed paths the common CMS families answer on; `/feed/` and `/rss` cover most of them. */
const SUFFIXES = ['/feed/', '/rss', '/rss.xml', '/feed.xml', '/index.xml', '/atom.xml'];

/** One resolve tries this many feeds, and never spends longer than this: a site without a feed for
 *  the section must fail at add time, not hang the flow. */
const MAX_FEEDS = 12;
const MAX_MS = 20_000;

/** A section word shorter than this matches too much in a URL to be evidence; a section id always counts. */
const MIN_KEY = 4;

/**
 * Stage 2 for a section source (ARCHITECTURE §5.3): the feed of one category of a site.
 * A category page rarely names its own feed, so the section proves itself in order through the feed
 * the page scopes to itself, the conventional path under the section, an alias the page links
 * (`/news/technology`), a feed directory the page links, or the site-wide feed filtered by category.
 */
export async function fetchSectionFeed(http: Http, ref: SourceRef, section: string): Promise<ParsedFeed> {
  // A stored feed already answered for this source; only an unscoped one needs the filter again.
  if (ref.feedUrl !== null) {
    const kept = usable(await fetchAndParse(http, ref.feedUrl), section, ref.canonicalUrl);
    if (kept === null) throw new Coded(E.NO_FEED, `nothing in ${section}`);
    return kept;
  }

  const page = await http(ref.canonicalUrl, { maxBytes: HTML_LIMIT });
  handleFeedStatus(page.status);
  if (/xml/.test(page.contentType) || page.body.trimStart().startsWith('<?xml')) {
    const kept = usable({ ...parseFeed(page.body, page.url), feedUrl: page.url }, section, page.url);
    if (kept === null) throw new Coded(E.NO_FEED, `nothing in ${section}`);
    return kept;
  }

  const alternates = discoverAlternates(page.body, page.url);
  const candidates = [
    ...alternates.filter((url) => isScoped(url, section)),
    ...SUFFIXES.map((suffix) => new URL(section + suffix, originOf(page.url)).toString()),
    ...aliasBases(page.body, page.url, section).flatMap((base) => [`${base}/rss.xml`, `${base}/feed/`]),
  ];

  const startedAt = Date.now();
  const remaining = (): number => MAX_MS - (Date.now() - startedAt);
  const tried = new Set<string>();
  const attempt = async (url: string): Promise<ParsedFeed | null> => {
    const left = remaining();
    if (tried.has(url) || tried.size >= MAX_FEEDS || left <= 0) return null;
    tried.add(url);
    return tryFeed(http, url, section, left, ref.canonicalUrl);
  };

  for (const url of candidates) {
    const feed = await attempt(url);
    if (feed !== null) return feed;
  }

  // A page that lists the site's feeds names the section's own feed, usually by its id. The site-wide
  // feed is the last resort, because it needs the item filter on every later check.
  for (const url of [...(await directoryFeeds(http, page.body, page.url, section, remaining)), ...alternates]) {
    const feed = await attempt(url);
    if (feed !== null) return feed;
  }

  throw new Coded(E.NO_FEED, `no feed for ${section}`);
}

/** A guessed URL that 404s or answers a soft-404 page is expected; the next candidate is the point. */
async function tryFeed(http: Http, url: string, section: string, timeoutMs: number, pageUrl: string): Promise<ParsedFeed | null> {
  try {
    return usable(await fetchAndParse(http, url, timeoutMs), section, pageUrl);
  } catch {
    return null;
  }
}

/**
 * A feed scoped to the section is already the section's own. A site-wide feed keeps only the items
 * that carry the section in their link or their `<category>` tags; none is `null`, never an empty feed.
 * The pasted page itself never counts: an article is an item of its own site's feed.
 */
function usable(feed: ParsedFeed, section: string, pageUrl: string): ParsedFeed | null {
  if (feed.feedUrl !== null && feed.feedUrl !== undefined && isScoped(feed.feedUrl, section)) return feed;
  const items = feed.items.filter((item) => !samePage(item.link, pageUrl) && inSection(item, section));
  return items.length === 0 ? null : { ...feed, items };
}

/** Two links to the same page, whatever tracking query or trailing slash the feed added. */
function samePage(left: string, right: string): boolean {
  try {
    const a = new URL(left);
    const b = new URL(right);
    return a.host === b.host && stripSlash(a.pathname) === stripSlash(b.pathname);
  } catch {
    return left === right;
  }
}

/** A feed URL carries the section's own segment: `/category/science/feed/`, `/news/technology/rss.xml`. */
function isScoped(url: string, section: string): boolean {
  const key = sectionKeys(section).at(-1);
  if (key === undefined) return false;
  try {
    return new URL(url).pathname.toLowerCase().split('/').includes(key);
  } catch {
    return false;
  }
}

/**
 * An item belongs to the section when its own URL carries the section's own segment, or when a tag
 * names it. Only the last segment counts: a parent directory (`/posts/`, `/news/`) is on every item.
 */
function inSection(item: FeedItem, section: string): boolean {
  const key = sectionKeys(section).at(-1);
  if (key === undefined) return false;
  let segments: string[] = [];
  try {
    segments = new URL(item.link).pathname.toLowerCase().split('/');
  } catch {
    // An item without a usable link can still name its section in a tag.
  }
  if (segments.includes(key)) return true;
  return (item.categories ?? []).some((tag) => {
    const value = slug(tag);
    if (value === key) return true;
    // A multi-word section (`gear-deals`) is named by a tag of the same words, in any order.
    const words = value.split('-');
    return key.includes('-') && key.split('-').every((word) => words.includes(word));
  });
}

/**
 * A section's feed often lives under a path the page links to itself: `bbc.com/technology` links
 * `bbc.co.uk/news/technology`, whose `rss.xml` is the technology feed. Any host is allowed — the
 * page's own `rel=alternate` is trusted the same way, and the request guard still refuses private
 * addresses.
 */
function aliasBases(html: string, pageUrl: string, section: string): string[] {
  const key = sectionKeys(section).at(-1);
  if (key === undefined) return [];
  const page = stripSlash(pageUrl);
  const bases: string[] = [];
  for (const match of html.matchAll(/href\s*=\s*["']([^"']{2,300})["']/gi)) {
    let url: URL;
    try {
      url = new URL(decodeEntities(match[1] ?? ''), pageUrl);
    } catch {
      continue;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
    const path = stripSlash(url.pathname);
    if (!path.toLowerCase().endsWith(`/${key}`)) continue;
    const base = `${url.origin}${path}`;
    if (base === page || bases.includes(base)) continue;
    bases.push(base);
    // One alias is enough evidence; more would only cost requests on a page full of section links.
    if (bases.length === 1) break;
  }
  return bases;
}

/** A page that lists the site's feeds (Daily Mirror's `/rss`) points at every section feed by id. */
async function directoryFeeds(http: Http, html: string, pageUrl: string, section: string, remaining: () => number): Promise<string[]> {
  const keys = sectionKeys(section).filter((key) => /^\d+$/.test(key) || key.length >= MIN_KEY);
  if (keys.length === 0) return [];

  const found: string[] = [];
  for (const directory of links(html, /rss|feeds?|syndicat/i, pageUrl, 2)) {
    const left = remaining();
    if (left <= 0) break;
    let index;
    try {
      index = await http(directory, { maxBytes: HTML_LIMIT, timeoutMs: left });
    } catch {
      continue;
    }
    if (index.status !== 200 || /xml/.test(index.contentType)) continue;
    for (const href of links(index.body, /\.(xml|rss|atom)(\?|$)|\/(rss|feed|feeds)\//i, index.url, 8)) {
      const lower = href.toLowerCase();
      if (!keys.some((key) => lower.includes(key)) || found.includes(href)) continue;
      found.push(href);
      if (found.length === 3) return found;
    }
  }
  return found;
}

/** Absolute links on a page that match a feed-ish shape, de-duplicated and capped. */
function links(html: string, shape: RegExp, baseUrl: string, limit: number): string[] {
  const found: string[] = [];
  for (const match of html.matchAll(/href\s*=\s*["']([^"'#]{2,300})["']/gi)) {
    const href = decodeEntities(match[1] ?? '');
    if (!shape.test(href) || /feedback|editorialguideline/i.test(href)) continue;
    try {
      const url = new URL(href, baseUrl).toString();
      if (!found.includes(url)) found.push(url);
    } catch {
      // A broken href is not a candidate.
    }
    if (found.length === limit) break;
  }
  return found;
}

function sectionKeys(section: string): string[] {
  return section
    .split('/')
    .filter((part) => part !== '')
    .map((part) => part.toLowerCase());
}

/** `Gear / Deals` → `gear-deals`, so a tag and a URL segment compare on the same words. */
function slug(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const stripSlash = (value: string): string => value.replace(/\/+$/, '');

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}
