import { HTML_LIMIT, type Http } from './http.ts';
import { classifyLink, type DetectOptions } from './registry.ts';

/**
 * The account a pin belongs to. The pin URL never names it, but Pinterest's oEmbed card does:
 * `author_url` is the pinner's profile. shortcut: pin.it short links are not resolved, add the
 * redirect if a user ever reports one.
 */
export async function pinOwner(http: Http, link: string, opts: DetectOptions): Promise<string | null> {
  if (!/^https?:\/\/(?:[\w-]+\.)*pinterest\.[\w.]+/i.test(link)) return null;
  try {
    const res = await http(`https://www.pinterest.com/oembed.json?url=${encodeURIComponent(link)}`, { maxBytes: HTML_LIMIT, timeoutMs: 5_000 });
    if (res.status !== 200) return null;
    const author = (JSON.parse(res.body) as { author_url?: unknown }).author_url;
    const handle = typeof author === 'string' ? /\/([^/?#]+)\/?$/.exec(author)?.[1] : undefined;
    if (handle === undefined) return null;

    const profileUrl = `https://pinterest.com/${decodeURIComponent(handle)}`;
    // Only what the add flow accepts: /ideas/ and /search/ are browse pages, never accounts.
    return classifyLink(profileUrl, opts).kind === 'source' ? profileUrl : null;
  } catch {
    // An unreadable card costs the Add button, never the download.
    return null;
  }
}
