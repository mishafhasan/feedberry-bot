import type { InlineKeyboard } from 'grammy';
import type { SourceCard } from '../../db/repos/subscriptions.ts';
import { s7Keyboard } from '../keyboards.ts';
import { rangeLabel, s7CardText, s7HeaderText } from '../texts.ts';
import type { Lang } from '../i18n/index.ts';

/** S7 is one message: every card, its actions and the pager share a single message. */
export const PAGE_SIZE = 5;

export interface S7View {
  text: string;
  keyboard: InlineKeyboard;
}

export function s7View(params: {
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

  const blocks = params.cards.map((card) =>
    s7CardText(
      { platform: card.platform, sourceId: card.source_id, title: card.title, lastCheckAt: card.last_check_at, lastOkAt: card.last_ok_at },
      now,
      lang,
    ),
  );
  const heading = s7HeaderText(rangeLabel(params.offset, params.cards.length, params.total, lang), lang);

  return {
    text: blocks.length > 0 ? `${heading}\n\n${blocks.join('\n\n')}` : heading,
    keyboard: s7Keyboard(
      params.cards.map((card) => ({ id: card.source_id, enabled: card.enabled === 1 })),
      params.platforms,
      params.active,
      params.page,
      pages,
      lang,
    ),
  };
}
