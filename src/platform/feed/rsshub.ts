import { Coded, E } from '../errors.ts';
import { FEED_LIMIT, type Http } from '../http.ts';
import type { SourceRef } from '../registry.ts';
import { handleFeedStatus, parseFeed, type ParsedFeed } from './native.ts';

/** Stage 2 via RSSHub (ADR-006). The URL is operator-configured, so no SSRF guard here. */
export async function fetchRsshubFeed(http: Http, ref: SourceRef): Promise<ParsedFeed> {
  if (!ref.feedUrl) throw new Coded(E.NO_FEED, 'rsshub route missing');
  const res = await http(ref.feedUrl, { maxBytes: FEED_LIMIT });
  handleFeedStatus(res.status);
  return parseFeed(res.body, res.url);
}
