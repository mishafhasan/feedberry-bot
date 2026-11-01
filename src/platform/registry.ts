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
      // §10 row D + ADR-017: no instance tokens are stored, so a profile add is refused up front.
      throw new Coded(E.COOKIE_REQUIRED, 'x.com needs instance OAuth tokens (ADR-017)');
    }
    case 'tiktok': {
      if (seg[1] === 'video' || seg[0] === 't') return single(u, platform, seg[2] ?? seg[0] ?? '');
      return profile(platform, `https://tiktok.com/@${user(seg[0])}`, user(seg[0]), rsshub(opts, `/tiktok/user/${user(seg[0])}`));
    }
    case 'threads': {
      if (seg[1] === 'post' || seg[0] === 't') return single(u, 'threads', seg[2] ?? seg[0] ?? '');
      // OQ-4: both hosts accepted, canonical is threads.com, RSSHub gets the bare username.
      return profile('threads', `https://threads.com/@${user(seg[0])}`, user(seg[0]), rsshub(opts, `/threads/${user(seg[0])}`));
    }
    case 'tumblr': {
      if (seg[0] === 'post') return single(u, platform, seg[1] ?? '');
      const blog = normalizeHost(u.hostname);
      return profile(platform, `https://${blog}`, blog, `https://${blog}/rss`, 'native_rss');
    }
    case 'pinterest': {
      const [first, second] = seg;
      if (first === 'ideas' || first === 'search') throw new Coded(E.PROFILE_ONLY, 'browse page');
      if (first === 'pin' || normalizeHost(u.hostname) === 'pin.it') return single(u, platform, second ?? first ?? '');
      const name = user(first);
      return profile(platform, `https://pinterest.com/${name}`, name, rsshub(opts, `/pinterest/user/${name}`));
    }
    case 'facebook': {
      const [first, second] = seg;
      if (first === 'videos' || first === 'reel' || first === 'watch' || first === 'photo') return single(u, platform, second ?? '');
      return profile(platform, `https://facebook.com/${user(first)}`, user(first), rsshub(opts, `/facebook/${user(first)}`));
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
      const handle = user(second ?? first);
      return profile(platform, `https://youtube.com/@${handle}`, handle, rsshub(opts, `/youtube/user/${handle}`));
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
      const [first, second] = seg;
      if (first === 'spotlight' || first === 't') return single(u, platform, second ?? '');
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
    case 'facebook':
      return owner ? `https://facebook.com/${owner}` : null;
    case 'bluesky':
      return seg[1] ? `https://bsky.app/profile/${seg[1]}` : null;
    case 'youtube':
      return seg[0]?.startsWith('@') ? `https://youtube.com/@${owner}` : null;
    case 'tumblr':
      return `https://${normalizeHost(u.hostname)}`;
    case 'rss':
      // A website page belongs to the site itself, which is what a subscription follows.
      return `${u.protocol}//${normalizeHost(u.hostname)}`;
    default:
      return null;
  }
}

/** A display name is not a handle: YouTube's artist is the channel title, not an @name. */
const HANDLE = /^[A-Za-z0-9._-]{1,30}$/;

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
      // x needs instance tokens (ADR-017), so offering it would only fail later.
      return null;
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

function profile(platform: Platform, canonicalUrl: string, externalId: string, feedUrl: string, strategy: Strategy = 'rsshub'): SourceRef {
  return { platform, canonicalUrl, externalId, feedUrl, strategy };
}

function single(u: URL, platform: Platform, externalId: string): SourceRef {
  const path = u.pathname.replace(/\/+$/, '');
  return { platform, canonicalUrl: `https://${normalizeHost(u.hostname)}${path}`, externalId, feedUrl: null, strategy: 'single_post' };
}

/** A plain website: use it as a feed if it looks like one, otherwise discover (stage 2). */
function genericWebsite(u: URL): SourceRef {
  const path = u.pathname.replace(/\/+$/, '') || '/';
  const looksLikeFeed = /(\.(xml|rss|atom)|feed|rss)(\/)?$/i.test(u.pathname);
  const href = `${u.protocol}//${normalizeHost(u.hostname)}${path === '/' ? '' : path}${u.search}`;
  return { platform: 'rss', canonicalUrl: href, externalId: u.hostname, feedUrl: looksLikeFeed ? href : null, strategy: 'native_rss' };
}

const rsshub = (opts: DetectOptions, route: string): string => `${opts.rsshubBase}${route}`;

const user = (segment: string | undefined): string => (segment ?? '').replace(/^@/, '');
