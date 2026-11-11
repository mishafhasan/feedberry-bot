import type { InlineKeyboard } from 'grammy';
import { s1Keyboard } from '../keyboards.ts';
import { s1Text } from '../texts.ts';
import type { Lang } from '../i18n/index.ts';

/** S1 is a rich message (Bot API 10.3): the body is HTML, the five buttons stay a keyboard. */
export interface S1View {
  html: string;
  keyboard: InlineKeyboard;
}

/** S1 is pure: counts come from the caller so the renderer stays testable. */
export function mainMenuView(params: { userId: number; sourceCount: number; limit: number; trialEnabled: boolean; lang?: Lang }): S1View {
  const lang = params.lang ?? 'en';
  return { html: s1Text(params), keyboard: s1Keyboard(lang) };
}
