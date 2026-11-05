/**
 * Every user-visible string is looked up from `i18n`; this module only shapes it.
 * Text is sent with parse_mode HTML, so any interpolated value must go through esc().
 */
import type { ErrorCode } from '../platform/errors.ts';
import type { Platform } from '../platform/registry.ts';
import { mmddhhmm, platformLabel, sourceName } from '../render/caption.ts';
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

/** S1 — main menu. Rich message: `**bold**` becomes real bold, a blank line in the dictionary is a section break. */
export function s1Text({ userId, sourceCount, limit, trialEnabled, lang = 'en' }: S1Text): string {
  const plan = trialEnabled ? `${t(lang, 'plan.free')}\n${t(lang, 'plan.trial')}` : t(lang, 'plan.free');
  // The rich renderer spaces <p> blocks differently per client, so the blank line is markup, not a tag.
  const body = t(lang, 's1.body', { id: userId, plan, sources: `${sourceCount} / ${limit}` })
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .split('\n\n')
    .map((block) => block.replace(/\n/g, '<br/>'))
    .join('<br/><br/>');
  return `<p>${body}</p>`;
}

/** S2 — add source. Reddit is gone (OQ-2); Telegram is beta and hidden by default (OQ-3). */
export function s2Text(telegramBeta: boolean, lang: Lang = 'en'): string {
  const rows: string[] = [
    `${platformIcon('rss')} RSS Feed\nhttps://feeds.bbci.co.uk/news/world/rss.xml`,
    ...(telegramBeta ? [`${platformIcon('telegram')} Telegram\nhttps://t.me/telegram`] : []),
    `${platformIcon('x')} Twitter/X\nhttps://twitter.com/elonmusk`,
    `${platformIcon('instagram')} Instagram\nhttps://www.instagram.com/cristiano/`,
    `${platformIcon('youtube')} YouTube\nhttps://www.youtube.com/@MrBeast`,
    `${platformIcon('threads')} Threads\nhttps://www.threads.net/@zuck`,
    `${platformIcon('tiktok')} TikTok\nhttps://www.tiktok.com/@username`,
    `${platformIcon('snapchat')} Snapchat\n${t(lang, 's2.snapchat')}`,
    `${platformIcon('tumblr')} Tumblr\nhttps://staff.tumblr.com/`,
    `${platformIcon('pinterest')} Pinterest\nhttps://www.pinterest.com/pinterest/`,
    `${platformIcon('facebook')} Facebook\nhttps://www.facebook.com/meta`,
    `${platformIcon('bluesky')} Bluesky\nhttps://bsky.app/profile/bsky.app`,
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
  scheduleSet: t(lang, 'toast.scheduleSet'),
});

/** S1 Download Mode prompt (ADR-013): the next message must be a post link. */
export function downloadPrompt(lang: Lang = 'en'): string {
  return `${t(lang, 'prompt.download')}\n${t(lang, 'prompt.downloadList')}`;
}

/** After a successful download the chat stays usable: another link, or back to the menu. */
export const downloadDone = (lang: Lang = 'en'): string => t(lang, 'done.download');

/** A post link pasted outside a flow: offer the download, and the account when we can name it. */
export const postLinkPrompt = (lang: Lang = 'en'): string => t(lang, 'prompt.postLink');

/** A flow got the wrong kind of link: name the one it takes, and offer no Retry that would fail again. */
export const linkRequired = (want: 'post' | 'source', lang: Lang = 'en'): string =>
  t(lang, want === 'post' ? 'notice.postLinkRequired' : 'notice.sourceLinkRequired');

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

/** Rich messages (Bot API 10.3) draw a real rule; S7 puts one between every card. */
export const S7_DIVIDER = '<hr/>';

/** Platform chips keep the reference's short codes. */
export const CHIPS: Record<string, string> = {
  rss: 'RSS',
  instagram: 'IG',
  facebook: 'FB',
  x: 'X',
  threads: 'TH',
  tiktok: 'TT',
  tumblr: 'TB',
  pinterest: 'PT',
  youtube: 'YT',
  bluesky: 'BS',
  telegram: 'TG',
  snapchat: 'SC',
};

const CHIPS_PER_ROW = 4;

export function s7HeaderHtml(shown: string, lang: Lang = 'en'): string {
  return `<p><b>${t(lang, 's7.title')}</b><br/>${shown}</p>`;
}

/** One S7 card: its pills follow it as a rich button row, so the id line stays under the title. */
export function s7CardHtml(
  card: { platform: string; sourceId: number; title: string | null; url: string | null; lastCheckAt: number | null; lastOkAt: number | null },
  now = Date.now(),
  lang: Lang = 'en',
): string {
  const age = humanAge(card.lastCheckAt ?? card.lastOkAt, now, lang);
  const label = esc(sourceName(card.title ?? `#${card.sourceId}`, card.platform));
  // Same tail as a post header (§8.2): the linked name, then the platform it came from.
  const name = `${platformIcon(card.platform)} <b>${card.url === null ? label : `<a href="${esc(card.url)}">${label}</a>`}</b> | ${esc(platformLabel(card.platform))}`;
  return `<p>${t(lang, 's7.card', { title: name, id: card.sourceId, age }).replace('\n', '<br/>')}</p>`;
}

/** The pills under one card: red Off, neutral refresh, red trash — the reference's row. */
export function s7ActionRow(card: { id: number; enabled: boolean }, lang: Lang = 'en'): string {
  const toggle = card.enabled ? 'src:off' : 'src:on';
  const style = card.enabled ? 'danger' : 'success';
  const label = card.enabled ? t(lang, 'btn.off') : t(lang, 'btn.on');
  return `<tg-button-row align="left"><tg-button type="callback_data" style="${style}" data="${toggle}:${card.id}">${label}</tg-button><tg-button type="callback_data" data="src:check:${card.id}">⟳</tg-button><tg-button type="callback_data" style="danger" data="src:del:${card.id}">🗑</tg-button></tg-button-row>`;
}

/** Filters sit under the cards; four chips per row, the active one in the accent color. */
export function s7FilterRows(platforms: string[], active: string | null, lang: Lang = 'en'): string[] {
  if (platforms.length === 0) return [];
  const chips = [
    { label: esc(t(lang, 'btn.all')), data: 'src:filter:all', on: active === null },
    ...platforms.map((platform) => ({
      label: `${platformIcon(platform)} ${esc(CHIPS[platform] ?? platform.slice(0, 2).toUpperCase())}`,
      data: `src:filter:${platform}`,
      on: platform === active,
    })),
  ];
  const rows: string[] = [];
  for (let index = 0; index < chips.length; index += CHIPS_PER_ROW) {
    const buttons = chips
      .slice(index, index + CHIPS_PER_ROW)
      .map((chip) => `<tg-button type="callback_data"${chip.on ? ' style="primary"' : ''} data="${chip.data}">${chip.label}</tg-button>`)
      .join('');
    rows.push(`<tg-button-row align="left">${buttons}</tg-button-row>`);
  }
  return rows;
}

/** ‹ › only when there is another page. */
export function s7PagerRow(page: number, pages: number): string | null {
  if (pages <= 1) return null;
  const buttons: string[] = [];
  if (page > 0) buttons.push(`<tg-button type="callback_data" data="src:page:${page - 1}">‹</tg-button>`);
  if (page < pages - 1) buttons.push(`<tg-button type="callback_data" data="src:page:${page + 1}">›</tg-button>`);
  return `<tg-button-row align="center">${buttons.join('')}</tg-button-row>`;
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
  const emoji = PLATFORM_ICON[platform as Platform] ?? '📡';
  const id = PLATFORM_EMOJI[platform as Platform];
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

/** Supported Sites rows keep their order in every language; the leading emoji becomes the platform logo. */
const SUPPORTED_ORDER: Platform[] = ['rss', 'instagram', 'facebook', 'threads', 'x', 'tiktok', 'bluesky', 'snapchat', 'tumblr', 'pinterest', 'youtube'];

export function supportedSitesText(lang: Lang = 'en'): string {
  const rows = t(lang, 'supported.rows').split('\n');
  // shortcut: a translation that changes the row count keeps its own emoji rather than the logos
  const lines = rows.length === SUPPORTED_ORDER.length
    ? rows.map((row, index) => `${platformIcon(SUPPORTED_ORDER[index] ?? 'rss')} ${row.slice(row.indexOf(' ') + 1)}`)
    : rows;
  return `${t(lang, 'supported.title')}\n\n${lines.join('\n')}\n\n${t(lang, 'supported.outro')}`;
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
