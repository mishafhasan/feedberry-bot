import type { InlineKeyboard } from 'grammy';
import { menuKeyboard } from '../keyboards.ts';
import { supportedSitesText } from '../texts.ts';
import type { Lang } from '../i18n/index.ts';

export interface SupportedView {
  text: string;
  keyboard: InlineKeyboard;
}

/** S12 — Supported Sites (menu:supported, /supported_sites). */
export function s12View(lang: Lang = 'en'): SupportedView {
  return { text: supportedSitesText(lang), keyboard: menuKeyboard(lang) };
}
