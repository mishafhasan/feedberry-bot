import { Bot } from 'grammy';
import type { Config } from '../config.ts';
import type { Db } from '../db/index.ts';
import { captureTopic, demoteChat, ensurePrivateChat } from '../db/repos/chats.ts';
import { ensureUser } from '../db/repos/users.ts';
import { log } from '../obs/log.ts';
import { statusText } from '../obs/status.ts';
import { cobaltEngine, type MediaEngine } from '../media/cobalt.ts';
import { trustedFetch, type Http } from '../platform/http.ts';
import { safeFetch } from '../platform/ssrf.ts';
import { TelegramSender } from '../telegram/api.ts';
import { handleCallback, handleSourceLink, mainMenu, verifyAndStoreChat } from './callbacks.ts';
import { getSession, resetSession } from './fsm.ts';

export interface CreateBotOptions {
  cfg: Config;
  db: Db;
  /** Fake Bot API root for tests; unset in production. */
  apiRoot?: string;
  /** Stage-2 network; tests inject fixtures here. */
  http?: Http;
  /** Media engine (ADR-005); tests inject a fixture-backed fake. */
  media?: MediaEngine;
}

/** RSSHub and the Bluesky AppView are ours to call; anything else a user typed goes through SSRF checks. */
const TRUSTED_PREFIXES = ['https://public.api.bsky.app/'];

export function networkFor(cfg: Config): Http {
  return (url, opts) => (isTrusted(url, cfg) ? trustedFetch(url, opts) : safeFetch(url, opts));
}

export function createBot({ cfg, db, apiRoot, http, media }: CreateBotOptions): Bot {
  const bot = new Bot(cfg.botToken, apiRoot ? { client: { apiRoot } } : undefined);
  const network: Http = http ?? networkFor(cfg);
  const deps = { cfg, db, http: network, media: media ?? cobaltEngine, sender: new TelegramSender(bot.api) };

  bot.command('start', async (ctx) => {
    const userId = ctx.from?.id;
    if (userId === undefined) return;
    const user = ensureUser(db, userId);
    ensurePrivateChat(db, user.id, userId);
    resetSession(userId);
    const view = mainMenu(userId, deps);
    await ctx.reply(view.text, { parse_mode: 'HTML', reply_markup: view.keyboard });
  });

  // §13.1: the operator's only command, and only the operator's.
  bot.command('status', async (ctx) => {
    if (ctx.from?.id !== cfg.adminChatId) return;
    await ctx.reply(statusText(db));
  });

  bot.on('message:text', async (ctx) => {
    const userId = ctx.from.id;
    const threadId = ctx.message.message_thread_id;
    if (threadId !== undefined) captureTopic(db, ctx.chat.id, threadId);
    if (getSession(userId).state !== 'awaiting_source_link') return;
    await handleSourceLink(ctx, deps);
  });

  // ADR-014: a channel/group is registered only after the bot's rights are proven.
  bot.on('my_chat_member', async (ctx) => {
    const { chat, new_chat_member: member } = ctx.myChatMember;
    if (chat.type === 'private') return;
    if (member.status === 'left' || member.status === 'kicked') {
      demoteChat(db, chat.id);
      log('info', 'chat_removed', { chat: chat.id });
      return;
    }
    await verifyAndStoreChat(ctx, deps, chat.id);
  });

  bot.on('callback_query:data', (ctx) => handleCallback(ctx, deps));

  bot.catch((err) => {
    const cause = err.error instanceof Error ? err.error.message : String(err.error);
    log('error', 'bot_update_failed', { update: err.ctx.update.update_id, cause });
  });

  return bot;
}

export function isTrusted(url: string, cfg: Config): boolean {
  return url.startsWith(cfg.rsshubBase) || TRUSTED_PREFIXES.some((prefix) => url.startsWith(prefix));
}
