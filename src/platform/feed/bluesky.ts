import { Coded, E } from '../errors.ts';
import { FEED_LIMIT, type Http } from '../http.ts';
import type { SourceRef } from '../registry.ts';
import { handleFeedStatus, type FeedItem, type ParsedFeed } from './native.ts';

/** app.bsky.feed.getAuthorFeed response, trimmed to what we read. */
interface AuthorFeed {
  feed?: Array<{
    post?: {
      uri?: string;
      author?: { handle?: string; avatar?: string };
      record?: { text?: string; createdAt?: string };
      embed?: { images?: Array<{ fullsize?: string }> };
    };
  }>;
}

/** Stage 2 for `bluesky_api`: public AppView, no key, no RSSHub (§5.3, [BSKY-API]). */
export async function fetchBlueskyFeed(http: Http, ref: SourceRef): Promise<ParsedFeed> {
  if (!ref.feedUrl) throw new Coded(E.NO_FEED, 'bluesky actor missing');
  const res = await http(ref.feedUrl, { maxBytes: FEED_LIMIT });
  handleFeedStatus(res.status);

  let feed: AuthorFeed;
  try {
    feed = JSON.parse(res.body) as AuthorFeed;
  } catch {
    throw new Coded(E.FEED_DOWN, 'bluesky returned non-json');
  }

  const posts = feed.feed ?? [];
  const items: FeedItem[] = [];
  for (const entry of posts) {
    const post = entry.post;
    if (!post?.uri) continue;
    const handle = post.author?.handle ?? ref.externalId;
    const rkey = post.uri.split('/').pop() ?? '';
    const body = post.record?.text ?? '';
    items.push({
      guid: post.uri,
      link: `https://bsky.app/profile/${handle}/post/${rkey}`,
      title: body.split('\n')[0]?.slice(0, 120) || post.uri,
      publishedAt: post.record?.createdAt ? Date.parse(post.record.createdAt) : null,
      summary: body ? body.slice(0, 400) : null,
      media: (post.embed?.images ?? []).flatMap((image) => (image.fullsize ? [{ url: image.fullsize, type: 'photo' as const }] : [])),
    });
  }
  if (items.length === 0) throw new Coded(E.NO_FEED, 'bluesky feed is empty');

  const first = posts[0]?.post;
  return { title: first?.author?.handle ?? ref.externalId, avatarUrl: first?.author?.avatar ?? null, items };
}
