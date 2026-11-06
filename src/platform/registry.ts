import { platformForHost, normalizeHost } from './allowlist.ts';
import { Coded, E } from './errors.ts';

export type Platform =
  | 'rss'
  | 'instagram'
  | 'x'
  | 'tiktok'
  | 'threads'
  | 'tumblr'
  | 'pinterest'
  | 'facebook'
  | 'youtube'
  | 'bluesky'
  | 'telegram'
  | 'snapchat';

/** ARCHITECTURE §5.3: how stage 2 gets the feed. */
export type Strategy = 'native_rss' | 'rsshub' | 'bluesky_api' | 'single_post';

export interface SourceRef {
  platform: Platform;
  /** Normalized profile (or post) URL. Never includes a trailing slash or `www.`. */
  canonicalUrl: string;
  externalId: string;
  /** Stage-2 URL; null for `native_rss` means "discover it from the page". */
  feedUrl: string | null;
  strategy: Strategy;
}

export interface DetectOptions {
  rsshubBase: string;
  telegramBeta: boolean;
  /** RSSHub has a Twitter token, so an x.com profile has a route to follow. */
  xProfiles?: boolean;
}

/**
 * Stage 1 (ARCHITECTURE §5.1): link → SourceRef, or a Coded error from §11.
 * Pure: no network. A post link yields `single_post`, which the add-source flow refuses until
 * Download Mode exists (M5).
 */
export function detectSource(link: string, opts: DetectOptions): SourceRef {
  const u = parse(link);
  const platform = platformForHost(normalizeHost(u.hostname));
  const seg = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);

  if (platform === undefined) return genericWebsite(u);

  switch (platform) {
    case 'instagram': {
      const [first, second] = seg;
      if (first === 'p' || first === 'reel' || first === 'tv') return single(u, platform, second ?? '');
      // A web share link spells the owner out: instagram.com/<user>/p/<code>.
      if (second === 'p' || second === 'reel' || second === 'tv') return single(u, platform, seg[2] ?? '');
      if (first === 'stories') throw new Coded(E.COOKIE_REQUIRED, 'stories need a session (ADR-017)');
      return profile(platform, `https://instagram.com/${user(first)}`, user(first), rsshub(opts, `/instagram/user/${user(first)}`));
    }
    case 'x': {
      if (seg[1] === 'status') return single(u, platform, seg[2] ?? '');
      // §10 row D + ADR-017: without an instance token a profile add is refused up front.
      if (!opts.xProfiles) throw new Coded(E.COOKIE_REQUIRED, 'x.com needs instance OAuth tokens (ADR-017)');
      return profile(platform, `https://x.com/${user(seg[0])}`, user(seg[0]), rsshub(opts, `/twitter/user/${user(seg[0])}`));
    }
    case 'tiktok': {
      const [first, second, third] = seg;
      // /@user/video/<id>, /@user/photo/<id> (carousel), /v/<id>.html (legacy).
      if (second === 'video' || second === 'photo') return single(u, platform, third ?? '');
      if (first === 'v' && second) return single(u, platform, second.replace(/\.html$/, ''));
      // Share links: /t/<code> and the vm./vt. hosts, where the code is the only segment.
      if (first === 't' && second) return single(u, platform, second);
      if (first && !first.startsWith('@') && !second) return single(u, platform, first);
      return profile(platform, `https://tiktok.com/@${user(first)}`, user(first), rsshub(opts, `/tiktok/user/${user(first)}`));
    }
    case 'threads': {
      // `/t/<code>` is the short form: the code is the first segment, not the second.
      if (seg[1] === 'post' || seg[0] === 't') return single(u, 'threads', (seg[1] === 'post' ? seg[2] : seg[1]) ?? '');
      // OQ-4: both hosts accepted, canonical is threads.com, RSSHub gets the bare username.
      return profile('threads', `https://threads.com/@${user(seg[0])}`, user(seg[0]), rsshub(opts, `/threads/${user(seg[0])}`));
    }
    case 'tumblr': {
      if (seg[0] === 'post') return single(u, platform, seg[1] ?? '');
      const host = normalizeHost(u.hostname);
      // Modern post links live on the bare host: tumblr.com/<blog>/<id>/<slug>.
      if (host === 'tumblr.com') {
        const [blog, id] = seg;
        if (!blog) throw new Coded(E.LINK_INVALID, 'blog missing');
        if (id && /^\d+$/.test(id)) return single(u, platform, id, `https://${blog}.tumblr.com/post/${id}`);
        return profile(platform, `https://${blog}.tumblr.com`, blog, `https://${blog}.tumblr.com/rss`, 'native_rss');
      }
      return profile(platform, `https://${host}`, host, `https://${host}/rss`, 'native_rss');
    }
    case 'pinterest': {
      const [first, second] = seg;
      if (first === 'ideas' || first === 'search') throw new Coded(E.PROFILE_ONLY, 'browse page');
      if (first === 'pin' || normalizeHost(u.hostname) === 'pin.it') return single(u, platform, second ?? first ?? '');
      const name = user(first);
      return profile(platform, `https://pinterest.com/${name}`, name, rsshub(opts, `/pinterest/user/${name}`));
    }
    case 'facebook': {
      const [first, second, third, fourth] = seg;
      // /photo?fbid=<id> keeps its query: cobalt matches `photo?fbid=:id`.
      if (first === 'photo' || first === 'photo.php') {
        const fbid = u.searchParams.get('fbid');
        if (!fbid) throw new Coded(E.LINK_INVALID, 'photo without fbid');
        return single(u, platform, fbid, `https://facebook.com/photo?fbid=${fbid}`);
      }
      // /watch?v=<id>: cobalt rewrites the query to a video URL itself.
      if (first === 'watch') {
        const v = u.searchParams.get('v');
        if (!v) throw new Coded(E.LINK_INVALID, 'watch without v');
        return single(u, platform, v, `https://facebook.com/watch?v=${v}`);
      }
      if (first === 'videos' || first === 'reel' || first === 'reels') return single(u, platform, second ?? '');
      // A post permalink: /<page>/posts/<id>. The bare /posts tab is still the page.
      if (second === 'posts' && third) return single(u, platform, third);
      // The shape Facebook's own share sheet emits; the bare /reel/<id> case is above.
      if (second === 'reel' && third) return single(u, platform, third);
      // /share/p|r|v/<code> and fb.watch/<code> both match cobalt's short-link patterns.
      if (first === 'share' && second && third) return single(u, platform, third);
      if (normalizeHost(u.hostname) === 'fb.watch' && first) return single(u, platform, first);
      // A page-scoped video: /<user>/videos/<slug>/<id> or /<user>/videos/<id>.
      if (second === 'videos') {
        const id = fourth || third || '';
        if (id === '') throw new Coded(E.LINK_INVALID, 'video without id');
        return single(u, platform, id);
      }
      if (second === 'reels' && third) return single(u, platform, third);
      return profile(platform, `https://facebook.com/${user(first)}`, user(first), rsshub(opts, `/facebook/page/${user(first)}`));
    }
    case 'youtube': {
      const [first, second] = seg;
      if (normalizeHost(u.hostname) === 'youtu.be') return single(u, platform, first ?? '');
      if (first === 'shorts' || first === 'live' || first === 'watch') {
        return single(u, platform, first === 'watch' ? (u.searchParams.get('v') ?? '') : (second ?? ''));
      }
      if (first === 'channel') {
        const id = second ?? '';
        // Native channel feed: no key, no RSSHub (§10).
        return profile(platform, `https://youtube.com/channel/${id}`, id, `https://www.youtube.com/feeds/videos.xml?channel_id=${id}`, 'native_rss');
      }
      // A community post: the page itself carries it, so Download Mode fetches it directly.
      if (first === 'post') {
        if (!second) throw new Coded(E.LINK_INVALID, 'post without id');
        return single(u, platform, second);
      }
      const handle = user(second ?? first);
      // A handle is a channel page: its own RSS link is discovered from that page (no RSSHub key),
      // and only that feed labels Shorts apart from videos.
      return profile(platform, `https://youtube.com/@${handle}`, handle, null, 'native_rss');
    }
    case 'bluesky': {
      const [first, second, third, fourth] = seg;
      if (first !== 'profile' || !second) throw new Coded(E.LINK_INVALID, 'not a profile url');
      if (third === 'post' && fourth) return single(u, platform, fourth);
      const actor = decodeURIComponent(second);
      const feedUrl = `https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=${encodeURIComponent(actor)}&limit=20`;
      return profile(platform, `https://bsky.app/profile/${actor}`, actor, feedUrl, 'bluesky_api');
    }
    case 'telegram': {
      if (!opts.telegramBeta) throw new Coded(E.NO_FEED, 'telegram beta is off (OQ-3)');
      const channel = seg[0] === 's' ? seg[1] : seg[0];
      if (!channel) throw new Coded(E.LINK_INVALID, 'not a channel url');
      return profile(platform, `https://t.me/${channel}`, channel, rsshub(opts, `/telegram/channel/${channel}`));
    }
    case 'snapchat': {
      const [first, second, third] = seg;
      if (first === 'spotlight' || first === 't') return single(u, platform, second ?? '');
      // The apps share /@user/spotlight/<id>, and o/<id> is the old spotlight form.
      if (first?.startsWith('@') && second === 'spotlight') return single(u, platform, third ?? '');
      if (first === 'o' && second) return single(u, platform, second);
      // OQ-1: no profile feed exists; single links only.
      throw new Coded(E.NO_FEED, 'snapchat has no profile feed');
    }
  }

  throw new Coded(E.LINK_INVALID, `unhandled platform ${platform as string}`);
}

/**
 * The account a post link belongs to, when the URL spells it out. Instagram short links, YouTube
 * watch URLs and Pinterest pins do not, so they return null and only Download Mode is offered.
 */
export function profileOfPost(link: string): string | null {
  let u: URL;
  try {
    u = parse(link);
  } catch {
    return null;
  }
  const platform = platformForHost(normalizeHost(u.hostname));
  const seg = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const owner = seg[0] ? user(seg[0]) : '';

  switch (platform) {
    case undefined:
      // No known platform means a plain website, and a site follows from its origin.
      return `${u.protocol}//${normalizeHost(u.hostname)}`;
    case 'x':
      return seg[1] === 'status' && owner ? `https://x.com/${owner}` : null;
    case 'threads':
      return seg[1] === 'post' && owner ? `https://threads.com/@${owner}` : null;
    case 'tiktok':
      return seg[0]?.startsWith('@') ? `https://tiktok.com/@${owner}` : null;
    case 'instagram':
      // A bare /p/<code> link does not name its owner; instagram.com/<user>/p/<code> does.
      return seg[0] === 'p' || seg[0] === 'reel' || seg[0] === 'tv' || !seg[0] ? null : `https://instagram.com/${owner}`;
    case 'facebook': {
      // fb.watch/<code> names no page at all.
      if (normalizeHost(u.hostname) === 'fb.watch') return null;
      // /photo?fbid=… and /watch?v=… name the post, not its page; `set=pb.<pageId>…` is what names it.
      const pageId = /^pb\.(\d+)\./.exec(u.searchParams.get('set') ?? '')?.[1];
      if (pageId !== undefined) return `https://facebook.com/${pageId}`;
      return seg[0] === undefined || FACEBOOK_POST_PATHS.has(seg[0]) ? null : `https://facebook.com/${owner}`;
    }
    case 'bluesky':
      return seg[1] ? `https://bsky.app/profile/${seg[1]}` : null;
    case 'youtube':
      return seg[0]?.startsWith('@') ? `https://youtube.com/@${owner}` : null;
    case 'tumblr': {
      // tumblr.com/<blog>/<id> names the blog a post belongs to; the bare host is nobody's source.
      const host = normalizeHost(u.hostname);
      return host === 'tumblr.com' && seg[1] !== undefined && /^\d+$/.test(seg[1]) ? `https://${owner}.tumblr.com` : `https://${host}`;
    }
    case 'rss':
      // A website page belongs to the site itself, which is what a subscription follows.
      return `${u.protocol}//${normalizeHost(u.hostname)}`;
    default:
      return null;
  }
}

/** A display name is not a handle: YouTube's artist is the channel title, not an @name. */
const HANDLE = /^[A-Za-z0-9._-]{1,30}$/;

/** Facebook path segments that name a post rather than the page that posted it. */
const FACEBOOK_POST_PATHS = new Set(['photo', 'photo.php', 'watch', 'videos', 'reel', 'reels', 'share', 'story.php']);

/** The profile URL for an author a download named, when that platform has profile feeds. */
export function profileFromAuthor(platform: Platform, author: string): string | null {
  const name = author.replace(/^@/, '').trim();
  if (!HANDLE.test(name)) return null;
  switch (platform) {
    case 'instagram':
      return `https://instagram.com/${name}`;
    case 'threads':
      return `https://threads.com/@${name}`;
    case 'tiktok':
      return `https://tiktok.com/@${name}`;
    // youtube is missing on purpose: its artist is the channel title, not a handle.
    case 'bluesky':
      return `https://bsky.app/profile/${name}`;
    default:
      // X names no author in cobalt's metadata and needs instance tokens (ADR-017).
      return null;
  }
}

/** What a pasted link is, for every screen that has to tell a post from a source. */
export type LinkMatch = { kind: 'source' } | { kind: 'post'; profileUrl: string | null };

/**
 * One answer for every entry point (free text, Download Mode, Add Source): a source to follow, or a
 * single post. Throws the §11 `Coded` error for a link no flow can use.
 * `profileUrl` is only set when the add flow would accept it — x needs tokens, snapchat has no feed.
 */
export function classifyLink(link: string, opts: DetectOptions): LinkMatch {
  const ref = detectSource(link, opts);
  if (ref.strategy !== 'single_post' && !isWebsitePage(ref)) return { kind: 'source' };
  const profileUrl = profileOfPost(link);
  return { kind: 'post', profileUrl: profileUrl !== null && addable(profileUrl, opts) ? profileUrl : null };
}

function addable(profileUrl: string, opts: DetectOptions): boolean {
  try {
    const ref = detectSource(profileUrl, opts);
    return ref.strategy !== 'single_post' && !isWebsitePage(ref);
  } catch {
    return false;
  }
}

/**
 * A bare website with no feed hint and a real path is one article, not a site to follow: it can be
 * downloaded once, and its origin is what a subscription would follow instead.
 */
export function isWebsitePage(ref: SourceRef): boolean {
  if (ref.platform !== 'rss' || ref.feedUrl !== null) return false;
  try {
    return new URL(ref.canonicalUrl).pathname.replace(/\/+$/, '') !== '';
  } catch {
    return false;
  }
}

function parse(link: string): URL {
  let u: URL;
  try {
    u = new URL(link.trim());
  } catch {
    throw new Coded(E.LINK_INVALID, 'unparseable url');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Coded(E.LINK_INVALID, `scheme ${u.protocol}`);
  if (u.username || u.password) throw new Coded(E.LINK_INVALID, 'credentials in url');
  return u;
}

function profile(platform: Platform, canonicalUrl: string, externalId: string, feedUrl: string | null, strategy: Strategy = 'rsshub'): SourceRef {
  return { platform, canonicalUrl, externalId, feedUrl, strategy };
}

function single(u: URL, platform: Platform, externalId: string, canonicalUrl?: string): SourceRef {
  const path = u.pathname.replace(/\/+$/, '');
  return { platform, canonicalUrl: canonicalUrl ?? `https://${normalizeHost(u.hostname)}${path}`, externalId, feedUrl: null, strategy: 'single_post' };
}

/** A plain website: use it as a feed if it looks like one, otherwise discover (stage 2). */
function genericWebsite(u: URL): SourceRef {
  const path = u.pathname.replace(/\/+$/, '') || '/';
  const looksLikeFeed = /(\.(xml|rss|atom)|feed|rss)(\/)?$/i.test(u.pathname);
  const href = `${u.protocol}//${normalizeHost(u.hostname)}${path === '/' ? '' : path}${u.search}`;
  return { platform: 'rss', canonicalUrl: href, externalId: u.hostname, feedUrl: looksLikeFeed ? href : null, strategy: 'native_rss' };
}

const rsshub = (opts: DetectOptions, route: string): string => `${opts.rsshubBase}${route}`;

/**
 * The RSSHub YouTube route for a channel, for the window when YouTube closes the native feed to a
 * busy IP. It scrapes the channel pages instead, so it still answers; null when the ref names no
 * channel (a post link, another platform). A feed URL already carries the channel id, which keeps
 * the route stable across handle renames; otherwise a handle keeps its `@` (without it RSSHub looks
 * up a legacy vanity name and answers 503).
 */
export function youtubeRsshubRoute(ref: SourceRef, rsshubBase: string): string | null {
  if (ref.platform !== 'youtube') return null;
  const id = /channel_id=(UC[\w-]{22})/.exec(ref.feedUrl ?? '')?.[1] ?? (ref.externalId.startsWith('UC') ? ref.externalId : null);
  if (id !== null) return `${rsshubBase}/youtube/channel/${id}`;
  return ref.externalId === '' ? null : `${rsshubBase}/youtube/user/@${ref.externalId}`;
}

const user = (segment: string | undefined): string => (segment ?? '').replace(/^@/, '');
