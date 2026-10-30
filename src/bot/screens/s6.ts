import type { InlineKeyboard } from 'grammy';
import { s6Keyboard } from '../keyboards.ts';
import { s6Text } from '../texts.ts';

export interface S6View {
  text: string;
  keyboard: InlineKeyboard;
}

export function s6View(title: string): S6View {
  return { text: s6Text(title), keyboard: s6Keyboard() };
}
