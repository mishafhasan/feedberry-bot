/**
 * Every user-visible string lives here (ARCHITECTURE §11 wording has one source of truth).
 * Text is sent with parse_mode HTML, so any interpolated value must go through esc().
 */
import type { ErrorCode } from '../platform/errors.ts';
import type { Platform } from '../platform/registry.ts';
import { esc } from '../render/plan.ts';

export { esc };

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

export const genericToast = {
  unknown: 'That button is no longer available.',
} as const;

/** S1 Download Mode prompt (ADR-013): the next message must be a post link. */
export const downloadPrompt = '⬇️ Send a post link and I will deliver the media here.';

/** S3 — the bot's answer while stage 1 and 2 run. */
export function s3Text(canonicalUrl: string): string {
  return `⚪ Checking source:\n\n${esc(canonicalUrl)}`;
}

/** S4 — preview. Items are the newest few, oldest first (§5.4). */
export function s4Text(params: { platform: Platform; author: string; items: Array<{ title: string; publishedAt: number | null }>; tz?: string }): string {
  return `${sourceBody(params)}\n\nWhere should posts from this source be delivered?\n\n⚠️ To deliver into a channel or group, add the bot there as an admin with permission to post — the chat will then show up in this list.`;
}

/** The author + items block S4 and S5 share; kept so S5 can rebuild the caption without refetching. */
export function sourceBody(params: { platform: Platform; author: string; items: Array<{ title: string; publishedAt: number | null }>; tz?: string }): string {
  const lines = params.items.map((item) => {
    const when = item.publishedAt === null ? null : mmddhhmm(item.publishedAt, params.tz);
    return when === null ? `• — ${esc(item.title)}` : `• [${when}] — ${esc(item.title)}`;
  });
  return `${platformIcon(params.platform)} <b>${esc(params.author)}</b>\n\n${lines.join('\n')}`;
}

/** S5 — the same preview with the add question (§7.2 add:save / add:save_silent). */
export function s5Text(body: string): string {
  return `${body}\n\nHow do we add the source?`;
}

/** S6 — added. */
export function s6Text(title: string): string {
  return `Data source «${esc(title)}» is added to your feed. You will receive notification about new posts as soon as they are published.`;
}

/** S10 — delete confirmation (ADR-016). */
export function s10Text(title: string): string {
  return `🗑 Delete the source «${esc(title)}»?\nIts posts will stop coming and the subscription settings will be removed.`;
}

/** S7 header: the page label under the title. */
export function rangeLabel(offset: number, count: number, total: number): string {
  return count === 0 ? 'Showing 0 of 0' : `Showing ${offset + 1}–${offset + count} of ${total}`;
}

export function s7HeaderText(shown: string): string {
  return `Source list · Private messages\n${shown}`;
}

/** One S7 card: `id: #<id>, source checked: <age>` (§7.3). */
export function s7CardText(card: { platform: string; sourceId: number; title: string | null; lastCheckAt: number | null; lastOkAt: number | null }, now = Date.now()): string {
  const age = humanAge(card.lastCheckAt ?? card.lastOkAt, now);
  return `${platformIcon(card.platform)} <b>${esc(card.title ?? `#${card.sourceId}`)}</b>\nid: #${card.sourceId}, source checked: ${age}`;
}

/** `41s`, `10m`, `2h`, `3d` — the screenshot's shape. */
export function humanAge(ms: number | null, now = Date.now()): string {
  if (ms === null) return 'never';
  const seconds = Math.max(0, Math.round((now - ms) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86_400)}d`;
}

export function platformIcon(platform: string): string {
  return PLATFORM_ICON[platform as Platform] ?? '📡';
}

/** S8/S9/S11 toasts, verbatim from the screenshots and §7.2. */
export const actionToast = {
  disabled: 'Source disabled — new posts will not arrive.',
  enabled: 'Source enabled.',
  deleted: 'Source deleted.',
  /** M3 stub: the manual_check worker lands in M4 (§4.6). */
  checkQueued: 'Queued for a check — the source will be polled within a minute.',
} as const;

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
  E_POST_REQUIRED: 'Send a post link, not a profile.',
  E_DOWNLOAD_LIMIT: 'The daily download limit is reached. Try again tomorrow.',
};

export function errorText(code: ErrorCode, limit?: number): string {
  // The two limit messages name a configured number, so they are built here, not in the table.
  if (limit !== undefined && code === 'E_SOURCE_LIMIT') return `⚠️ You've reached ${limit} sources. Delete one first.`;
  if (limit !== undefined && code === 'E_DOWNLOAD_LIMIT') return `⚠️ You've reached ${limit} downloads today.`;
  return `⚠️ ${ERROR_TEXT[code]}`;
}
