import { GrammyError, type Context, type InlineKeyboard } from 'grammy';
import type { Config } from '../config.ts';
import type { Db } from '../db/index.ts';
import { countSubscriptions, ensureUser } from '../db/repos/users.ts';
import { log } from '../obs/log.ts';
import { resetSession, setSession } from './fsm.ts';
import { s1View } from './screens/s1.ts';
import { s2View } from './screens/s2.ts';
import { genericToast, stubToast } from './texts.ts';

/** callback_data values (ARCHITECTURE §7.2). */
export const cb = {
  add: 'menu:add',
  sources: 'menu:sources',
  download: 'menu:download',
  back: 'nav:back',
  home: 'nav:home',
  retry: 'err:retry',
} as const;

export interface BotDeps {
  cfg: Config;
  db: Db;
}

interface View {
  text: string;
  keyboard: InlineKeyboard;
}

/** Single entry point for every callback: answer, then route (ARCHITECTURE §7.2). */
export async function handleCallback(ctx: Context, deps: BotDeps): Promise<void> {
  const { data } = ctx.callbackQuery ?? {};
  const userId = ctx.from?.id;
  if (data === undefined || userId === undefined) return;

  // Answer before any work: otherwise the client keeps its spinner running.
  const toast = toastFor(data);
  await ctx.answerCallbackQuery(toast === undefined ? undefined : { text: toast });

  switch (data) {
    case cb.add:
      setSession(userId, { state: 'awaiting_source_link', mode: undefined });
      return paint(ctx, s2View(deps.cfg.telegramBeta));
    case cb.back:
    case cb.home:
      resetSession(userId);
      return paint(ctx, mainMenu(userId, deps));
    case cb.retry:
      // M1 has one retryable action: sending the link again. M2 stores the failed payload.
      setSession(userId, { state: 'awaiting_source_link' });
      return paint(ctx, s2View(deps.cfg.telegramBeta));
    case cb.sources:
    case cb.download:
      return; // stub toast already answered (Appendix A)
    default:
      log('warn', 'callback_unknown', { data, user: userId });
  }
}

function toastFor(data: string): string | undefined {
  switch (data) {
    case cb.sources:
      return stubToast.sources;
    case cb.download:
      return stubToast.download;
    case cb.add:
    case cb.back:
    case cb.home:
    case cb.retry:
      return undefined;
    default:
      return genericToast.unknown;
  }
}

export function mainMenu(userId: number, deps: BotDeps): View {
  const user = ensureUser(deps.db, userId);
  return s1View({
    userId,
    sourceCount: countSubscriptions(deps.db, user.id),
    limit: deps.cfg.limits.maxSourcesPerUser,
    trialEnabled: deps.cfg.trialEnabled,
  });
}

/** Screens replace the current message so the chat does not fill with drafts. */
async function paint(ctx: Context, view: View): Promise<void> {
  try {
    await ctx.editMessageText(view.text, { parse_mode: 'HTML', reply_markup: view.keyboard });
  } catch (err) {
    // A double tap can re-render identical content; Telegram rejects that, and it is harmless.
    if (err instanceof GrammyError && err.description.includes('message is not modified')) return;
    throw err;
  }
}
