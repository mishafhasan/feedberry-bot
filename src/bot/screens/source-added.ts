import type { InlineKeyboard } from 'grammy';
import { s6Keyboard } from '../keyboards.ts';
import { s6Text } from '../texts.ts';
import type { Lang } from '../i18n/index.ts';

export interface S6View {
  text: string;
  keyboard: InlineKeyboard;
}

export function sourceAddedView(title: string, lang: Lang = 'en'): S6View {
  return { text: s6Text(title, lang), keyboard: s6Keyboard(lang) };
}
