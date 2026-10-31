/**
 * Every user-visible string is looked up from `i18n`; this module only shapes it.
 * Text is sent with parse_mode HTML, so any interpolated value must go through esc().
 */
import type { ErrorCode } from '../platform/errors.ts';
import type { Platform } from '../platform/registry.ts';
import { mmddhhmm } from '../render/caption.ts';
import { esc } from '../render/plan.ts';
import { t, type Lang } from './i18n/index.ts';

export { esc, mmddhhmm };

export interface S1Text {
  userId: number;
  sourceCount: number;
  limit: number;
  trialEnabled: boolean;
  lang?: Lang;
}

/** S1 — main menu. Plan block follows OQ-7: no trial line unless TRIAL_ENABLED. */
export function s1Text({ userId, sourceCount, limit, trialEnabled, lang = 'en' }: S1Text): string {
  const plan = trialEnabled ? `${t(lang, 'plan.free')}\n${t(lang, 'plan.trial')}` : t(lang, 'plan.free');
  return t(lang, 's1.body', { id: userId, plan, sources: `${sourceCount} / ${limit}` });
}

/** S2 — add source. Reddit is gone (OQ-2); Telegram is beta and hidden by default (OQ-3). */
export function s2Text(telegramBeta: boolean, lang: Lang = 'en'): string {
  const rows: string[] = [
    '📡 RSS Feed\nhttps://feeds.bbci.co.uk/news/world/rss.xml',
    ...(telegramBeta ? ['✈️ Telegram\nhttps://t.me/telegram'] : []),
    '✖️ Twitter/X\nhttps://twitter.com/elonmusk',
    '📸 Instagram\nhttps://www.instagram.com/cristiano/',
    '▶️ YouTube\nhttps://www.youtube.com/@MrBeast',
    '🧵 Threads\nhttps://www.threads.net/@zuck',
    '🎵 TikTok\nhttps://www.tiktok.com/@username',
    `👻 Snapchat\n${t(lang, 's2.snapchat')}`,
    '📝 Tumblr\nhttps://staff.tumblr.com/',
    '📌 Pinterest\nhttps://www.pinterest.com/pinterest/',
    '📘 Facebook\nhttps://www.facebook.com/meta',
    '🦋 Bluesky\nhttps://bsky.app/profile/bsky.app',
  ];
  return `${t(lang, 's2.title')}\n\n${rows.join('\n\n')}\n\n${t(lang, 's2.outro')}`;
}

/** §12.4 abuse quotas: a toast, never an exception. */
export const genericToast = (lang: Lang = 'en') => ({
  unknown: t(lang, 'toast.unknown'),
  slowDown: t(lang, 'toast.slowDown'),
  checksExhausted: t(lang, 'toast.checksExhausted'),
});

/** S8/S9/S11 toasts, verbatim from the screenshots and §7.2. */
export const actionToast = (lang: Lang = 'en') => ({
  disabled: t(lang, 'toast.disabled'),
  enabled: t(lang, 'toast.enabled'),
  deleted: t(lang, 'toast.deleted'),
  checkQueued: t(lang, 'toast.checkQueued'),
});

/** S1 Download Mode prompt (ADR-013): the next message must be a post link. */
export function downloadPrompt(lang: Lang = 'en'): string {
  return `${t(lang, 'prompt.download')}\n${t(lang, 'prompt.downloadList')}`;
}

/** After a successful download the chat stays usable: another link, or back to the menu. */
export const downloadDone = (lang: Lang = 'en'): string => t(lang, 'done.download');

/** A post link pasted outside a flow: offer the download, and the account when we can name it. */
export const postLinkPrompt = (lang: Lang = 'en'): string => t(lang, 'prompt.postLink');

/** S3 — the bot's answer while stage 1 and 2 run. */
export function s3Text(canonicalUrl: string, lang: Lang = 'en'): string {
  return `${t(lang, 's3.checking')}\n\n${esc(canonicalUrl)}`;
}

/** S4 — preview. Items are the newest few, oldest first (§5.4). */
export function s4Text(params: { platform: Platform; author: string; items: Array<{ title: string; publishedAt: number | null }>; tz?: string; lang?: Lang }): string {
  const lang = params.lang ?? 'en';
  return `${sourceBody(params)}\n\n${t(lang, 's4.question')}\n\n${t(lang, 's4.hint')}`;
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
export function s5Text(body: string, lang: Lang = 'en'): string {
  return `${body}\n\n${t(lang, 's5.question')}`;
}

/** S6 — added. */
export function s6Text(title: string, lang: Lang = 'en'): string {
  return t(lang, 's6.added', { title: esc(title) });
}

/** S10 — delete confirmation (ADR-016). */
export function s10Text(title: string, lang: Lang = 'en'): string {
  return t(lang, 's10.confirm', { title: esc(title) });
}

/** S7 header: the page label under the title. */
export function rangeLabel(offset: number, count: number, total: number, lang: Lang = 'en'): string {
  if (count === 0) return t(lang, 's7.empty');
  return t(lang, 's7.showing', { from: offset + 1, to: offset + count, total });
}

export function s7HeaderText(shown: string, lang: Lang = 'en'): string {
  return `${t(lang, 's7.title')}\n${shown}`;
}

/** One S7 card: `id: #<id>, source checked: <age>` (§7.3). */
export function s7CardText(
  card: { platform: string; sourceId: number; title: string | null; lastCheckAt: number | null; lastOkAt: number | null },
  now = Date.now(),
  lang: Lang = 'en',
): string {
  const age = humanAge(card.lastCheckAt ?? card.lastOkAt, now, lang);
  const name = `${platformIcon(card.platform)} <b>${esc(card.title ?? `#${card.sourceId}`)}</b>`;
  return t(lang, 's7.card', { title: name, id: card.sourceId, age });
}

/** `41s`, `10m`, `2h`, `3d` — the screenshot's shape. */
export function humanAge(ms: number | null, now = Date.now(), lang: Lang = 'en'): string {
  if (ms === null) return t(lang, 'age.never');
  const seconds = Math.max(0, Math.round((now - ms) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86_400)}d`;
}

export function platformIcon(platform: string): string {
  return PLATFORM_ICON[platform as Platform] ?? '📡';
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

/** Supported Sites, generated from the §10 platform matrix so the screen and the code cannot drift. */
export function supportedSitesText(lang: Lang = 'en'): string {
  return `${t(lang, 'supported.title')}\n\n${t(lang, 'supported.rows')}\n\n${t(lang, 'supported.outro')}`;
}

/** About: what the bot is, and the one number the user needs to quote. */
export function aboutText(userId: number, lang: Lang = 'en'): string {
  return t(lang, 'about.body', { id: userId });
}

/** Help: the four things a user actually does. */
export function helpText(lang: Lang = 'en'): string {
  return t(lang, 'help.body');
}

/** ARCHITECTURE §11: one cause, one sentence, one action. */
export function errorText(code: ErrorCode, limit?: number, lang: Lang = 'en'): string {
  // The two limit messages name a configured number, so they are built here, not in the table.
  if (limit !== undefined && code === 'E_SOURCE_LIMIT') return t(lang, 'err.limitSources', { limit });
  if (limit !== undefined && code === 'E_DOWNLOAD_LIMIT') return t(lang, 'err.limitDownloads', { limit });
  return `⚠️ ${t(lang, `err.${code}`)}`;
}
