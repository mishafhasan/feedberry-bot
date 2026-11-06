import { decodeEntities } from './feed/native.ts';
import { HTML_LIMIT, type Http } from './http.ts';

/**
 * The post's own words when neither the feed nor the media engine carries them: X/Twitter, TikTok
 * and Facebook extractors return media only, so the caption would otherwise be the source link.
 * Read only when the text is missing, so a working path pays no extra fetch.
 */
const META_KEYS = ['og:description', 'twitter:description', 'description'];

/** `og:description` first, then the Twitter card, then plain meta. */
export function metaDescription(html: string): string | null {
  for (const key of META_KEYS) {
    const value = metaContent(html, key);
    if (value !== null && !isNoise(value)) return value;
  }
  return null;
}

/** What a post page states about itself: the words, the account, and when it went out. */
export interface PageMeta {
  text: string | null;
  name: string | null;
  publishedAt: number | null;
  /** The post's own video file, when the page links one directly (Snapchat spotlight). */
  video: string | null;
  /** The channel a video page belongs to, so a download can offer that channel as a source. */
  channel: { url: string; handle: string | null } | null;
}

/** Fetches the post page once for everything the layout needs; any failure means "nothing known". */
export async function pageMeta(http: Http, url: string): Promise<PageMeta> {
  try {
    const res = await http(url, { maxBytes: HTML_LIMIT, timeoutMs: 10_000 });
    if (res.status !== 200 || !/html|xml/i.test(res.contentType)) return NOTHING;
    return {
      text: metaDescription(res.body),
      name: profileNameOf(res.body),
      publishedAt: publishedAtOf(res.body),
      video: metaVideoOf(res.body),
      channel: channelOf(res.body),
    };
  } catch {
    return NOTHING;
  }
}

const NOTHING: PageMeta = { text: null, name: null, publishedAt: null, video: null, channel: null };

/** The post's own words when neither the feed nor the media engine carries them. */
export async function pageText(http: Http, url: string): Promise<string | null> {
  return (await pageMeta(http, url)).text;
}

/** The card's video file, when the page points at one (a Snapchat spotlight clip). */
export function metaVideoOf(html: string): string | null {
  return metaContent(html, 'og:video') ?? metaContent(html, 'og:video:secure_url');
}

/**
 * `PROMPT HUB (@prompt.__hub) on Threads`, `Humor Satire Memes (@x.bsky.social)`,
 * `Name on Instagram: …` and Snapchat's `… | Funny Vidz (@klipz96) | …` all name the account;
 * a page whose title is the post itself names nobody.
 */
export function profileNameOf(html: string): string | null {
  const title = metaContent(html, 'og:title');
  if (title === null) return null;
  const handle = /^([^|]*?) \(@?[\w.]+(?:\s*on\s[\w ]+)?\)/.exec(title) ?? /([^|]+?) \(@[\w.]+(?:\)|\s)/.exec(title);
  if (handle?.[1]) return handle[1].trim() || null;
  return /^(.*?) on (?:X|Instagram|Threads|Bluesky|Facebook|TikTok)\b/.exec(title)?.[1]?.trim() || null;
}

/**
 * A video page names the channel that posted it: YouTube's player state carries the `UC…` id and the
 * tabbed URL carries the handle. Every other platform states no channel here.
 * The `@handle` spelling is the one every add path canonicalises to, so one channel stays one source.
 */
export function channelOf(html: string): { url: string; handle: string | null } | null {
  const id = /"channelId":"(UC[\w-]{22})"/.exec(html)?.[1];
  if (id === undefined) return null;
  const base = /"canonicalBaseUrl":"(\/@[^"]+)"/.exec(html)?.[1];
  // A Shorts page appends its own tab to the handle (`/@name/shorts`).
  const handle = base?.replace(/^\/@/, '').replace(/\/(?:shorts|videos|posts|streams|featured)$/, '') ?? '';
  return { url: handle === '' ? `https://youtube.com/channel/${id}` : `https://youtube.com/@${handle}`, handle: handle === '' ? null : handle };
}

/** The page's own publish date (meta, JSON-LD, or the epoch a player state carries). */
export function publishedAtOf(html: string): number | null {
  const raw =
    metaContent(html, 'article:published_time') ??
    metaContent(html, 'og:updated_time') ??
    // YouTube ships its dates only as JSON-LD on the watch page.
    /"(?:datePublished|uploadDate|publishDate)"\s*:\s*"([^"]+)"/.exec(html)?.[1] ??
    null;
  if (raw !== null) {
    const ms = Date.parse(raw);
    if (Number.isFinite(ms)) return ms;
  }
  // A player state dates a post in epoch seconds (TikTok) or milliseconds.
  const epoch = /"(?:createTime|taken_at|publish_time|creation_time)"\s*:\s*"?(\d{10,13})/.exec(html)?.[1];
  if (epoch === undefined) return null;
  const value = Number(epoch);
  return value < 1e12 ? value * 1000 : value;
}

function metaContent(html: string, key: string): string | null {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const name = attr(tag, 'property') ?? attr(tag, 'name');
    if (name?.toLowerCase() !== key) continue;
    const content = attr(tag, 'content');
    if (content !== null) return decodeEntities(content).replace(/\s+/g, ' ').trim();
  }
  return null;
}

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(tag);
  return m ? (m[1] ?? null) : null;
}

/** A bare link or a platform banner ("The latest tweets from @x") is not the post. */
function isNoise(value: string): boolean {
  return value.length < 3 || /^https?:\/\/\S+$/i.test(value) || /^the latest tweets from/i.test(value);
}
