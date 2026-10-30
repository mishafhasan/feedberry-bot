import type { InlineKeyboard } from 'grammy';
import { backKeyboard } from '../keyboards.ts';
import { s2Text } from '../texts.ts';

export interface S2View {
  text: string;
  keyboard: InlineKeyboard;
}

export function s2View(telegramBeta: boolean): S2View {
  return { text: s2Text(telegramBeta), keyboard: backKeyboard() };
}
