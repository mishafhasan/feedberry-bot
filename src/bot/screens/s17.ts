import { InlineKeyboard } from 'grammy';
import type { AccessRequest } from '../../db/repos/events.ts';
import type { UserListItem, UserRow } from '../../db/repos/users.ts';
import { t, type Lang } from '../i18n/index.ts';
import { CHIPS, esc } from '../texts.ts';
import { PAGE_SIZE } from './s7.ts';

/** callback_data for the admin panel; `adm:` is routed before every other prefix. */
export const ADM = {
  prefix: 'adm:',
  home: 'adm:home',
  users: 'adm:users:',
  user: 'adm:user:',
  add: 'adm:add',
  allow: 'adm:allow:',
  block: 'adm:block:',
  unblock: 'adm:unblock:',
  msg: 'adm:msg',
  msgPick: 'adm:msgpick:',
  msgTo: 'adm:msg:',
  msgSend: 'adm:msgsend',
  all: 'adm:all',
  allYes: 'adm:all:yes',
} as const;

export interface AdminView {
  text: string;
  keyboard: InlineKeyboard;
}

/** Only the three known statuses get a translation; an unknown one prints as stored and is still denied. */
export function statusLabel(status: string, lang: Lang = 'en'): string {
  return status === 'allowed' || status === 'pending' || status === 'blocked' ? t(lang, `adm.status.${status}`) : status;
}

export function adminOverviewView(params: {
  stats: { all: number; allowed: number; pending: number; blocked: number };
  sources: number;
  requests: AccessRequest[];
  lang?: Lang;
}): AdminView {
  const lang = params.lang ?? 'en';
  const lines = [t(lang, 'adm.title'), '', t(lang, 'adm.stats', { ...params.stats, sources: params.sources }), '', t(lang, 'adm.requests.title')];
  if (params.requests.length === 0) lines.push(t(lang, 'adm.requests.none'));
  for (const request of params.requests) {
    lines.push(t(lang, 'adm.request.row', { id: request.tg_user_id, who: esc(request.username ?? '') }));
  }

  const keyboard = new InlineKeyboard()
    .text(t(lang, 'adm.btn.users'), `${ADM.users}0`)
    .text(t(lang, 'adm.btn.add'), ADM.add)
    .row()
    .text(t(lang, 'adm.btn.notify'), ADM.msg)
    .text(t(lang, 'adm.btn.notifyAll'), ADM.all)
    .row()
    .text(t(lang, 'btn.home'), 'nav:home');

  return { text: lines.join('\n'), keyboard };
}

/** Page size matches S7/S16, so every list in this bot pages the same way. */
export function adminUsersView(params: { rows: UserListItem[]; offset: number; total: number; page: number; lang?: Lang; mode?: 'details' | 'notify' }): AdminView {
  const lang = params.lang ?? 'en';
  const pages = Math.max(1, Math.ceil(params.total / PAGE_SIZE));
  const notify = params.mode === 'notify';
  const lines = [notify ? t(lang, 'adm.notify.pick') : t(lang, 'adm.users.title')];
  if (params.total === 0) lines.push('', t(lang, 'adm.users.empty'));
  else lines.push('', t(lang, 'adm.users.showing', { from: params.offset + 1, to: params.offset + params.rows.length, total: params.total }));

  const keyboard = new InlineKeyboard();
  for (const row of params.rows) {
    keyboard
      .text(t(lang, 'adm.users.row', { id: row.tg_user_id, status: statusLabel(row.status, lang), sources: row.source_count }), `${notify ? ADM.msgTo : ADM.user}${row.tg_user_id}`)
      .row();
  }
  if (pages > 1) {
    if (params.page > 0) keyboard.text('‹', `${notify ? ADM.msgPick : ADM.users}${params.page - 1}`);
    if (params.page < pages - 1) keyboard.text('›', `${notify ? ADM.msgPick : ADM.users}${params.page + 1}`);
    keyboard.row();
  }
  keyboard.text(t(lang, 'btn.back'), ADM.home);

  return { text: lines.join('\n'), keyboard };
}

export function adminUserView(params: {
  user: UserRow;
  sources: Array<{ platform: string; title: string | null }>;
  backPage: number;
  lang?: Lang;
}): AdminView {
  const lang = params.lang ?? 'en';
  const { user } = params;
  const lines = [
    t(lang, 'adm.user.title', { id: user.tg_user_id }),
    '',
    t(lang, 'adm.user.status', { status: statusLabel(user.status, lang) }),
    t(lang, 'adm.user.locale', { locale: user.locale ?? 'en' }),
    t(lang, 'adm.user.created', { date: new Date(user.created_at).toISOString().slice(0, 10) }),
    '',
    t(lang, 'adm.user.sources', { count: params.sources.length }),
  ];
  if (params.sources.length === 0) lines.push(t(lang, 'adm.user.noSources'));
  for (const source of params.sources) {
    lines.push(t(lang, 'adm.user.sourceRow', { platform: CHIPS[source.platform] ?? source.platform, title: esc(source.title ?? '—') }));
  }

  const keyboard = new InlineKeyboard()
    .text(t(lang, 'adm.btn.allow'), `${ADM.allow}${user.tg_user_id}`)
    .text(t(lang, 'adm.btn.block'), `${ADM.block}${user.tg_user_id}`)
    .row()
    .text(t(lang, 'adm.btn.unblock'), `${ADM.unblock}${user.tg_user_id}`)
    .text(t(lang, 'adm.btn.notifyUser'), `${ADM.msgTo}${user.tg_user_id}`)
    .row()
    .text(t(lang, 'btn.back'), `${ADM.users}${params.backPage}`);

  return { text: lines.join('\n'), keyboard };
}

/** A text-input step: the prompt plus a way out without sending anything. */
export function adminPromptView(text: string, lang: Lang = 'en'): AdminView {
  return { text, keyboard: new InlineKeyboard().text(t(lang, 'btn.back'), ADM.home) };
}

/** The text step ends here: the admin sees the exact message before anything is sent. */
export function adminConfirmSendView(params: { title: string; draft: string; confirmData: string; lang?: Lang }): AdminView {
  const lang = params.lang ?? 'en';
  // Telegram refuses an edit over 4096 chars; the draft itself is sent whole by TelegramSender.
  const preview = params.draft.length > 800 ? `${params.draft.slice(0, 799)}…` : params.draft;
  return {
    text: `${params.title}\n\n${esc(preview)}`,
    keyboard: new InlineKeyboard().text(t(lang, 'adm.btn.send'), params.confirmData).row().text(t(lang, 'btn.cancel'), ADM.home),
  };
}
