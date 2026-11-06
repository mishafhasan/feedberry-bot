import { Coded, E } from '../platform/errors.ts';
import { fetchBlueskyFeed } from '../platform/feed/bluesky.ts';
import { fetchNativeFeed, type ParsedFeed } from '../platform/feed/native.ts';
import { fetchRsshubFeed } from '../platform/feed/rsshub.ts';
import { fetchYouTubeChannelPosts } from '../platform/feed/youtube-post.ts';
import type { Http } from '../platform/http.ts';
import type { SourceRef } from '../platform/registry.ts';

/** Stage 2 (ARCHITECTURE §5.3): the strategy of the SourceRef picks the adapter. */
export function fetchFeed(http: Http, ref: SourceRef): Promise<ParsedFeed> {
  switch (ref.strategy) {
    case 'native_rss':
      return fetchNativeFeed(http, ref);
    case 'rsshub':
      return fetchRsshubFeed(http, ref);
    case 'bluesky_api':
      return fetchBlueskyFeed(http, ref);
    case 'single_post':
      throw new Coded(E.LINK_INVALID, 'a post link has no feed');
  }
}

/**
 * Stage 2 for one source. A YouTube channel's uploads feed carries videos and Shorts but never its
 * Posts tab, so that tab is read as a second feed — only when a subscriber asked for it.
 */
export async function fetchSourceFeed(http: Http, ref: SourceRef, includePosts: boolean): Promise<ParsedFeed> {
  const feed = await fetchFeed(http, ref);
  if (!includePosts || ref.platform !== 'youtube') return feed;
  const posts = await fetchYouTubeChannelPosts(http, ref.canonicalUrl);
  return posts.length === 0 ? feed : { ...feed, items: [...feed.items, ...posts] };
}
