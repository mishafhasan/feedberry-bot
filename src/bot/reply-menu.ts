import { Keyboard } from 'grammy';
import { t, type Lang } from './i18n/index.ts';

/**
 * The custom keyboard under the message box (ReplyKeyboardMarkup). Telegram replaces the user's
 * system keyboard with these buttons; each tap sends its own label back as a normal message, which
 * is why the router matches on text. Hiding it is Telegram's own keyboard icon in the input area,
 * which only exists when the markup is *not* persistent (Bot API `is_persistent`), so no "Hide menu"
 * row is needed — and none may be added back without losing that toggle.
 * `/start` installs it in its own notice (one message carries one markup). The labels stay mapped
 * so a phone that still holds an older keyboard keeps working, and the retired `Hide menu` row
 * heals into this one.
 */
export function replyMenu(lang: Lang = 'en'): Keyboard {
  return new Keyboard()
    .text(t(lang, 'btn.add'))
    .text(t(lang, 'btn.sources'))
    .row()
    .text(t(lang, 'btn.filter'))
    .text(t(lang, 'btn.help'))
    .row()
    .text(t(lang, 'btn.download'))
    .text(t(lang, 'btn.schedule'))
    .resized();
}

/** Label -> action. Built per language so a tapped button is matched in the user's own words. */
export type MenuAction = 'add' | 'sources' | 'filter' | 'supported' | 'help' | 'download' | 'schedule';

export function menuLabels(lang: Lang = 'en'): Map<string, MenuAction> {
  return new Map<string, MenuAction>([
    [t(lang, 'btn.add'), 'add'],
    [t(lang, 'btn.sources'), 'sources'],
    [t(lang, 'btn.filter'), 'filter'],
    [t(lang, 'btn.help'), 'help'],
    [t(lang, 'btn.download'), 'download'],
    [t(lang, 'btn.schedule'), 'schedule'],
    // A phone still showing the previous keyboard sends this label; Supported Sites keeps a handler.
    [t(lang, 'btn.supported'), 'supported'],
  ]);
}
