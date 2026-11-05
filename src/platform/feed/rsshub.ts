import { Coded, E } from '../errors.ts';
import { FEED_LIMIT, type Http } from '../http.ts';
import type { SourceRef } from '../registry.ts';
import { handleFeedStatus, parseFeed, type ParsedFeed } from './native.ts';

/**
 * Stage 2 via RSSHub (ADR-006). The URL is operator-configured, so no SSRF guard here.
 * A cold route scrapes the platform itself (Instagram 7 s, Threads 24 s measured), so it gets three
 * times the trusted-fetch default: at 20 s the bot aborted routes RSSHub then answered. The wait is
 * inline in one update handler, which is no worse than the 120 s a Download Mode link already holds
 * (callbacks.ts), and far under the worker's 10 min stale lock.
 * shortcut: one ceiling for every route; a namespace that needs longer gets its own constant.
 */
export async function fetchRsshubFeed(http: Http, ref: SourceRef): Promise<ParsedFeed> {
  if (!ref.feedUrl) throw new Coded(E.NO_FEED, 'rsshub route missing');
  const res = await http(ref.feedUrl, { maxBytes: FEED_LIMIT, timeoutMs: 60_000 });
  handleFeedStatus(res.status);
  return parseFeed(res.body, res.url);
}
