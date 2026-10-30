import type { InlineKeyboard } from 'grammy';
import { s10Keyboard } from '../keyboards.ts';
import { s10Text } from '../texts.ts';

export interface S10View {
  text: string;
  keyboard: InlineKeyboard;
}

/** S10/S11: the confirm is its own message; S11 is the answerCallbackQuery toast. */
export function s10View(title: string, sourceId: number): S10View {
  return { text: s10Text(title), keyboard: s10Keyboard(sourceId) };
}
