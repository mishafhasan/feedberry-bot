import type { InlineKeyboard } from 'grammy';
import type { SourceCard } from '../../db/repos/subscriptions.ts';
import { cardKeyboard, s7Keyboard } from '../keyboards.ts';
import { rangeLabel, s7CardText, s7HeaderText } from '../texts.ts';

/** S7 is a header message plus one message per card, because each card owns its buttons. */
export const PAGE_SIZE = 5;

export interface S7HeaderView {
  text: string;
  keyboard: InlineKeyboard;
}

export function s7HeaderView(params: { offset: number; count: number; total: number; platforms: string[]; active: string | null; page: number }): S7HeaderView {
  const pages = Math.max(1, Math.ceil(params.total / PAGE_SIZE));
  return {
    text: s7HeaderText(rangeLabel(params.offset, params.count, params.total)),
    keyboard: s7Keyboard(params.platforms, params.active, params.page, pages),
  };
}

export function s7CardView(card: SourceCard, now = Date.now()): { text: string; keyboard: InlineKeyboard } {
  return {
    text: s7CardText({ platform: card.platform, sourceId: card.source_id, title: card.title, lastCheckAt: card.last_check_at, lastOkAt: card.last_ok_at }, now),
    keyboard: cardKeyboard(card.source_id, card.enabled === 1),
  };
}
