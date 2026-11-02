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

test('M12 registry: page-scoped Facebook videos, photos and watch links are posts', () => {
  const video = detectSource('https://www.facebook.com/shammiltd/videos/funny-clips/1159110793020936/', opts);
  assert.equal(video.strategy, 'single_post');
  assert.equal(video.canonicalUrl, 'https://facebook.com/shammiltd/videos/funny-clips/1159110793020936');

  const photo = detectSource('https://web.facebook.com/photo/?fbid=1270547115300126&set=pb.100070345475708.-2207520000', opts);
  assert.equal(photo.platform, 'facebook', 'web. is the same host');
  assert.equal(photo.strategy, 'single_post');
  assert.equal(photo.canonicalUrl, 'https://facebook.com/photo?fbid=1270547115300126', 'fbid survives');

  const watch = detectSource('https://www.facebook.com/watch/?v=123456', opts);
  assert.equal(watch.strategy, 'single_post');
  assert.equal(watch.canonicalUrl, 'https://facebook.com/watch?v=123456');

  assert.equal(detectSource('https://www.facebook.com/shammiltd', opts).strategy, 'rsshub', 'a page is still a profile');
});

test('M12 registry: Snapchat spotlight share links and Tumblr post links are posts', () => {
  const snap = detectSource('https://www.snapchat.com/@klipz96/spotlight/W7_EDlXWTBiXAEEniNoMPwAAYc3ZwZXdmdHdmAZGAhOJfAZGAhNupAAAAAQ', opts);
  assert.equal(snap.platform, 'snapchat');
  assert.equal(snap.strategy, 'single_post');
  assert.equal(snap.externalId, 'W7_EDlXWTBiXAEEniNoMPwAAYc3ZwZXdmdHdmAZGAhOJfAZGAhNupAAAAAQ');

  const post = detectSource('https://www.tumblr.com/pangur-and-grim/831491763581648896/look-at-my-genius-puppy?source=share', opts);
  assert.equal(post.platform, 'tumblr');
  assert.equal(post.strategy, 'single_post');
  assert.equal(post.canonicalUrl, 'https://pangur-and-grim.tumblr.com/post/831491763581648896', 'the blog host is what cobalt resolves');

  const blog = detectSource('https://www.tumblr.com/pangur-and-grim', opts);
  assert.equal(blog.strategy, 'native_rss');
  assert.equal(blog.canonicalUrl, 'https://pangur-and-grim.tumblr.com');
  assert.equal(blog.feedUrl, 'https://pangur-and-grim.tumblr.com/rss');
});

test('M17 registry: a YouTube community post is a single post, never a channel handle', () => {
  const post = detectSource('https://www.youtube.com/post/UgkxGuBM_v4CJugE7V-Dns33VhSMVB0_UL_F', opts);
  assert.equal(post.platform, 'youtube');
  assert.equal(post.strategy, 'single_post');
  assert.equal(post.canonicalUrl, 'https://youtube.com/post/UgkxGuBM_v4CJugE7V-Dns33VhSMVB0_UL_F');
  assert.equal(post.externalId, 'UgkxGuBM_v4CJugE7V-Dns33VhSMVB0_UL_F');
  assert.equal(post.feedUrl, null);

  assert.equal(detectSource('https://m.youtube.com/post/UgkxX', opts).strategy, 'single_post', 'the mobile host is the same host');
  assert.equal(codeOf('https://www.youtube.com/post/'), E.LINK_INVALID, 'a post without an id cannot be fetched');
  // A channel is still a feed: the post case must not swallow it.
  assert.equal(detectSource('https://www.youtube.com/@MrBeast', opts).strategy, 'rsshub');
});

test('M13 registry: every TikTok post shape and share host is a single post', () => {
  assert.equal(detectSource('https://www.tiktok.com/@user/video/123', opts).strategy, 'single_post');
  assert.equal(detectSource('https://www.tiktok.com/@user/photo/123', opts).strategy, 'single_post', 'carousel posts');

  const short = detectSource('https://www.tiktok.com/t/ZP8abc123/', opts);
  assert.equal(short.strategy, 'single_post');
  assert.equal(short.externalId, 'ZP8abc123');

  for (const link of ['https://vm.tiktok.com/ZMabc123/', 'https://vt.tiktok.com/ZSabc123/', 'https://t.tiktok.com/ZTPabc/']) {
    const ref = detectSource(link, opts);
    assert.equal(ref.platform, 'tiktok', link);
    assert.equal(ref.strategy, 'single_post', link);
  }

  const legacy = detectSource('https://m.tiktok.com/v/123.html', opts);
  assert.equal(legacy.strategy, 'single_post');
  assert.equal(legacy.canonicalUrl, 'https://tiktok.com/v/123.html', 'the .html suffix stays: cobalt matches it');

  assert.equal(detectSource('https://www.tiktok.com/@user', opts).strategy, 'rsshub', 'a profile is still a feed');
});
