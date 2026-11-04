import { GrammyError, type Context } from 'grammy';
import type { BotDeps } from './callbacks.ts';
import { getSession, resetSession, setSession } from './fsm.ts';
import { t } from './i18n/index.ts';
import { isAdmin } from './access.ts';
import { listSourcesForUser } from '../db/repos/subscriptions.ts';
import { findAccessRequestByUsername, recentAccessRequests, recordEvent } from '../db/repos/events.ts';
import { countSources } from '../db/repos/sources.ts';
import { getUser, listAllowedTgIds, listUsers, setUserStatus, upsertAllowedUser, userStats } from '../db/repos/users.ts';
import { log } from '../obs/log.ts';
import { isCoded } from '../platform/errors.ts';
import { senderTarget } from '../telegram/api.ts';
import { esc } from './texts.ts';
import { ADM, adminConfirmAllView, adminOverviewView, adminPromptView, adminUserView, adminUsersView, type AdminView } from './screens/s17.ts';
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
    setSession(userId, { state: 'idle' });
    return paint(ctx, overview(deps));
  }
  if (data === ADM.add) {
    setSession(userId, { state: 'awaiting_admin_user_id' });
    return paint(ctx, adminPromptView(t(LANG, 'adm.add.prompt')));
  }
  if (data === ADM.msg) {
    setSession(userId, { state: 'awaiting_admin_notify_target' });
    return paint(ctx, adminPromptView(t(LANG, 'adm.msg.targetPrompt')));
  }
  if (data === ADM.all) return paint(ctx, adminConfirmAllView());
  if (data === ADM.allYes) {
    setSession(userId, { state: 'awaiting_admin_notify_all' });
    return paint(ctx, adminPromptView(t(LANG, 'adm.all.prompt')));
  }
  if (data.startsWith(ADM.users)) return showUsers(ctx, deps, userId, idOf(data, ADM.users));
  if (data.startsWith(ADM.user)) return showUser(ctx, deps, userId, idOf(data, ADM.user));
  if (data.startsWith(ADM.allow) || data.startsWith(ADM.unblock)) {
    const target = idOf(data, data.startsWith(ADM.allow) ? ADM.allow : ADM.unblock);
    setUserStatus(deps.db, target, 'allowed');
    log('info', 'admin_user_allowed', { user: target, by: userId });
    return showUser(ctx, deps, userId, target);
  }
  if (data.startsWith(ADM.block)) {
    const target = idOf(data, ADM.block);
    setUserStatus(deps.db, target, 'blocked');
    // Blocking must cut the user off now: the gate re-reads the row, and this drops their flow.
    resetSession(target);
    log('info', 'admin_user_blocked', { user: target, by: userId });
    return showUser(ctx, deps, userId, target);
  }
  if (data.startsWith(ADM.msgTo)) {
    const target = idOf(data, ADM.msgTo);
    setSession(userId, { state: 'awaiting_admin_notify', adminTarget: target });
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
    case 'awaiting_admin_notify_target':
      await setNotifyTarget(ctx, userId, text);
      return true;
    case 'awaiting_admin_notify':
      if (adminTarget === undefined) return false;
      await notifyUser(ctx, deps, userId, adminTarget, text);
      return true;
    case 'awaiting_admin_notify_all':
      await notifyAll(ctx, deps, userId, text);
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
  resetSession(adminId);
  await ctx.reply(t(LANG, 'adm.add.done', { id }), { parse_mode: 'HTML' });
  const view = userDetails(deps, adminId, id);
  if (view !== null) await ctx.reply(view.text, { parse_mode: 'HTML', reply_markup: view.keyboard });
}

async function setNotifyTarget(ctx: Context, adminId: number, text: string): Promise<void> {
  if (!/^\d+$/.test(text) || Number(text) <= 0) {
    await ctx.reply(t(LANG, 'adm.msg.targetInvalid'));
    return;
  }
  const target = Number(text);
  setSession(adminId, { state: 'awaiting_admin_notify', adminTarget: target });
  const view = adminPromptView(t(LANG, 'adm.msg.prompt', { id: target }));
  await ctx.reply(view.text, { parse_mode: 'HTML', reply_markup: view.keyboard });
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
