import type { InlineKeyboard } from 'grammy';
import { backKeyboard } from '../keyboards.ts';
import { s2Text } from '../texts.ts';
import type { Lang } from '../i18n/index.ts';

export interface S2View {
  text: string;
  keyboard: InlineKeyboard;
}

export function addSourceView(telegramBeta: boolean, lang: Lang = 'en'): S2View {
  return { text: s2Text(telegramBeta, lang), keyboard: backKeyboard(lang) };
}
