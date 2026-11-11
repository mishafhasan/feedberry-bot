import type { InlineKeyboard } from 'grammy';
import { s5Keyboard } from '../keyboards.ts';
import { s5Text } from '../texts.ts';
import type { Lang } from '../i18n/index.ts';

export interface S5View {
  text: string;
  keyboard: InlineKeyboard;
}

/** S5 edits the S4 message: same preview, the keyword line, add question, two save buttons. */
export function deliveryOptionsView(body: string, lang: Lang = 'en', keywords: string[] = [], fallback: string | null = null): S5View {
  return { text: s5Text(body, lang, keywords, fallback), keyboard: s5Keyboard(lang) };
}
