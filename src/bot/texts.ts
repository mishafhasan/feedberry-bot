/**
 * Every user-visible string lives here (ARCHITECTURE §11 wording has one source of truth).
 * Text is sent with parse_mode HTML, so any interpolated value must go through esc().
 */
import type { ErrorCode } from '../platform/errors.ts';
import type { Platform } from '../platform/registry.ts';

export function esc(value: string | number): string {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export interface S1Text {
  userId: number;
  sourceCount: number;
  limit: number;
  trialEnabled: boolean;
}

/** S1 — main menu. Plan block follows OQ-7: no trial line unless TRIAL_ENABLED. */
export function s1Text({ userId, sourceCount, limit, trialEnabled }: S1Text): string {
  return `🍓 FeedBerry — fresh posts from your favorite accounts, delivered to Telegram.

How to use: 1) Send a profile or post link 2) Choose where to deliver 3) Tap Add — done.

🆔 Your ID: ${esc(userId)}
⭐ Plan: Free${trialEnabled ? '\n🕐 Trial ends: —' : ''}
📊 Sources: ${sourceCount} / ${limit}

Features:
🌳 Power Efficient: It should consume very little computing power to run.
🌐 Post forwarding from: RSS, Instagram, TikTok, YouTube, Twitter/X, Facebook, etc...
💬 Delivery to your DM, channels, groups and forum topics
🖼 Photos, videos, albums and files in original quality.
⬇️ Full article text: the bot pulls the whole article from the link and converts it into telegram instant view, with media and without ads.
🧠 Smart routing: AI detects the topic of each post and sorts posts from sources across chats and forum topics
⚡ Fast source checks: with custom interval
©️ Save media without watermarks and logo.
⬇️ Download mode: Send post link of supported platforms and bot will send the file/media as post.
✨ AI processing: summary, digest, rephrasing, style change, ad auto-detection and your own custom prompt (Future Plan Only)

How to use:
1) Send a profile or post link
2) Choose where to deliver
3) Tap Add — done.`;
}

/** S2 — add source. Reddit is gone (OQ-2); Telegram is beta and hidden by default (OQ-3). */
export function s2Text(telegramBeta: boolean): string {
  const rows: string[] = [
    '📡 RSS Feed\nhttps://feeds.bbci.co.uk/news/world/rss.xml',
    ...(telegramBeta ? ['✈️ Telegram\nhttps://t.me/telegram'] : []),
    '✖️ Twitter/X\nhttps://twitter.com/elonmusk',
    '📸 Instagram\nhttps://www.instagram.com/cristiano/',
    '▶️ YouTube\nhttps://www.youtube.com/@MrBeast',
    '🧵 Threads\nhttps://www.threads.net/@zuck',
    '🎵 TikTok\nhttps://www.tiktok.com/@username',
    '👻 Snapchat\nsingle links only — use Download Mode',
    '📝 Tumblr\nhttps://staff.tumblr.com/',
    '📌 Pinterest\nhttps://www.pinterest.com/pinterest/',
    '📘 Facebook\nhttps://www.facebook.com/meta',
    '🦋 Bluesky\nhttps://bsky.app/profile/bsky.app',
  ];
  return `🔗 Adding a source\n\n${rows.join('\n\n')}\n\nJust send a link to any of these sources and follow the instructions.`;
}

/** Stubs registered in Appendix A; each line disappears at its milestone. */
export const stubToast = {
  sources: 'My sources arrives in M3.',
  download: 'Download Mode arrives in M5.',
  destination: 'Choosing a destination arrives in M3.',
} as const;

export const genericToast = {
  unknown: 'That button is no longer available.',
} as const;

/** S3 — the bot's answer while stage 1 and 2 run. */
export function s3Text(canonicalUrl: string): string {
  return `⚪ Checking source:\n\n${esc(canonicalUrl)}`;
}

/** S4 — preview. Items are the newest few, oldest first (§5.4). */
export function s4Text(params: { platform: Platform; author: string; items: Array<{ title: string; publishedAt: number | null }>; tz?: string }): string {
  const lines = params.items.map((item) => {
    const when = item.publishedAt === null ? null : mmddhhmm(item.publishedAt, params.tz);
    return when === null ? `• — ${esc(item.title)}` : `• [${when}] — ${esc(item.title)}`;
  });
  return `${PLATFORM_ICON[params.platform]} <b>${esc(params.author)}</b>\n\n${lines.join('\n')}\n\nWhere should posts from this source be delivered?\n\n⚠️ To deliver into a channel or group, add the bot there as an admin with permission to post — the chat will then show up in this list.`;
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

/** `MM/DD HH:MM` in the owner's timezone (users.tz, UTC until M3 stores one). */
export function mmddhhmm(ms: number, tz = 'UTC'): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(ms);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '--';
  return `${get('month')}/${get('day')} ${get('hour')}:${get('minute')}`;
}

/** ARCHITECTURE §11: one cause, one sentence, one action. */
export const ERROR_TEXT: Record<ErrorCode, string> = {
  E_LINK_INVALID: "That link isn't a supported source.",
  E_NO_FEED: "Couldn't find a feed for this page.",
  E_PROFILE_ONLY: 'This is a browse page. Send a profile link instead.',
  E_BOT_NOT_ADMIN: 'Add me as an admin with permission to post, then try again.',
  E_FORUM_TOPIC: "That topic can't be posted to. Pick another or the General topic.",
  E_SOURCE_LIMIT: "You've reached 250 sources. Delete one first.",
  E_DUPLICATE: 'This source is already in your list.',
  E_COOKIE_REQUIRED: "This source needs a login the bot doesn't have. Send one post link instead.",
  E_RATE_LIMIT: 'The platform is rate-limiting checks. Will retry later.',
  E_FEED_DOWN: 'The source is temporarily unreachable.',
  E_NO_MEDIA: "Couldn't extract media; sending the link.",
  E_TOO_LARGE: 'The file is too large to upload, so a preview was sent instead.',
  E_MEDIA_GONE: 'The media link expired. Retrying with a fresh check.',
  E_TELEGRAPH: 'The article could not be converted, so the link was sent.',
  E_TG_PARSE: 'The post had unsupported formatting; it was sent as plain text.',
  E_TG_FORBIDDEN: "I can't post to this chat.",
  E_TG_429: 'Telegram asked us to slow down. Retrying.',
  E_TG_UNKNOWN: 'Something went wrong. Retry?',
};

export function errorText(code: ErrorCode): string {
  return `⚠️ ${ERROR_TEXT[code]}`;
}
