import { InlineKeyboard } from 'grammy';
import type { SourceCard } from '../../db/repos/subscriptions.ts';
import { t, type Lang } from '../i18n/index.ts';
import { CHIPS, esc, keywordsLabel } from '../texts.ts';
import { PAGE_SIZE } from './s7.ts';

export interface FilterView {
  text: string;
  keyboard: InlineKeyboard;
}

/** `/filter` (ADR-020): the user's fallback list, then every source it covers, each with set/clear. */
export function s19View(params: { cards: SourceCard[]; offset: number; total: number; page: number; defaults: string | null; lang?: Lang }): FilterView {
  const lang = params.lang ?? 'en';
  const pages = Math.max(1, Math.ceil(params.total / PAGE_SIZE));

  const lines = [t(lang, 'filter.title'), '', t(lang, 'filter.default', { keywords: keywordsLabel(params.defaults, lang) }), ''];
  if (params.total === 0) lines.push(t(lang, 'filter.empty'));
  else lines.push(t(lang, 's7.showing', { from: params.offset + 1, to: params.offset + params.cards.length, total: params.total }), '');
  for (const card of params.cards) {
    lines.push(t(lang, 'filter.row', { title: esc(card.title ?? `#${card.source_id}`), keywords: keywordsLabel(card.keywords, lang, params.defaults) }));
  }
  if (params.total > 0) lines.push('', t(lang, 'filter.hint'));

  const keyboard = new InlineKeyboard();
  for (const card of params.cards) {
    const chip = CHIPS[card.platform] ?? card.platform;
    keyboard.text(`✏️ ${chip} · ${short(card.title ?? `#${card.source_id}`)}`, `kw:edit:${card.subscription_id}`).text('🗑', `kw:clear:${card.subscription_id}`).row();
  }
  keyboard.text(`✏️ ${t(lang, 'filter.defaultBtn')}`, 'kw:def').text('🗑', 'kw:cleardef').row();
  if (pages > 1) {
    if (params.page > 0) keyboard.text('‹', `kw:page:${params.page - 1}`);
    if (params.page < pages - 1) keyboard.text('›', `kw:page:${params.page + 1}`);
    keyboard.row();
  }
  keyboard.text(t(lang, 'btn.home'), 'nav:home');

  return { text: lines.join('\n'), keyboard };
}

/** Button labels carry the source name; the list in the body carries the keywords. */
function short(title: string, max = 24): string {
  return title.length <= max ? title : `${title.slice(0, max - 1)}…`;
}
