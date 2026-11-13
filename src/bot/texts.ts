/**
 * Every user-visible string is looked up from `i18n`; this module only shapes it.
 * Text is sent with parse_mode HTML, so any interpolated value must go through esc().
 */
import type { ErrorCode } from '../platform/errors.ts';
import { parseContentTypes } from '../platform/content-types.ts';
import type { Platform } from '../platform/registry.ts';
import { formatKeywords, parseKeywords } from '../pipeline/keyword-filter.ts';
import { mmddhhmm, platformLabel, sourceName } from '../render/caption.ts';
import { esc } from '../render/message-plan.ts';
import { platformIcon } from '../platform/icons.ts';
import { t, type Lang } from './i18n/index.ts';

export { esc, mmddhhmm, platformIcon };

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

/** One message carried several links: ask for one at a time, so the flow knows which one to open. */
export const oneLink = (count: number, lang: Lang = 'en'): string => t(lang, 'notice.oneLink', { count });

/** Text that meant to be a link but holds no openable URL; no Retry, it would fail identically. */
export const linkInvalid = (lang: Lang = 'en'): string => t(lang, 'notice.linkInvalid');

/** S3 — the bot's answer while stage 1 and 2 run. */
export function s3Text(canonicalUrl: string, lang: Lang = 'en'): string {
  return `${t(lang, 's3.checking')}\n\n${esc(canonicalUrl)}`;
}

/** S4 — preview. Items are the newest few, oldest first (§5.4). */
export function s4Text(params: { platform: Platform; author: string; items: Array<{ title: string; publishedAt: number | null }>; tz?: string; section?: string | null; lang?: Lang }): string {
  const lang = params.lang ?? 'en';
  return `${sourceBody(params)}\n\n${t(lang, 's4.question')}\n\n${t(lang, 's4.hint')}`;
}

/** The author + items block S4 and S5 share; kept so S5 can rebuild the caption without refetching. */
export function sourceBody(params: { platform: Platform; author: string; items: Array<{ title: string; publishedAt: number | null }>; tz?: string; section?: string | null; lang?: Lang }): string {
  const lines = params.items.map((item) => {
    const when = item.publishedAt === null ? null : mmddhhmm(item.publishedAt, params.tz);
    return when === null ? `• — ${esc(item.title)}` : `• [${when}] — ${esc(item.title)}`;
  });
  // A category source says which category, so the preview cannot be mistaken for the whole site.
  const scope = params.section === null || params.section === undefined ? '' : `\n${t(params.lang ?? 'en', 's4.category', { name: esc(sectionLabel(params.section)) })}`;
  return `${platformIcon(params.platform)} <b>${esc(params.author)}</b>${scope}\n\n${lines.join('\n')}`;
}

/**
 * What S4, S6 and the source list call the source. A category subscription names its section, unless
 * the feed's own title already does (`Science Latest`).
 */
export function sourceTitle(title: string, section: string | null): string {
  if (section === null) return title;
  const label = sectionLabel(section);
  const lower = title.toLowerCase();
  return label.toLowerCase().split(' ').some((word) => word.length > 2 && lower.includes(word)) ? title : `${title} · ${label}`;
}

/** `/category/artificial-intelligence` → `Artificial Intelligence`; a trailing section id names nothing. */
export function sectionLabel(section: string): string {
  const words = section.split('/').filter((part) => part !== '' && !/^\d+$/.test(part));
  const slug = words.at(-1) ?? section;
  return slug.replace(/[-_]+/g, ' ').replace(/(^|\s)(\S)/g, (_, lead: string, char: string) => lead + char.toUpperCase());
}

/** S5 — the same preview with the add question (§7.2 add:save / add:save_silent). */
export function s5Text(body: string, lang: Lang = 'en', keywords: string[] = [], fallback: string | null = null): string {
  return `${body}\n\n${t(lang, 's5.keywords', { keywords: keywordsLabel(formatKeywords(keywords), lang, fallback) })}\n\n${t(lang, 's5.question')}`;
}

/** A list, the default it would inherit, or "every post"; S5 and /filter print it the same way. */
export function keywordsLabel(raw: string | null | undefined, lang: Lang = 'en', fallback: string | null = null): string {
  const keywords = parseKeywords(raw);
  if (keywords.length > 0) return esc(keywords.join(', '));
  const inherited = parseKeywords(fallback);
  return inherited.length === 0 ? t(lang, 'kw.none') : t(lang, 'kw.usesDefault', { keywords: esc(inherited.join(', ')) });
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
  card: { platform: string; sourceId: number; title: string | null; url: string | null; lastCheckAt: number | null; lastOkAt: number | null; contentTypes?: string | null },
  now = Date.now(),
  lang: Lang = 'en',
): string {
  const age = humanAge(card.lastCheckAt ?? card.lastOkAt, now, lang);
  const label = esc(sourceName(card.title ?? `#${card.sourceId}`, card.platform));
  // Same tail as a post header (§8.2): the linked name, then the platform it came from.
  const name = `${platformIcon(card.platform)} <b>${card.url === null ? label : `<a href="${esc(card.url)}">${label}</a>`}</b> | ${esc(platformLabel(card.platform))}`;
  const kinds = kindsLine(card.platform, card.contentTypes, lang);
  return `<p>${t(lang, 's7.card', { title: name, id: card.sourceId, age }).replace('\n', '<br/>')}${kinds === null ? '' : `<br/>${kinds}`}</p>`;
}

/** A YouTube card says what it sends; every other platform has one feed and nothing to choose. */
function kindsLine(platform: string, raw: string | null | undefined, lang: Lang): string | null {
  if (platform !== 'youtube' || raw === null || raw === undefined) return null;
  const kinds = parseContentTypes(raw);
  if (kinds === null) return null;
  return esc(t(lang, 's7.kinds', { kinds: kinds.map((kind) => t(lang, `types.${kind}`)).join(', ') }));
}

/** The pills under one card: red Off, neutral refresh, the content types of a YouTube channel, red trash. */
export function s7ActionRow(card: { id: number; enabled: boolean; platform: string; subscriptionId: number }, lang: Lang = 'en'): string {
  const toggle = card.enabled ? 'src:off' : 'src:on';
  const style = card.enabled ? 'danger' : 'success';
  const label = card.enabled ? t(lang, 'btn.off') : t(lang, 'btn.on');
  // Only a YouTube channel has kinds to pick; every other row keeps its three buttons.
  const types = card.platform === 'youtube' ? `<tg-button type="callback_data" data="ct:open:${card.subscriptionId}">📋</tg-button>` : '';
  return `<tg-button-row align="left"><tg-button type="callback_data" style="${style}" data="${toggle}:${card.id}">${label}</tg-button><tg-button type="callback_data" data="src:check:${card.id}">⟳</tg-button>${types}<tg-button type="callback_data" style="danger" data="src:del:${card.id}">🗑</tg-button></tg-button-row>`;
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

/** ‹ › only when there is another page. `data` is the callback prefix, so any list can page itself. */
export function s7PagerRow(page: number, pages: number, prefix = 'src:page:'): string | null {
  if (pages <= 1) return null;
  const buttons: string[] = [];
  if (page > 0) buttons.push(`<tg-button type="callback_data" data="${prefix}${page - 1}">‹</tg-button>`);
  if (page < pages - 1) buttons.push(`<tg-button type="callback_data" data="${prefix}${page + 1}">›</tg-button>`);
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
