import type { Platform } from './registry.ts';

/**
 * Custom emoji ids from the bot's own `feedberry_platforms` set, built from the owner's SVG logos.
 * shortcut: Telegram keeps these only while the bot's owner holds Premium — without it the tags
 * are stripped server-side and the plain emoji below shows; check `entities` before debugging.
 */
const PLATFORM_EMOJI: Partial<Record<Platform, string>> = {
  rss: '6282825765729870159',
  instagram: '6282526363559666134',
  facebook: '6285118037020385408',
  x: '6282804857829074968',
  threads: '6284863890920580522',
  pinterest: '6285192838170812551',
  snapchat: '6285268536969404344',
  bluesky: '6285027284361421263',
  tumblr: '6282794657281747348',
  youtube: '6284892345078917308',
  // No SVG supplied yet, so these two still borrow the LOGOsEmoji pack.
  telegram: '5352877806122447940',
  tiktok: '5353034628263330616',
};

/** The plain emoji stays inside as the fallback for clients that ignore custom emoji. */
export function platformIcon(platform: string): string {
  // The row stores the platform as text; `hasOwn` keeps a value like `constructor` off the
  // prototype chain, which would otherwise render "function Object() { [native code] }".
  if (!Object.hasOwn(PLATFORM_ICON, platform)) return '🌐';
  const emoji = PLATFORM_ICON[platform as Platform];
  const id = Object.hasOwn(PLATFORM_EMOJI, platform) ? PLATFORM_EMOJI[platform as Platform] : undefined;
  return id === undefined ? emoji : `<tg-emoji emoji-id="${id}">${emoji}</tg-emoji>`;
}

const PLATFORM_ICON: Record<Platform, string> = {
  rss: '📡',
  instagram: '📸',
  x: '✖️',
  tiktok: '🎵',
  threads: '🧵',
  tumblr: '📝',
  pinterest: '📌',
  facebook: '📘',
  youtube: '▶️',
  bluesky: '🦋',
  telegram: '✈️',
  snapchat: '👻',
};