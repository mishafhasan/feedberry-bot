import { Bot } from 'grammy';
import type { Config } from '../config.ts';
import type { Db } from '../db/index.ts';
import { ensureUser } from '../db/repos/users.ts';
import { log } from '../obs/log.ts';
import { handleCallback, mainMenu } from './callbacks.ts';
import { resetSession } from './fsm.ts';

export interface CreateBotOptions {
  cfg: Config;
  db: Db;
  /** Fake Bot API root for tests; unset in production. */
  apiRoot?: string;
}

export function createBot({ cfg, db, apiRoot }: CreateBotOptions): Bot {
  const bot = new Bot(cfg.botToken, apiRoot ? { client: { apiRoot } } : undefined);

  bot.command('start', async (ctx) => {
    const userId = ctx.from?.id;
    if (userId === undefined) return;
    ensureUser(db, userId);
    resetSession(userId);
    const view = mainMenu(userId, { cfg, db });
    await ctx.reply(view.text, { parse_mode: 'HTML', reply_markup: view.keyboard });
  });

  bot.on('callback_query:data', (ctx) => handleCallback(ctx, { cfg, db }));

  bot.catch((err) => {
    const cause = err.error instanceof Error ? err.error.message : String(err.error);
    log('error', 'bot_update_failed', { update: err.ctx.update.update_id, cause });
  });

  return bot;
}
