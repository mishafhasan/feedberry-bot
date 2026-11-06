import { InlineKeyboard } from 'grammy';
import { CONTENT_KINDS, type ContentKind } from '../../platform/content-types.ts';
import { t, type Lang } from '../i18n/index.ts';
import { esc } from '../texts.ts';

export interface TypePickerView {
  text: string;
  keyboard: InlineKeyboard;
}

/**
 * S18 — what a YouTube channel is allowed to send. One screen for every entry point: adding a
 * channel, a download that names one, and a My Sources card. Every kind starts on, so "everything"
 * is one tap and nothing is assumed behind the user's back.
 */
export function s18View(params: { handle: string; selected: ContentKind[]; lang?: Lang }): TypePickerView {
  const lang = params.lang ?? 'en';
  const on = (kind: ContentKind): boolean => params.selected.includes(kind);

  const lines = [
    t(lang, 'types.title', { handle: esc(params.handle) }),
    '',
    t(lang, 'types.hint'),
    '',
    ...CONTENT_KINDS.map((kind) => `${on(kind) ? '✅' : '▫️'} ${t(lang, `types.${kind}`)} — ${t(lang, `types.${kind}.note`)}`),
  ];

  const keyboard = new InlineKeyboard();
  for (const kind of CONTENT_KINDS) keyboard.text(`${on(kind) ? '✅' : '☐'} ${t(lang, `types.${kind}`)}`, `ct:t:${kind}`).row();
  // The requested "All content" is a preset, not a fourth kind: the toggles stay for a mix.
  keyboard.text(t(lang, 'types.all'), 'ct:all').row();
  keyboard.text(t(lang, 'types.done'), 'ct:done').row();
  keyboard.text(t(lang, 'btn.back'), 'ct:back');

  return { text: lines.join('\n'), keyboard };
}
