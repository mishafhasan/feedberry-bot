import { InlineKeyboard } from 'grammy';
import type { SourceCard } from '../../db/repos/subscriptions.ts';
import { t, type Lang } from '../i18n/index.ts';
import { CHIPS, esc } from '../texts.ts';
import { PAGE_SIZE } from './my-sources.ts';

/** S16 cadence choices in minutes; `null` (sent as 0) is the 08:00/20:00 default of §4.3. */
export const SCHEDULE_OPTIONS: readonly number[] = [15, 30, 60, 180, 360, 720, 1440];

export interface ScheduleView {
  text: string;
  keyboard: InlineKeyboard;
}

export function cadenceValue(minutes: number, lang: Lang = 'en'): string {
  return minutes % 60 === 0 ? t(lang, 'unit.hours', { n: minutes / 60 }) : t(lang, 'unit.minutes', { n: minutes });
}

export function cadenceLabel(minutes: number | null, lang: Lang = 'en'): string {
  return minutes === null ? t(lang, 'schedule.default') : t(lang, 'schedule.every', { value: cadenceValue(minutes, lang) });
}

/** The list: one button per source carrying its current cadence, then the pager. */
export function scheduleListView(params: { cards: SourceCard[]; offset: number; total: number; page: number; lang?: Lang }): ScheduleView {
  const lang = params.lang ?? 'en';
  const pages = Math.max(1, Math.ceil(params.total / PAGE_SIZE));

  const lines = [t(lang, 'schedule.title')];
  if (params.total === 0) lines.push('', t(lang, 'schedule.empty'));
  else lines.push('', t(lang, 'schedule.hint'), '', t(lang, 's7.showing', { from: params.offset + 1, to: params.offset + params.cards.length, total: params.total }));

  const keyboard = new InlineKeyboard();
  for (const card of params.cards) {
    keyboard.text(`${CHIPS[card.platform] ?? card.platform} · ${short(card.title ?? `#${card.source_id}`)} · ${cadenceLabel(card.interval_minutes, lang)}`, `src:sched:${card.source_id}`).row();
  }
  // One bulk row, then the pager: every source at once is a single tap away.
  if (params.total > 0) keyboard.row().text(t(lang, 'schedule.allSources'), 'sched:all');
  if (pages > 1) {
    if (params.page > 0) keyboard.text('‹', `sched:page:${params.page - 1}`);
    if (params.page < pages - 1) keyboard.text('›', `sched:page:${params.page + 1}`);
    keyboard.row();
  }
  keyboard.text(t(lang, 'btn.home'), 'nav:home');

  return { text: lines.join('\n'), keyboard };
}

/** The picker: default first, then each interval; the active one is marked. `null` means all sources. */
export function schedulePickerView(card: SourceCard | null, lang: Lang = 'en'): ScheduleView {
  const text = card
    ? [
        t(lang, 'schedule.title'),
        '',
        `${CHIPS[card.platform] ?? card.platform} · ${esc(card.title ?? `#${card.source_id}`)}`,
        t(lang, 'schedule.current', { cadence: cadenceLabel(card.interval_minutes, lang) }),
        '',
        t(lang, 'schedule.pickerHint'),
        '',
        t(lang, 'schedule.shared'),
      ].join('\n')
    : [t(lang, 'schedule.title'), '', t(lang, 'schedule.allTitle'), t(lang, 'schedule.allHint'), '', t(lang, 'schedule.shared')].join('\n');

  const keyboard = new InlineKeyboard();
  const mark = (active: boolean): string => (active ? '✅ ' : '');
  const target = card === null ? 'sched:setall' : `sched:set:${card.source_id}`;
  keyboard.text(`${mark(card?.interval_minutes === null)}${t(lang, 'schedule.defaultOption')}`, `${target}:0`).row();
  for (const minutes of SCHEDULE_OPTIONS) {
    keyboard.text(`${mark(card?.interval_minutes === minutes)}${t(lang, 'schedule.setEvery', { value: cadenceValue(minutes, lang) })}`, `${target}:${minutes}`).row();
  }
  keyboard.text(t(lang, 'btn.back'), 'menu:schedule');

  return { text, keyboard };
}

/** Button labels are plain text with a length budget; the title gets the space that is left. */
function short(title: string, max = 32): string {
  return title.length <= max ? title : `${title.slice(0, max - 1)}…`;
}
