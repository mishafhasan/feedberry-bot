import type { InlineKeyboard } from 'grammy';
import type { SourceCard } from '../../db/repos/subscriptions.ts';
import { backKeyboard } from '../keyboards.ts';
import { rangeLabel, s7ActionRow, s7CardHtml, s7FilterRows, s7HeaderHtml, s7PagerRow, S7_DIVIDER } from '../texts.ts';
import type { Lang } from '../i18n/index.ts';

/** S7 is one message: every card, its actions and the pager share a single message. */
export const PAGE_SIZE = 5;

/** Rich message body (Bot API 10.3) plus the only keyboard: Back. */
export interface S7View {
  html: string;
  keyboard: InlineKeyboard;
}

export function mySourcesView(params: {
  cards: SourceCard[];
  offset: number;
  total: number;
  platforms: string[];
  active: string | null;
  page: number;
  lang?: Lang;
  now?: number;
}): S7View {
  const lang = params.lang ?? 'en';
  const now = params.now ?? Date.now();
  const pages = Math.max(1, Math.ceil(params.total / PAGE_SIZE));

  // The reference rules off the header, then puts each card's pills directly under that card.
  const parts = [s7HeaderHtml(rangeLabel(params.offset, params.cards.length, params.total, lang), lang)];
  if (params.cards.length > 0) parts.push(S7_DIVIDER);
  for (const card of params.cards) {
    parts.push(
      s7CardHtml(
        {
          platform: card.platform,
          sourceId: card.source_id,
          title: card.title,
          url: card.canonical_url,
          lastCheckAt: card.last_check_at,
          lastOkAt: card.last_ok_at,
          contentTypes: card.content_types,
        },
        now,
        lang,
      ),
      s7ActionRow({ id: card.source_id, enabled: card.enabled === 1, platform: card.platform, subscriptionId: card.subscription_id }, lang),
      S7_DIVIDER,
    );
  }
  parts.push(...s7FilterRows(params.platforms, params.active, lang));
  const pager = s7PagerRow(params.page, pages);
  if (pager !== null) parts.push(pager);

  return { html: parts.join(''), keyboard: backKeyboard(lang) };
}
