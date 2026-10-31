import type { InlineKeyboard } from 'grammy';
import { s5Keyboard } from '../keyboards.ts';
import { s5Text } from '../texts.ts';
import type { Lang } from '../i18n/index.ts';

export interface S5View {
  text: string;
  keyboard: InlineKeyboard;
}

/** S5 edits the S4 message: same preview, add question, two save buttons. */
export function s5View(body: string, lang: Lang = 'en'): S5View {
  return { text: s5Text(body, lang), keyboard: s5Keyboard(lang) };
}
