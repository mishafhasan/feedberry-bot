import { Coded, E } from '../platform/errors.ts';
import type { ContentKind } from '../platform/content-types.ts';
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
 * Stage 2 for one source, fetching only the feeds the selection needs. A YouTube channel's uploads
 * feed carries videos and Shorts but never its Posts tab, which is a second feed — and a channel
 * whose uploads feed is empty or gone must still be addable for its posts alone.
 */
export async function fetchSourceFeed(http: Http, ref: SourceRef, selected: ContentKind[] | null): Promise<ParsedFeed> {
  const youtube = ref.platform === 'youtube';
  // A null selection is a row from before the picker: it watches everything.
  const wantsUploads = !youtube || selected === null || selected.includes('video') || selected.includes('short');
  const wantsPosts = youtube && (selected === null || selected.includes('post'));

  const uploads: ParsedFeed = wantsUploads ? await fetchFeed(http, ref) : { title: null, avatarUrl: null, items: [] };
  if (!wantsPosts) return uploads;

  try {
    return { ...uploads, items: [...uploads.items, ...(await fetchYouTubeChannelPosts(http, ref.canonicalUrl))] };
  } catch (err) {
    // The tab is a bonus beside uploads; when it is all that was asked for, it is the whole answer.
    if (wantsUploads) return uploads;
    throw err;
  }
}
