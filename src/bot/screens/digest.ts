import { InlineKeyboard } from 'grammy';
import type { ChatRow } from '../../db/repos/chats.ts';
import type { DigestRow } from '../../db/repos/digests.ts';
import type { SourceCard } from '../../db/repos/subscriptions.ts';
import { t, type Lang } from '../i18n/index.ts';
import { esc, platformIcon } from '../texts.ts';
import { PAGE_SIZE } from './my-sources.ts';

/** ADR-029 settings screens: plain text plus a keyboard, like the schedule screens they sit beside. */
export interface DigestView {
  text: string;
  keyboard: InlineKeyboard;
}

/** `08:00` for hour 8; the digest only ever fires on the hour. */
export const hourLabel = (hour: number): string => `${String(hour).padStart(2, '0')}:00`;

/** The one screen that carries status; its buttons reach every setting. */
export function digestView(params: { digest: DigestRow; chatTitle: string; sourceCount: number; lang?: Lang; notice?: string }): DigestView {
  const lang = params.lang ?? 'en';
  const langName = params.digest.lang === 'ta' ? t(lang, 'digest.langNameTa') : t(lang, 'digest.langNameEn');
  const lines = [
    `<b>${esc(t(lang, 'digest.title'))}</b>`,
    `<i>${esc(t(lang, 'digest.lead'))}</i>`,
    '',
    esc(t(lang, 'digest.status', { status: t(lang, params.digest.enabled === 1 ? 'digest.on' : 'digest.off') })),
    esc(t(lang, 'digest.chat', { chat: params.chatTitle })),
    esc(t(lang, 'digest.language', { language: langName })),
    esc(t(lang, 'digest.time', { time: hourLabel(params.digest.hour) })),
    esc(t(lang, 'digest.sources', { n: params.sourceCount })),
  ];
  if (params.notice !== undefined) lines.push('', `⚠️ ${esc(params.notice)}`);

  const id = params.digest.id;
  const keyboard = new InlineKeyboard()
    .text(t(lang, 'digest.btnSources'), `dg:src:${id}:0`)
    .text(t(lang, 'digest.btnLanguage'), `dg:lang:${id}`)
    .row()
    .text(t(lang, 'digest.btnTime'), `dg:time:${id}`)
    .row()
    .text(t(lang, params.digest.enabled === 1 ? 'digest.disable' : 'digest.enable'), `dg:on:${id}`)
    .row()
    .text(t(lang, 'btn.home'), 'nav:home');

  return { text: lines.join('\n'), keyboard };
}

/** One button per RSS subscription; the ✅ is the digest's choice, not the subscription's state. */
export function digestSourcesView(params: { cards: Array<SourceCard & { selected: number }>; total: number; page: number; digestId: number; lang?: Lang }): DigestView {
  const lang = params.lang ?? 'en';
  const pages = Math.max(1, Math.ceil(params.total / PAGE_SIZE));
  const lines = [`<b>${esc(t(lang, 'digest.sourcesTitle'))}</b>`, `<i>${esc(t(lang, 'digest.sourcesLead'))}</i>`, ''];
  if (params.total === 0) lines.push(esc(t(lang, 'digest.sourcesEmpty')));
  else lines.push(esc(t(lang, 's7.showing', { from: params.page * PAGE_SIZE + 1, to: params.page * PAGE_SIZE + params.cards.length, total: params.total })));

  const keyboard = new InlineKeyboard();
  for (const card of params.cards) {
    const label = `${card.selected === 1 ? '✅' : '⬜'} ${platformIcon(card.platform)} ${short(card.title ?? `#${card.source_id}`)}`;
    keyboard.text(label, `dg:tg:${params.digestId}:${card.subscription_id}`).row();
  }
  if (pages > 1) {
    if (params.page > 0) keyboard.text('‹', `dg:page:${params.digestId}:${params.page - 1}`);
    if (params.page < pages - 1) keyboard.text('›', `dg:page:${params.digestId}:${params.page + 1}`);
    keyboard.row();
  }
  keyboard.text(t(lang, 'btn.back'), `dg:open:${params.digestId}`);
  return { text: lines.join('\n'), keyboard };
}

/** Two choices only; the digest's content language is not the interface language. */
export function digestLanguageView(params: { digestId: number; current: string; lang?: Lang }): DigestView {
  const lang = params.lang ?? 'en';
  const mark = (code: string): string => (params.current === code ? '✅ ' : '');
  const keyboard = new InlineKeyboard()
    .text(`${mark('en')}${t(lang, 'digest.langNameEn')}`, `dg:setlang:${params.digestId}:en`)
    .row()
    .text(`${mark('ta')}${t(lang, 'digest.langNameTa')}`, `dg:setlang:${params.digestId}:ta`)
    .row()
    .text(t(lang, 'btn.back'), `dg:open:${params.digestId}`);
  return { text: `<b>${esc(t(lang, 'digest.languageTitle'))}</b>\n<i>${esc(t(lang, 'digest.languageLead'))}</i>`, keyboard };
}

/** 24 hours, four per row; the owner's zone decides what the hour means. */
export function digestTimeView(params: { digest: DigestRow; tz: string; lang?: Lang }): DigestView {
  const lang = params.lang ?? 'en';
  const keyboard = new InlineKeyboard();
  for (let hour = 0; hour < 24; hour++) {
    keyboard.text(`${params.digest.hour === hour ? '✅ ' : ''}${hourLabel(hour)}`, `dg:sethour:${params.digest.id}:${hour}`);
    if (hour % 4 === 3) keyboard.row();
  }
  keyboard.text(t(lang, 'btn.back'), `dg:open:${params.digest.id}`);
  const text = [`<b>${esc(t(lang, 'digest.timeTitle'))}</b>`, `<i>${esc(t(lang, 'digest.timeLead', { tz: params.tz }))}</i>`, '', esc(t(lang, 'digest.time', { time: hourLabel(params.digest.hour) }))].join('\n');
  return { text, keyboard };
}

/** Only shown when the user delivers to more than their own chat. */
export function digestChatView(params: { chats: ChatRow[]; lang?: Lang }): DigestView {
  const lang = params.lang ?? 'en';
  const keyboard = new InlineKeyboard();
  for (const chat of params.chats) {
    const icon = chat.type === 'private' ? '👤' : chat.type === 'channel' ? '📢' : '👥';
    keyboard.text(`${icon} ${short(chat.title ?? t(lang, 'btn.personal'))}`, `dg:chat:${chat.id}`).row();
  }
  keyboard.text(t(lang, 'btn.back'), 'nav:home');
  return { text: `<b>${esc(t(lang, 'digest.chooseChat'))}</b>`, keyboard };
}

/** Button labels are plain text with a length budget, as on the sources list. */
function short(title: string, max = 32): string {
  return title.length <= max ? title : `${title.slice(0, max - 1)}…`;
}
