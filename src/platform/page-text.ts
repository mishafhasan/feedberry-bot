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

/** Fetches the post page for its description; any failure means "no text", never an error. */
export async function pageText(http: Http, url: string): Promise<string | null> {
  try {
    const res = await http(url, { maxBytes: HTML_LIMIT, timeoutMs: 10_000 });
    if (res.status !== 200 || !/html|xml/i.test(res.contentType)) return null;
    return metaDescription(res.body);
  } catch {
    return null;
  }
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
