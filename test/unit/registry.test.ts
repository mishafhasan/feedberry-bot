import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Coded, E } from '../../src/platform/errors.ts';
import { classifyLink, detectSource, isSectionSource, isSectionUrl, isWebsitePage, linksIn, sectionOf } from '../../src/platform/registry.ts';

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
  assert.equal(detectSource('https://www.facebook.com/shammiltd', opts).feedUrl, 'http://rsshub.test/facebook/page/shammiltd', 'RSSHub serves a page under /facebook/page');

  // A post permalink names the post; the bare /posts tab is still the page.
  const permalink = detectSource('https://www.facebook.com/TrollMafia01/posts/pfbid02aYgKUGgf31rSVh7rAEb6gq9xopg3SUo6w2FTJVPowk69mQJUwt13s8dg1gLfJTQ9l', opts);
  assert.equal(permalink.strategy, 'single_post');
  assert.equal(permalink.externalId, 'pfbid02aYgKUGgf31rSVh7rAEb6gq9xopg3SUo6w2FTJVPowk69mQJUwt13s8dg1gLfJTQ9l');
  assert.equal(permalink.feedUrl, null);
  assert.equal(detectSource('https://www.facebook.com/TrollMafia01/posts/', opts).strategy, 'rsshub', 'the posts tab is a page');
  assert.equal(detectSource('https://www.facebook.com/TrollMafia01/reel/123456', opts).strategy, 'single_post', 'a page-scoped reel is a post');
  assert.equal(detectSource('https://www.facebook.com/share/r/16AbCdEf/', opts).strategy, 'single_post');
  assert.equal(detectSource('https://fb.watch/xY9zAbC12/', opts).strategy, 'single_post', 'the short host is a post too');
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
  assert.equal(detectSource('https://www.youtube.com/@MrBeast', opts).strategy, 'native_rss');
  // The handle page discovers its own RSS link, so no RSSHub key is needed and Shorts stay labelled.
  assert.equal(detectSource('https://www.youtube.com/@MrBeast', opts).feedUrl, null);
});

test('M17 classify: a profile is a source, a post is a post, per platform', () => {
  const source = { kind: 'source' };
  assert.deepEqual(classifyLink('https://www.instagram.com/cristiano/', opts), source);
  assert.deepEqual(classifyLink('https://www.youtube.com/@MrBeast', opts), source);
  assert.deepEqual(classifyLink('https://www.threads.net/t/Cabc', opts), { kind: 'post', profileUrl: null }, 'the short form names no owner');

  assert.deepEqual(classifyLink('https://www.instagram.com/p/C1/', opts), { kind: 'post', profileUrl: null }, 'a bare /p/ link names no owner');
  assert.deepEqual(classifyLink('https://www.instagram.com/cristiano/p/C1/', opts), { kind: 'post', profileUrl: 'https://instagram.com/cristiano' });
  assert.deepEqual(classifyLink('https://www.threads.net/@zuck/post/Cabc', opts), { kind: 'post', profileUrl: 'https://threads.com/@zuck' });
  assert.deepEqual(classifyLink('https://www.tiktok.com/@user/video/123', opts), { kind: 'post', profileUrl: 'https://tiktok.com/@user' });
  assert.deepEqual(classifyLink('https://www.facebook.com/shammiltd/videos/funny-clips/1159110793020936/', opts), { kind: 'post', profileUrl: 'https://facebook.com/shammiltd' });

  assert.deepEqual(classifyLink('https://youtu.be/dQw4w9WgXcQ', opts), { kind: 'post', profileUrl: null });
  assert.deepEqual(classifyLink('https://www.snapchat.com/t/abc123', opts), { kind: 'post', profileUrl: null }, 'snapchat has no feed to offer');
  assert.deepEqual(classifyLink('https://x.com/blue/status/123', opts), { kind: 'post', profileUrl: null }, 'an x profile needs tokens (ADR-017)');
});

test('M17 classify: the account behind a Facebook or Tumblr post is the one the URL names', () => {
  assert.deepEqual(classifyLink('https://www.facebook.com/shammiltd/videos/funny-clips/1159110793020936/', opts), { kind: 'post', profileUrl: 'https://facebook.com/shammiltd' });
  assert.deepEqual(classifyLink('https://www.facebook.com/TrollMafia01/posts/pfbid02aYgKUGgf31rSVh7rAEb6gq9xopg3SUo6w2FTJVPowk69mQJUwt13s8dg1gLfJTQ9l', opts), {
    kind: 'post',
    profileUrl: 'https://facebook.com/TrollMafia01',
  }, 'a post permalink names its page');
  assert.deepEqual(classifyLink('https://www.facebook.com/share/r/16AbCdEf/', opts), { kind: 'post', profileUrl: null }, 'no page named share');
  assert.deepEqual(classifyLink('https://fb.watch/xY9zAbC12/', opts), { kind: 'post', profileUrl: null }, 'the short host names no page');
  // /photo?fbid= names no page, but the album it was opened from does: set=pb.<pageId>.
  assert.deepEqual(classifyLink('https://web.facebook.com/photo/?fbid=1270547115300126&set=pb.100070345475708.-2207520000', opts), {
    kind: 'post',
    profileUrl: 'https://facebook.com/100070345475708',
  });
  assert.deepEqual(classifyLink('https://www.facebook.com/photo?fbid=1270547115300126', opts), { kind: 'post', profileUrl: null }, 'no page anywhere in the link');
  assert.deepEqual(classifyLink('https://www.facebook.com/watch/?v=123456', opts), { kind: 'post', profileUrl: null });
  assert.deepEqual(classifyLink('https://www.tumblr.com/mariacallous/832322209601224704?source=share', opts), { kind: 'post', profileUrl: 'https://mariacallous.tumblr.com' });
  assert.deepEqual(classifyLink('https://staff.tumblr.com/post/831491763581648896', opts), { kind: 'post', profileUrl: 'https://staff.tumblr.com' });
});

test('M17 classify: a website page is a post of its origin, a root or a feed is a source', () => {
  assert.deepEqual(classifyLink('https://blog.example.test/story/a-quiet-return', opts), { kind: 'post', profileUrl: 'https://blog.example.test' });
  assert.deepEqual(classifyLink('https://blog.example.test/', opts), { kind: 'source' });
  assert.deepEqual(classifyLink('https://feeds.bbci.co.uk/news/world/rss.xml', opts), { kind: 'source' });
});

test('M17 classify: an unusable link keeps its §11 code for every screen', () => {
  assert.throws(() => classifyLink('nonsense', opts), (err) => err instanceof Coded && err.code === E.LINK_INVALID);
  assert.throws(() => classifyLink('https://x.com/elonmusk', opts), (err) => err instanceof Coded && err.code === E.COOKIE_REQUIRED);
  assert.throws(() => classifyLink('https://www.snapchat.com/@someone', opts), (err) => err instanceof Coded && err.code === E.NO_FEED);
  assert.throws(() => classifyLink('https://www.pinterest.com/ideas/food/90809/', opts), (err) => err instanceof Coded && err.code === E.PROFILE_ONLY);
});

test('M18 registry: an X profile is a source only when RSSHub holds a Twitter token', () => {
  assert.equal(codeOf('https://x.com/elonmusk'), E.COOKIE_REQUIRED, 'no token: refused up front (ADR-017)');

  const ref = detectSource('https://twitter.com/QAiStudio', { ...opts, xProfiles: true });
  assert.equal(ref.platform, 'x');
  assert.equal(ref.canonicalUrl, 'https://x.com/QAiStudio');
  assert.equal(ref.feedUrl, 'http://rsshub.test/twitter/user/QAiStudio');
  assert.deepEqual(classifyLink('https://x.com/blue/status/123', { ...opts, xProfiles: true }), { kind: 'post', profileUrl: 'https://x.com/blue' });
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

test('M19 sections: a category URL is a source, an article stays a post', () => {
  const source = { kind: 'source' };
  assert.deepEqual(classifyLink('https://www.wired.com/category/science/', opts), source);
  assert.deepEqual(classifyLink('https://techcrunch.com/category/artificial-intelligence/', opts), source);
  assert.deepEqual(classifyLink('https://www.dailymirror.lk/top-stories/155', opts), source, 'a section id names a listing');

  assert.deepEqual(classifyLink('https://www.wired.com/story/a-quiet-return/', opts), { kind: 'post', profileUrl: 'https://wired.com' });
  assert.deepEqual(classifyLink('https://techcrunch.com/2026/11/06/a-post/', opts), { kind: 'post', profileUrl: 'https://techcrunch.com' });
  assert.deepEqual(classifyLink('https://blog.test/news/2026/11/06/a-post', opts), { kind: 'post', profileUrl: 'https://blog.test' }, 'a dated article is not a section id');
  assert.deepEqual(classifyLink('https://www.bbc.com/technology', opts), { kind: 'post', profileUrl: 'https://bbc.com' }, 'one segment is ambiguous: only its feed can tell');
});

test('M19 sections: the section cut keeps the listing and drops the page number', () => {
  assert.equal(sectionOf('https://www.wired.com/category/science/'), '/category/science');
  assert.equal(sectionOf('https://www.wired.com/category/science/page/2'), '/category/science');
  assert.equal(sectionOf('https://www.dailymirror.lk/top-stories/155'), '/top-stories/155');
  assert.equal(sectionOf('https://www.bbc.com/technology'), '/technology');

  assert.equal(sectionOf('https://www.wired.com/'), null, 'a site root is the whole site');
  assert.equal(sectionOf('https://feeds.bbci.co.uk/news/world/rss.xml'), null, 'a feed is already the source');
  assert.equal(sectionOf('https://www.instagram.com/cristiano'), null, 'a known platform is a profile');
});

test('M19 sections: only a marker or a section id is a listing on the URL alone', () => {
  assert.equal(isSectionUrl('/category/science'), true);
  assert.equal(isSectionUrl('/topics/ai'), true);
  assert.equal(isSectionUrl('/top-stories/155'), true);
  assert.equal(isSectionUrl('/news/1234'), true, 'two segments, a numeric id');
  assert.equal(isSectionUrl('/2026/11'), false, 'a month archive is not a section id');
  assert.equal(isSectionUrl('/news/55'), false, 'a two-digit tail is an article id, not a section');
  assert.equal(isSectionUrl('/news/2026/11/06/a-post'), false, 'a dated article only looks like an id');
  assert.equal(isSectionUrl('/technology'), false, 'an article slug looks the same');
  assert.equal(isSectionUrl('/2026/11/06/a-post'), false, 'a dated article is not a section id');

  assert.equal(isSectionSource(detectSource('https://www.wired.com/category/science/', opts)), true);
  assert.equal(isSectionSource(detectSource('https://www.wired.com/story/a-quiet-return/', opts)), false);
  assert.equal(isSectionSource(detectSource('https://www.instagram.com/cristiano', opts)), false);
});

test('M21 registry: a URL that names a feed is used as a feed, wherever the marker sits', () => {
  const ref = detectSource('https://www.dailymirror.lk/rss/breaking_news/108', opts);
  assert.equal(ref.feedUrl, 'https://dailymirror.lk/rss/breaking_news/108', 'the URL itself answers with RSS');
  assert.equal(isWebsitePage(ref), false, 'so it is never offered as a one-off article');
  assert.deepEqual(classifyLink('https://www.dailymirror.lk/rss/breaking_news/108', opts), { kind: 'source' });

  // The shapes that already worked keep working.
  assert.equal(detectSource('https://blog.example.test/rss', opts).feedUrl, 'https://blog.example.test/rss');
  assert.equal(detectSource('https://blog.example.test/feed.xml', opts).feedUrl, 'https://blog.example.test/feed.xml');
  // A page that merely starts with the word is still a page.
  assert.equal(detectSource('https://blog.example.test/feed-reader/review', opts).feedUrl, null);
});

test('M23 registry: a Substack publication is a source at /feed, whether a post or the root was pasted', () => {
  const root = detectSource('https://newsletter.example.substack.com/', opts);
  assert.equal(root.platform, 'rss');
  assert.equal(root.canonicalUrl, 'https://newsletter.example.substack.com');
  assert.equal(root.feedUrl, 'https://newsletter.example.substack.com/feed', 'the one path every Substack answers');
  assert.equal(root.strategy, 'native_rss');
  assert.equal(isWebsitePage(root), false, 'so the add flow never offers a download instead');

  const post = detectSource('https://newsletter.example.substack.com/p/nvidia-ceo-admits-affair', opts);
  assert.equal(post.canonicalUrl, 'https://newsletter.example.substack.com', 'a post link names its publication');
  assert.deepEqual(classifyLink('https://newsletter.example.substack.com/p/nvidia-ceo-admits-affair', opts), { kind: 'source' });
});

test('M26 registry: a message is searched for its links before anything classifies it', () => {
  assert.deepEqual(linksIn('look at this https://x.com/blue/status/123, nice'), ['https://x.com/blue/status/123'], 'the words around the URL are not the URL');
  assert.deepEqual(linksIn('(https://instagram.com/p/C1/)'), ['https://instagram.com/p/C1/'], 'a bracket the text opened is not part of the code');
  assert.deepEqual(linksIn('https://en.wikipedia.org/wiki/Foo_(bar)'), ['https://en.wikipedia.org/wiki/Foo_(bar)'], 'a bracket the URL opened stays');
  assert.deepEqual(linksIn('https://a.test/x! And https://b.test/y.'), ['https://a.test/x', 'https://b.test/y'], 'two links, sentence punctuation dropped');
  assert.deepEqual(linksIn('https://a.test/x and https://a.test/x'), ['https://a.test/x'], 'the same link twice is one');
  assert.deepEqual(linksIn('see www.instagram.com/cristiano'), ['https://www.instagram.com/cristiano'], 'a www host becomes a URL');
  assert.deepEqual(linksIn('«https://instagram.com/cristiano»'), ['https://instagram.com/cristiano'], 'a locale quote is the sentence\'s');
  assert.deepEqual(linksIn('देखो https://www.instagram.com/cristiano।'), ['https://www.instagram.com/cristiano'], 'the danda ends the sentence, not the URL');
  assert.deepEqual(linksIn('hello, how are you?'), [], 'ordinary text carries no link');
  assert.deepEqual(linksIn('ftp://files.test/a https://ok.test/b'), ['https://ok.test/b'], 'only http(s) is a link here');
});
