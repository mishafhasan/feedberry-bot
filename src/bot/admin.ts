import { GrammyError, type Context } from 'grammy';
import type { BotDeps } from './callbacks.ts';
import { getSession, resetSession, setSession } from './fsm.ts';
import { t, langFor } from './i18n/index.ts';
import { isAdmin } from './access.ts';
import { listSourcesForUser } from '../db/repos/subscriptions.ts';
import { findAccessRequestByUsername, recentAccessRequests, recordEvent } from '../db/repos/events.ts';
import { countSources } from '../db/repos/sources.ts';
import { getUser, listAllowedTgIds, listUsers, setUserStatus, upsertAllowedUser, userStats } from '../db/repos/users.ts';
import { log } from '../obs/log.ts';
import { isCoded } from '../platform/errors.ts';
import { senderTarget } from '../telegram/api.ts';
import { esc } from './texts.ts';
import { ADM, adminConfirmSendView, adminOverviewView, adminPromptView, adminUserView, adminUsersView, type AdminView } from './screens/s17.ts';
import { PAGE_SIZE } from './screens/s7.ts';

/** The panel is operator-facing and English-only; users keep their own language. */
const LANG = 'en' as const;
/** Access requests listed on the overview, so the admin has ids to approve. */
const RECENT_REQUESTS = 5;

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export async function openAdminPanel(ctx: Context, deps: BotDeps): Promise<void> {
  await paint(ctx, overview(deps));
}

/** `adm:*`: every branch re-checks the admin id, so a forged callback from another user does nothing. */
export async function handleAdminCallback(ctx: Context, deps: BotDeps, userId: number, data: string): Promise<void> {
  if (!isAdmin(deps.cfg, userId)) {
    await ctx.answerCallbackQuery({ text: t(LANG, 'adm.toast.unknown') }).catch(() => {});
    return;
  }

  const toast =
    data.startsWith(ADM.allow) || data.startsWith(ADM.unblock)
      ? t(LANG, 'adm.toast.allowed')
      : data.startsWith(ADM.block)
        ? t(LANG, 'adm.toast.blocked')
        : undefined;
  await ctx.answerCallbackQuery(toast === undefined ? undefined : { text: toast });

  if (data === ADM.home) {
    // Cancel/Back drops the draft and target too, or a stale Send button could still fire.
    resetSession(userId);
    return paint(ctx, overview(deps));
  }
  if (data === ADM.add) {
    setSession(userId, { state: 'awaiting_admin_user_id' });
    return paint(ctx, adminPromptView(t(LANG, 'adm.add.prompt')));
  }
  if (data === ADM.msg) return showNotifyPicker(ctx, deps, userId, 0);
  if (data.startsWith(ADM.msgPick)) return showNotifyPicker(ctx, deps, userId, idOf(data, ADM.msgPick));
  if (data === ADM.all) {
    setSession(userId, { state: 'awaiting_admin_notify_all', adminDraft: undefined, adminTarget: undefined });
    return paint(ctx, adminPromptView(t(LANG, 'adm.all.prompt')));
  }
  if (data === ADM.allYes) return confirmNotifyAll(ctx, deps, userId);
  if (data === ADM.msgSend) return confirmNotifyUser(ctx, deps, userId);
  if (data.startsWith(ADM.users)) return showUsers(ctx, deps, userId, idOf(data, ADM.users));
  if (data.startsWith(ADM.user)) return showUser(ctx, deps, userId, idOf(data, ADM.user));
  if (data.startsWith(ADM.allow) || data.startsWith(ADM.unblock)) {
    const allowed = data.startsWith(ADM.allow);
    const target = idOf(data, allowed ? ADM.allow : ADM.unblock);
    setUserStatus(deps.db, target, 'allowed');
    log('info', 'admin_user_allowed', { user: target, by: userId });
    await notifyAccess(deps, target, allowed ? 'notice.access.allowed' : 'notice.access.unblocked');
    return showUser(ctx, deps, userId, target);
  }
  if (data.startsWith(ADM.block)) {
    const target = idOf(data, ADM.block);
    setUserStatus(deps.db, target, 'blocked');
    // Blocking must cut the user off now: the gate re-reads the row, and this drops their flow.
    resetSession(target);
    log('info', 'admin_user_blocked', { user: target, by: userId });
    await notifyAccess(deps, target, 'notice.access.blocked');
    return showUser(ctx, deps, userId, target);
  }
  if (data.startsWith(ADM.msgTo)) {
    const target = idOf(data, ADM.msgTo);
    setSession(userId, { state: 'awaiting_admin_notify', adminTarget: target, adminDraft: undefined });
    return paint(ctx, adminPromptView(t(LANG, 'adm.msg.prompt', { id: target })));
  }
  log('warn', 'adm_callback_unknown', { data, user: userId });
}

/** Admin text input, checked before the reply-menu and the source-link flow. */
export async function handleAdminInput(ctx: Context, deps: BotDeps, userId: number): Promise<boolean> {
  if (!isAdmin(deps.cfg, userId)) return false;
  const text = ctx.message?.text?.trim();
  if (text === undefined || text === '') return false;

  const { state, adminTarget } = getSession(userId);
  switch (state) {
    case 'awaiting_admin_user_id':
      await addUser(ctx, deps, userId, text);
      return true;
    case 'awaiting_admin_notify':
    case 'confirming_admin_notify': {
      if (adminTarget === undefined) return false;
      setSession(userId, { state: 'confirming_admin_notify', adminDraft: text });
      const view = adminConfirmSendView({ title: t(LANG, 'adm.msg.confirm', { id: adminTarget }), draft: text, confirmData: ADM.msgSend });
      await paint(ctx, view);
      return true;
    }
    case 'awaiting_admin_notify_all':
    case 'confirming_admin_notify_all':
      setSession(userId, { state: 'confirming_admin_notify_all', adminDraft: text });
      await paint(ctx, adminConfirmSendView({ title: t(LANG, 'adm.all.confirm'), draft: text, confirmData: ADM.allYes }));
      return true;
    default:
      return false;
  }
}

/** Accepts a numeric id, or an @username the user already quoted in an access request. */
function targetId(deps: BotDeps, text: string): number | null {
  if (/^\d+$/.test(text)) {
    const id = Number(text);
    return id > 0 ? id : null;
  }
  return text.startsWith('@') ? findAccessRequestByUsername(deps.db, text) : null;
}

/** Lookup before the row exists: getChat proves the id is a user the bot can reach. */
async function addUser(ctx: Context, deps: BotDeps, adminId: number, text: string): Promise<void> {
  const id = targetId(deps, text);
  if (id === null) {
    await ctx.reply(t(LANG, 'adm.add.invalid'));
    return;
  }

  try {
    const chat = await ctx.api.getChat(id);
    if (chat.type !== 'private') throw new Error(`chat type ${chat.type}`);
  } catch (err) {
    log('warn', 'admin_add_user_failed', { user: id, cause: message(err) });
    await ctx.reply(t(LANG, 'adm.add.failed'));
    return;
  }

  upsertAllowedUser(deps.db, id);
  log('info', 'admin_user_allowed', { user: id, by: adminId });
  await notifyAccess(deps, id, 'notice.access.allowed');
  resetSession(adminId);
  await ctx.reply(t(LANG, 'adm.add.done', { id }), { parse_mode: 'HTML' });
  const view = userDetails(deps, adminId, id);
  if (view !== null) await ctx.reply(view.text, { parse_mode: 'HTML', reply_markup: view.keyboard });
}

/** Overview → a paginated picker of every known user, not just the allowed ones. */
async function showNotifyPicker(ctx: Context, deps: BotDeps, adminId: number, page: number): Promise<void> {
  let pageIndex = Math.max(0, page);
  let { rows, total } = listUsers(deps.db, PAGE_SIZE, pageIndex * PAGE_SIZE);
  if (rows.length === 0 && pageIndex > 0) {
    pageIndex = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1);
    ({ rows, total } = listUsers(deps.db, PAGE_SIZE, pageIndex * PAGE_SIZE));
  }
  setSession(adminId, { state: 'idle', adm: { page: pageIndex } });
  await paint(ctx, adminUsersView({ rows, offset: pageIndex * PAGE_SIZE, total, page: pageIndex, mode: 'notify' }));
}

async function confirmNotifyUser(ctx: Context, deps: BotDeps, adminId: number): Promise<void> {
  const session = getSession(adminId);
  if (session.state !== 'confirming_admin_notify' || session.adminTarget === undefined || session.adminDraft === undefined) {
    resetSession(adminId);
    return paint(ctx, overview(deps));
  }
  await notifyUser(ctx, deps, adminId, session.adminTarget, session.adminDraft);
}

async function confirmNotifyAll(ctx: Context, deps: BotDeps, adminId: number): Promise<void> {
  const session = getSession(adminId);
  if (session.state !== 'confirming_admin_notify_all' || session.adminDraft === undefined) {
    resetSession(adminId);
    return paint(ctx, overview(deps));
  }
  await notifyAll(ctx, deps, adminId, session.adminDraft);
}

type AccessNotice = 'notice.access.allowed' | 'notice.access.blocked' | 'notice.access.unblocked';

/** A decision reaches the user too; a 403 is logged, never allowed to break the panel. */
async function notifyAccess(deps: BotDeps, target: number, key: AccessNotice): Promise<void> {
  const lang = langFor(getUser(deps.db, target)?.locale);
  try {
    await deps.sender.sendText(senderTarget(target), t(lang, key));
    log('info', 'admin_access_notice', { user: target, notice: key });
  } catch (err) {
    log('warn', 'admin_access_notice_failed', { user: target, notice: key, reason: isCoded(err) ? err.code : message(err) });
  }
}

async function notifyUser(ctx: Context, deps: BotDeps, adminId: number, target: number, text: string): Promise<void> {
  resetSession(adminId);
  try {
    // sendText owns the pacing and turns a 403 into E_TG_FORBIDDEN; a blocked bot must not crash the panel.
    await deps.sender.sendText(senderTarget(target), esc(text));
    recordEvent(deps.db, { level: 'info', code: 'admin_notify', chatId: target, detail: 'sent' });
    await ctx.reply(t(LANG, 'adm.msg.sent', { id: target }), { parse_mode: 'HTML' });
  } catch (err) {
    const reason = isCoded(err) ? err.code : message(err);
    recordEvent(deps.db, { level: 'warn', code: 'admin_notify', chatId: target, detail: `failed:${reason}` });
    log('warn', 'admin_notify_failed', { target, reason });
    await ctx.reply(t(LANG, 'adm.msg.failed', { id: target, reason }), { parse_mode: 'HTML' });
  }
  await replyOverview(ctx, deps);
}

async function notifyAll(ctx: Context, deps: BotDeps, adminId: number, text: string): Promise<void> {
  resetSession(adminId);
  let sent = 0;
  let failed = 0;
  // Sequential on purpose: the shared limiter paces each send, and one 403 must not stop the rest.
  for (const target of listAllowedTgIds(deps.db)) {
    try {
      await deps.sender.sendText(senderTarget(target), esc(text));
      sent += 1;
    } catch (err) {
      failed += 1;
      log('warn', 'admin_notify_failed', { target, reason: isCoded(err) ? err.code : message(err) });
    }
  }
  recordEvent(deps.db, { level: 'info', code: 'admin_notify_all', detail: `sent:${sent} failed:${failed}` });
  log('info', 'admin_notify_all', { sent, failed });
  await ctx.reply(t(LANG, 'adm.all.done', { sent, failed }), { parse_mode: 'HTML' });
  await replyOverview(ctx, deps);
}

function overview(deps: BotDeps): AdminView {
  return adminOverviewView({ stats: userStats(deps.db), sources: countSources(deps.db), requests: recentAccessRequests(deps.db, RECENT_REQUESTS) });
}

async function replyOverview(ctx: Context, deps: BotDeps): Promise<void> {
  const view = overview(deps);
  await ctx.reply(view.text, { parse_mode: 'HTML', reply_markup: view.keyboard });
}

async function showUsers(ctx: Context, deps: BotDeps, adminId: number, page: number): Promise<void> {
  let pageIndex = Math.max(0, page);
  let { rows, total } = listUsers(deps.db, PAGE_SIZE, pageIndex * PAGE_SIZE);
  if (rows.length === 0 && pageIndex > 0) {
    pageIndex = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1);
    ({ rows, total } = listUsers(deps.db, PAGE_SIZE, pageIndex * PAGE_SIZE));
  }
  setSession(adminId, { state: 'idle', adm: { page: pageIndex } });
  await paint(ctx, adminUsersView({ rows, offset: pageIndex * PAGE_SIZE, total, page: pageIndex }));
}

async function showUser(ctx: Context, deps: BotDeps, adminId: number, tgUserId: number): Promise<void> {
  const view = userDetails(deps, adminId, tgUserId);
  if (view !== null) await paint(ctx, view);
}

function userDetails(deps: BotDeps, adminId: number, tgUserId: number): AdminView | null {
  const user = getUser(deps.db, tgUserId);
  if (user === undefined) return null;
  return adminUserView({ user, sources: listSourcesForUser(deps.db, user.id), backPage: getSession(adminId).adm?.page ?? 0 });
}

/** The panel replaces itself when a button was tapped; a command or a typed step gets a new message. */
async function paint(ctx: Context, view: AdminView): Promise<void> {
  const chatId = ctx.chat?.id;
  const messageId = ctx.callbackQuery?.message?.message_id;
  if (chatId === undefined) return;
  if (messageId === undefined) {
    await ctx.reply(view.text, { parse_mode: 'HTML', reply_markup: view.keyboard });
    return;
  }
  try {
    await ctx.api.editMessageText(chatId, messageId, view.text, { parse_mode: 'HTML', reply_markup: view.keyboard });
  } catch (err) {
    if (!(err instanceof GrammyError && err.description.includes('message is not modified'))) throw err;
  }
}

const idOf = (data: string, prefix: string): number => Number(data.slice(prefix.length));
