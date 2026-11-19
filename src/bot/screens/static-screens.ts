import type { InlineKeyboard } from 'grammy';
import { languageKeyboard, menuKeyboard, settingsKeyboard, timezoneKeyboard } from '../keyboards.ts';
import { aboutText, esc, helpText } from '../texts.ts';
import { t, type Lang } from '../i18n/index.ts';

export interface InfoView {
  text: string;
  keyboard: InlineKeyboard;
}

/** S13 — Help (menu:help). Settings opens it with a Back-to-Settings keyboard; the notice keeps Home. */
export function helpView(lang: Lang = 'en', keyboard: InlineKeyboard = menuKeyboard(lang)): InfoView {
  return { text: helpText(lang), keyboard };
}

/** S14 — About (/about, set:about). */
export function aboutView(userId: number, lang: Lang = 'en', keyboard: InlineKeyboard = menuKeyboard(lang)): InfoView {
  return { text: aboutText(userId, lang), keyboard };
}

/** S15 — Interface language (/language, menu:language). */
export function languageView(lang: Lang = 'en'): InfoView {
  return { text: t(lang, 'language.title'), keyboard: languageKeyboard() };
}

/** S19 — Settings hub (menu:settings, /settings). It names the live zone, so the hub answers "which clock?". */
export function settingsView(tz: string, lang: Lang = 'en'): InfoView {
  const lines = [`<b>${esc(t(lang, 'settings.title'))}</b>`, '', esc(t(lang, 'settings.timezone', { tz }))];
  return { text: lines.join('\n'), keyboard: settingsKeyboard(lang) };
}

/** S20 — Set timezone (set:tz): the one screen that moves every schedule the user has. */
export function timezoneView(tz: string, lang: Lang = 'en'): InfoView {
  return { text: `<b>${esc(t(lang, 'tz.title'))}</b>\n<i>${esc(t(lang, 'tz.lead', { tz }))}</i>`, keyboard: timezoneKeyboard(tz, lang) };
}
