import { HTML_LIMIT, type Http } from './http.ts';

/**
 * X cuts every public text surface at ~280 characters (page meta, syndication, oEmbed); the full
 * note tweet lives behind X's GraphQL, whose query id rotates and currently answers 404. FxTwitter
 * is a free, key-less mirror of that same GraphQL data, used only for the post's words.
 */
const X_URL = /^https:\/\/(?:www\.)?(?:x|twitter)\.com\/([^/]+)\/status\/(\d+)/;

export async function xFullText(http: Http, url: string): Promise<string | null> {
  const match = X_URL.exec(url);
  if (!match) return null;
  try {
    const res = await http(`https://api.fxtwitter.com/${match[1]}/status/${match[2]}`, { maxBytes: HTML_LIMIT, timeoutMs: 10_000 });
    if (res.status !== 200) return null;
    const data = JSON.parse(res.body) as { tweet?: { text?: string } };
    const text = (data.tweet?.text ?? '').trim();
    return text === '' ? null : text;
  } catch {
    return null;
  }
}
