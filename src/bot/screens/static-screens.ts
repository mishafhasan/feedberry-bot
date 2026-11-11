import type { InlineKeyboard } from 'grammy';
import { languageKeyboard, menuKeyboard } from '../keyboards.ts';
import { aboutText, helpText } from '../texts.ts';
import { t, type Lang } from '../i18n/index.ts';

export interface InfoView {
  text: string;
  keyboard: InlineKeyboard;
}

/** S13 — Help (menu:help). */
export function helpView(lang: Lang = 'en'): InfoView {
  return { text: helpText(lang), keyboard: menuKeyboard(lang) };
}

/** S14 — About (/about). */
export function aboutView(userId: number, lang: Lang = 'en'): InfoView {
  return { text: aboutText(userId, lang), keyboard: menuKeyboard(lang) };
}

/** S15 — Interface language (/language, menu:language). */
export function languageView(lang: Lang = 'en'): InfoView {
  return { text: t(lang, 'language.title'), keyboard: languageKeyboard() };
}
