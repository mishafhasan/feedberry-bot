import { platformForHost, normalizeHost } from './allowlist.ts';
import { fetchYouTubePost, type YouTubeChannel } from './feed/youtube-post.ts';
import { HTML_LIMIT, type Http } from './http.ts';

/**
 * The channel a YouTube link belongs to, for the chooser and the download result.
 *
 * A watch page is ~1.3 MB and took 11–12 s here, so the 10 s page budget always lost it; YouTube's
 * oEmbed card answers the same question in ~200 ms (`author_url`), and a community post — which has
 * no oEmbed — is read from its own page instead.
 */
export async function youtubeChannelOf(http: Http, link: string): Promise<YouTubeChannel | null> {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  if (platformForHost(normalizeHost(url.hostname)) !== 'youtube') return null;

  if (url.pathname.startsWith('/post/')) {
    try {
      return (await fetchYouTubePost(http, link)).channel;
    } catch {
      // A post the bot cannot read is still downloadable; it just cannot offer a channel.
      return null;
    }
  }
  return videoChannel(http, link);
}

/** `author_url` is the channel page; a topic channel answers `/channel/UC…`, which carries no handle. */
async function videoChannel(http: Http, link: string): Promise<YouTubeChannel | null> {
  try {
    const res = await http(`https://www.youtube.com/oembed?url=${encodeURIComponent(link)}&format=json`, { maxBytes: HTML_LIMIT, timeoutMs: 5_000 });
    if (res.status !== 200) return null;
    const author = (JSON.parse(res.body) as { author_url?: unknown }).author_url;
    if (typeof author !== 'string') return null;
    const handle = /\/@([^/?#]+)$/.exec(author)?.[1] ?? null;
    return { url: author, handle };
  } catch {
    // The card is a nicety: no channel offer is better than a failed download.
    return null;
  }
}
