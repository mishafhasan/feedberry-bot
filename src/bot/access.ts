import type { Context } from 'grammy';
import type { Config } from '../config.ts';
import type { Db } from '../db/index.ts';
import { recordEvent } from '../db/repos/events.ts';
import { log } from '../obs/log.ts';
import { resetSession } from './session.ts';
import { t } from './i18n/index.ts';

/** Users already told they are waiting; a restart re-sends once, which is harmless. */
const noticed = new Set<number>();

export function isAdmin(cfg: Config, tgUserId: number): boolean {
  return tgUserId === cfg.adminChatId;
}

/** Fail-closed: only the literal 'allowed' opens the bot; the admin bypasses the table. */
export function isAllowed(db: Db, cfg: Config, tgUserId: number): boolean {
  if (isAdmin(cfg, tgUserId)) return true;
  return db.prepare("SELECT 1 AS ok FROM users WHERE tg_user_id = ? AND status = 'allowed'").get(tgUserId) !== undefined;
}

/** The single gate in front of every update. Returns true when the handler may run. */
export async function gate(ctx: Context, db: Db, cfg: Config): Promise<boolean> {
  const userId = ctx.from?.id;
  if (userId === undefined) return false; // channel posts carry no user: no one to authorise
  if (isAllowed(db, cfg, userId)) return true;
  await deny(ctx, db, userId);
  return false;
}

/**
 * A denied action: answer the tap, drop any stale flow, and tell the stranger once per chat.
 * The tg id and @username go into `events` so the admin can approve them from the panel.
 */
export async function deny(ctx: Context, db: Db, userId: number): Promise<void> {
  resetSession(userId);
  // A message update has no callback to answer; a tap must not keep its spinner running.
  if (ctx.callbackQuery !== undefined) await ctx.answerCallbackQuery().catch(() => {});
  if (noticed.has(userId)) return;
  noticed.add(userId);

  const username = ctx.from?.username;
  recordEvent(db, { level: 'info', code: 'access_requested', chatId: userId, detail: username === undefined ? null : `@${username}` });
  log('warn', 'access_denied', { user: userId });

  // Never post an access notice into someone's channel or group.
  if (ctx.chat?.type !== 'private') return;
  await ctx.reply(t('en', 'notice.access.request')).catch((err: unknown) => {
    log('warn', 'access_notice_failed', { user: userId, cause: err instanceof Error ? err.message : String(err) });
  });
}
