import type { InlineKeyboard } from 'grammy';
import { s1Keyboard } from '../keyboards.ts';
import { s1Text } from '../texts.ts';

export interface S1View {
  text: string;
  keyboard: InlineKeyboard;
}

/** S1 is pure: counts come from the caller so the renderer stays testable. */
export function s1View(params: { userId: number; sourceCount: number; limit: number; trialEnabled: boolean }): S1View {
  return { text: s1Text(params), keyboard: s1Keyboard(params.sourceCount, params.limit) };
}
