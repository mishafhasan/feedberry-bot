/**
 * Every user-visible string lives here (ARCHITECTURE §11 wording has one source of truth).
 * Text is sent with parse_mode HTML, so any interpolated value must go through esc().
 */

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
} as const;

export const genericToast = {
  unknown: 'That button is no longer available.',
} as const;
