import { Keyboard } from 'grammy';
import { t, type Lang } from './i18n/index.ts';

/**
 * The custom keyboard under the message box (ReplyKeyboardMarkup). Telegram replaces the user's
 * system keyboard with these buttons; each tap sends its own label back as a normal message, which
 * is why the router matches on text. It stays visible until it is removed, so "Hide menu" is part
 * of the layout rather than a hidden gesture.
 */
export function replyMenu(lang: Lang = 'en'): Keyboard {
  return new Keyboard()
    .text(t(lang, 'btn.add'))
    .text(t(lang, 'btn.sources'))
    .row()
    .text(t(lang, 'btn.supported'))
    .text(t(lang, 'btn.help'))
    .row()
    .text(t(lang, 'btn.download'))
    .text(t(lang, 'btn.schedule'))
    .row()
    .text(t(lang, 'btn.hideMenu'))
    .resized()
    .persistent();
}

/** ReplyKeyboardRemove: the keyboard folds away and the system one comes back. */
export const hiddenMenu = { remove_keyboard: true } as const;

/** Label -> action. Built per language so a tapped button is matched in the user's own words. */
export function menuLabels(lang: Lang = 'en'): Map<string, 'add' | 'sources' | 'supported' | 'help' | 'download' | 'schedule' | 'hide'> {
  return new Map([
    [t(lang, 'btn.add'), 'add'],
    [t(lang, 'btn.sources'), 'sources'],
    [t(lang, 'btn.supported'), 'supported'],
    [t(lang, 'btn.help'), 'help'],
    [t(lang, 'btn.download'), 'download'],
    [t(lang, 'btn.schedule'), 'schedule'],
    [t(lang, 'btn.hideMenu'), 'hide'],
  ]);
}
