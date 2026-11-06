import { InlineKeyboard } from 'grammy';
import { CONTENT_KINDS, type ContentKind } from '../../platform/content-types.ts';
import { t, type Lang } from '../i18n/index.ts';
import { esc } from '../texts.ts';

/** A rich message: the body carries the formatting and the chips, the keyboard closes the screen. */
export interface TypePickerView {
  html: string;
  keyboard: InlineKeyboard;
}

/**
 * S18 — what a YouTube channel is allowed to send. One screen for every entry point: adding a
 * channel, a download that names one, and a My Sources card. Every kind starts on, so "everything"
 * is one tap and nothing is assumed behind the user's back.
 *
 * Three chips share one row and carry their own state (a check plus the accent style), so the screen
 * is one row of choices plus one row of actions instead of six stacked buttons.
 */
export function s18View(params: { handle: string; selected: ContentKind[]; lang?: Lang }): TypePickerView {
  const lang = params.lang ?? 'en';
  const on = (kind: ContentKind): boolean => params.selected.includes(kind);
  const name = (kind: ContentKind): string => t(lang, `types.${kind}`);

  const chip = (kind: ContentKind): string =>
    `<tg-button type="callback_data"${on(kind) ? ' style="primary"' : ''} data="ct:t:${kind}">${on(kind) ? '✓ ' : ''}${name(kind)}</tg-button>`;
  const sends = CONTENT_KINDS.filter(on).map(name).join(', ');

  return {
    html: [
      `<p><b>${t(lang, 'types.title', { handle: esc(params.handle) })}</b><br/>${t(lang, 'types.hint')}</p>`,
      `<tg-button-row align="left">${CONTENT_KINDS.map(chip).join('')}</tg-button-row>`,
      `<p>${t(lang, 'types.sends', { kinds: sends })}</p>`,
      `<tg-button-row align="left"><tg-button type="callback_data" data="ct:all">${t(lang, 'types.all')}</tg-button></tg-button-row>`,
    ].join(''),
    // Done closes the screen, so it sits at the bottom of the message, directly above Back.
    keyboard: new InlineKeyboard().text(t(lang, 'types.done'), 'ct:done').row().text(t(lang, 'btn.back'), 'ct:back'),
  };
}
