import type { InlineKeyboard } from 'grammy';
import type { SourceCard } from '../../db/repos/subscriptions.ts';
import { platformLabel } from '../../render/caption.ts';
import { t, type Lang } from '../i18n/index.ts';
import { backKeyboard } from '../keyboards.ts';
import { esc, keywordsLabel, platformIcon, s7PagerRow, S7_DIVIDER } from '../texts.ts';
import { PAGE_SIZE } from './my-sources.ts';

/** Rich message body (Bot API 10.3) plus the only keyboard: Back. */
export interface FilterView {
  html: string;
  keyboard: InlineKeyboard;
}

/**
 * `/filter` (ADR-020): the fallback first, then one card per source it covers. Each card owns its own
 * pills, so a button never has to repeat a source name; a card with nothing to clear gets no 🗑.
 */
export function keywordFilterView(params: { cards: SourceCard[]; offset: number; total: number; page: number; defaults: string | null; lang?: Lang }): FilterView {
  const lang = params.lang ?? 'en';
  const pages = Math.max(1, Math.ceil(params.total / PAGE_SIZE));

  const parts = [
    `<p><b>${t(lang, 'filter.title')}</b><br/><i>${t(lang, 'filter.lead')}</i></p>`,
    S7_DIVIDER,
    `<p><b>${t(lang, 'filter.default')}</b><br/>${tags(params.defaults, null, lang)}<br/><i>${t(lang, 'filter.defaultHint')}</i></p>`,
    pills('kw:def', params.defaults, 'kw:cleardef'),
  ];

  for (const card of params.cards) {
    const label = esc(card.title ?? `#${card.source_id}`);
    parts.push(
      S7_DIVIDER,
      `<p>${platformIcon(card.platform)} <b><a href="${esc(card.canonical_url)}">${label}</a></b> | ${esc(platformLabel(card.platform))}<br/>${tags(card.keywords, params.defaults, lang)}</p>`,
      pills(`kw:edit:${card.subscription_id}`, card.keywords, `kw:clear:${card.subscription_id}`),
    );
  }

  const count = params.total === 0 ? t(lang, 'filter.empty') : t(lang, 's7.showing', { from: params.offset + 1, to: params.offset + params.cards.length, total: params.total });
  const hint = params.total === 0 ? '' : `<br/><i>${t(lang, 'filter.hint')}</i>`;
  parts.push(S7_DIVIDER, `<p><i>${count}</i>${hint}</p>`);

  const pager = s7PagerRow(params.page, pages, 'kw:page:');
  if (pager !== null) parts.push(pager);

  return { html: parts.join(''), keyboard: backKeyboard(lang) };
}

/** The tag line: a list, the default it inherits, or "no filter". */
const tags = (raw: string | null, fallback: string | null, lang: Lang): string => t(lang, 'filter.tags', { keywords: keywordsLabel(raw, lang, fallback) });

/** Edit stays; Clear only exists when there is a list to clear. */
function pills(edit: string, own: string | null, clear: string): string {
  const clearable = (own ?? '').trim() !== '';
  return `<tg-button-row align="left"><tg-button type="callback_data" data="${edit}">✏️</tg-button>${
    clearable ? `<tg-button type="callback_data" style="danger" data="${clear}">🗑</tg-button>` : ''
  }</tg-button-row>`;
}
