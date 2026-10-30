import { Coded, E } from '../platform/errors.ts';
import { fetchBlueskyFeed } from '../platform/feed/bluesky.ts';
import { fetchNativeFeed, type ParsedFeed } from '../platform/feed/native.ts';
import { fetchRsshubFeed } from '../platform/feed/rsshub.ts';
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
