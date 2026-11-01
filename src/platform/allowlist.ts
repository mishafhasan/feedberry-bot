import type { Platform } from './registry.ts';

/**
 * The per-platform host allowlist of ARCHITECTURE §12.2 rule 2 — one table, used for platform
 * detection. Anything not listed is treated as a plain website (feed discovery + SSRF guard).
 */
const HOSTS: Record<string, Platform> = {
  'instagram.com': 'instagram',
  'x.com': 'x',
  'twitter.com': 'x',
  'tiktok.com': 'tiktok',
  'threads.com': 'threads',
  'threads.net': 'threads',
  'tumblr.com': 'tumblr',
  'pinterest.com': 'pinterest',
  'pin.it': 'pinterest',
  'facebook.com': 'facebook',
  'fb.watch': 'facebook',
  'youtube.com': 'youtube',
  'youtu.be': 'youtube',
  'bsky.app': 'bluesky',
  't.me': 'telegram',
  'telegram.me': 'telegram',
  'snapchat.com': 'snapchat',
};

/** Host without `www.`/`web.`/`m.`, lowercased. */
export function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/^(www|web|m|mobile)\./, '');
}

export function platformForHost(host: string): Platform | undefined {
  const raw = host.toLowerCase();
  // TikTok share hosts carry the post code as the only path segment.
  if (raw === 'vm.tiktok.com' || raw === 'vt.tiktok.com' || raw === 't.tiktok.com') return 'tiktok';
  const name = normalizeHost(host);
  const exact = HOSTS[name];
  if (exact) return exact;
  // Tumblr blogs live on subdomains: staff.tumblr.com is the profile.
  return name.endsWith('.tumblr.com') ? 'tumblr' : undefined;
}
