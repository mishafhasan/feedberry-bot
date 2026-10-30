import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Coded, E } from '../../src/platform/errors.ts';
import { detectSource } from '../../src/platform/registry.ts';

const opts = { rsshubBase: 'http://rsshub.test', telegramBeta: false };

function codeOf(link: string): string {
  try {
    detectSource(link, opts);
    return 'no-throw';
  } catch (err) {
    return err instanceof Coded ? err.code : `other: ${String(err)}`;
  }
}

test('M2 registry: Instagram profile normalizes and routes through RSSHub', () => {
  const ref = detectSource('https://www.instagram.com/cristiano/', opts);
  assert.equal(ref.platform, 'instagram');
  assert.equal(ref.canonicalUrl, 'https://instagram.com/cristiano');
  assert.equal(ref.feedUrl, 'http://rsshub.test/instagram/user/cristiano');
  assert.equal(ref.strategy, 'rsshub');
  assert.equal(detectSource('https://instagram.com/p/C1xYz/', opts).strategy, 'single_post');
});

test('M2 registry: Threads accepts both hosts, canonical is threads.com, RSSHub gets the bare user (OQ-4)', () => {
  const net = detectSource('https://www.threads.net/@zuck', opts);
  const com = detectSource('https://threads.com/@zuck', opts);
  assert.equal(net.canonicalUrl, 'https://threads.com/@zuck');
  assert.equal(com.canonicalUrl, net.canonicalUrl);
  assert.equal(net.feedUrl, 'http://rsshub.test/threads/zuck', 'no @ in the route');
  assert.equal(detectSource('https://www.threads.net/@zuck/post/Cabc', opts).strategy, 'single_post');
});

test('M2 registry: browse-only and login-only links fail with the §11 codes', () => {
  assert.equal(codeOf('https://www.pinterest.com/ideas/food/90809/'), E.PROFILE_ONLY);
  assert.equal(codeOf('https://www.pinterest.com/search/pins/?q=cats'), E.PROFILE_ONLY);
  assert.equal(codeOf('https://x.com/elonmusk'), E.COOKIE_REQUIRED, 'ADR-017: no instance tokens');
  assert.equal(codeOf('https://www.snapchat.com/@someone'), E.NO_FEED, 'OQ-1: profiles have no feed');
  assert.equal(detectSource('https://www.snapchat.com/t/abc123', opts).strategy, 'single_post', 'a spotlight/story link is a post');
  assert.equal(codeOf('nonsense'), E.LINK_INVALID);
  assert.equal(codeOf('ftp://example.com/feed'), E.LINK_INVALID);
  assert.equal(codeOf('https://t.me/telegram'), E.NO_FEED, 'OQ-3: beta off');
});

test('M2 registry: feeds that need no helper are native', () => {
  const yt = detectSource('https://www.youtube.com/channel/UC123', opts);
  assert.equal(yt.strategy, 'native_rss');
  assert.equal(yt.feedUrl, 'https://www.youtube.com/feeds/videos.xml?channel_id=UC123');

  const tumblr = detectSource('https://staff.tumblr.com/', opts);
  assert.equal(tumblr.platform, 'tumblr');
  assert.equal(tumblr.strategy, 'native_rss');
  assert.equal(tumblr.feedUrl, 'https://staff.tumblr.com/rss');

  const bsky = detectSource('https://bsky.app/profile/bsky.app', opts);
  assert.equal(bsky.strategy, 'bluesky_api');
  assert.match(bsky.feedUrl ?? '', /getAuthorFeed\?actor=bsky\.app/);

  assert.equal(detectSource('https://youtu.be/dQw4w9WgXcQ', opts).strategy, 'single_post');
  assert.equal(detectSource('https://www.tiktok.com/@user/video/123', opts).strategy, 'single_post');
});

test('M2 registry: a plain website is discovered, an obvious feed is used as-is', () => {
  const site = detectSource('https://example.com/blog/', opts);
  assert.equal(site.platform, 'rss');
  assert.equal(site.strategy, 'native_rss');
  assert.equal(site.feedUrl, null, 'stage 2 must discover it');
  assert.equal(site.canonicalUrl, 'https://example.com/blog');

  const feed = detectSource('https://feeds.bbci.co.uk/news/world/rss.xml', opts);
  assert.equal(feed.feedUrl, 'https://feeds.bbci.co.uk/news/world/rss.xml');
});

test('M2 registry: Telegram is opt-in', () => {
  const ref = detectSource('https://t.me/durov', { ...opts, telegramBeta: true });
  assert.equal(ref.platform, 'telegram');
  assert.equal(ref.feedUrl, 'http://rsshub.test/telegram/channel/durov');
});
