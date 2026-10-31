import type { InlineKeyboard } from 'grammy';
import { s1Keyboard } from '../keyboards.ts';
import { s1Text } from '../texts.ts';
import type { Lang } from '../i18n/index.ts';

export interface S1View {
  text: string;
  keyboard: InlineKeyboard;
}

/** S1 is pure: counts come from the caller so the renderer stays testable. */
export function s1View(params: { userId: number; sourceCount: number; limit: number; trialEnabled: boolean; lang?: Lang }): S1View {
  const lang = params.lang ?? 'en';
  return { text: s1Text(params), keyboard: s1Keyboard(lang) };
}
