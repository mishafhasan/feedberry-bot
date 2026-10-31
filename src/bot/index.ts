import { Bot, type Context, type InlineKeyboard } from 'grammy';
import type { Config } from '../config.ts';
import type { Db } from '../db/index.ts';
import { captureTopic, demoteChat, ensurePrivateChat } from '../db/repos/chats.ts';
import { ensureUser } from '../db/repos/users.ts';
import { log } from '../obs/log.ts';
import { statusText } from '../obs/status.ts';
import { cobaltEngine, type MediaEngine } from '../media/cobalt.ts';
import type { TelegraphClient } from '../article/telegraph.ts';
import { trustedFetch, type Http } from '../platform/http.ts';
import { safeFetch } from '../platform/ssrf.ts';
import { TelegramSender } from '../telegram/api.ts';
import { handleCallback, handleFreeText, handleReplyMenu, handleSourceLink, mainMenu, openSourcesFor, startDownload, verifyAndStoreChat } from './callbacks.ts';
import { getSession, resetSession } from './fsm.ts';
import { langFor, t } from './i18n/index.ts';
import { replyMenu } from './reply-menu.ts';
import { s12View } from './screens/s12.ts';
import { s13View, s14View, s15View } from './screens/s13.ts';

export interface CreateBotOptions {
  cfg: Config;
  db: Db;
  /** Fake Bot API root for tests; unset in production. */
  apiRoot?: string;
  /** Stage-2 network; tests inject fixtures here. */
  http?: Http;
  /** Media engine (ADR-005); tests inject a fixture-backed fake. */
  media?: MediaEngine;
  /** Telegra.ph publisher; tests inject a recorder. */
  telegraph?: TelegraphClient;
}

/** RSSHub and the Bluesky AppView are ours to call; anything else a user typed goes through SSRF checks. */
const TRUSTED_PREFIXES = ['https://public.api.bsky.app/'];

export function networkFor(cfg: Config): Http {
  return (url, opts) => (isTrusted(url, cfg) ? trustedFetch(url, opts) : safeFetch(url, opts));
}

export function createBot({ cfg, db, apiRoot, http, media, telegraph }: CreateBotOptions): Bot {
  const bot = new Bot(cfg.botToken, apiRoot ? { client: { apiRoot } } : undefined);
  const network: Http = http ?? networkFor(cfg);
  const deps = { cfg, db, http: network, media: media ?? cobaltEngine, sender: new TelegramSender(bot.api), telegraph };

  // The slash-command list under Telegram's Menu button. Best effort: a failed call must not stop the bot.
  void bot.api
    .setMyCommands([
      { command: 'start', description: 'Start / Main Menu' },
      { command: 'download', description: 'Download Mode' },
      { command: 'my_sources', description: 'My Sources' },
      { command: 'supported_sites', description: 'Supported Sites' },
      { command: 'language', description: 'Change Interface Language' },
      { command: 'about', description: 'About' },
    ])
    .catch((err: unknown) => log('warn', 'set_commands_failed', { cause: err instanceof Error ? err.message : String(err) }));

  bot.command('start', async (ctx) => {
    const userId = ctx.from?.id;
    if (userId === undefined) return;
    const user = ensureUser(db, userId);
    ensurePrivateChat(db, user.id, userId);
    resetSession(userId);
    const view = mainMenu(userId, deps);
    // The custom keyboard under the input needs its own message: one message carries one markup.
    await ctx.reply(t(langFor(user.locale), 'notice.menuReady'), { reply_markup: replyMenu(langFor(user.locale)) });
    await ctx.reply(view.text, { parse_mode: 'HTML', reply_markup: view.keyboard });
  });

  // The five remaining commands mirror the S1 buttons; each answers with a reply, not an edit.
  bot.command('download', async (ctx) => {
    const userId = ctx.from?.id;
    if (userId === undefined) return;
    await startDownload(ctx, deps, userId);
  });

  bot.command('my_sources', async (ctx) => {
    const userId = ctx.from?.id;
    if (userId === undefined) return;
    resetSession(userId);
    await openSourcesFor(ctx, deps, userId);
  });

  bot.command('supported_sites', async (ctx) => replyWith(ctx, s12View()));
  bot.command('language', async (ctx) => replyWith(ctx, s15View()));
  bot.command('about', async (ctx) => {
    const userId = ctx.from?.id;
    if (userId === undefined) return;
    await replyWith(ctx, s14View(userId));
  });

  // A command Telegram shows in the menu but the bot does not handle would be a dead entry.
  bot.command('help', async (ctx) => replyWith(ctx, s13View()));

  // §13.1: the operator's only command, and only the operator's.
  bot.command('status', async (ctx) => {
    if (ctx.from?.id !== cfg.adminChatId) return;
    await ctx.reply(statusText(db));
  });

  bot.on('message:text', async (ctx) => {
    const userId = ctx.from.id;
    const threadId = ctx.message.message_thread_id;
    if (threadId !== undefined) captureTopic(db, ctx.chat.id, threadId);
    // A tapped reply-keyboard button is an action, never a link to resolve.
    if (await handleReplyMenu(ctx, deps, userId, ctx.message.text)) return;
    if (getSession(userId).state === 'awaiting_source_link') await handleSourceLink(ctx, deps);
    else await handleFreeText(ctx, deps);
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

/** Screens are shared by buttons (edit) and commands (reply); this is the reply half. */
function replyWith(ctx: Context, view: { text: string; keyboard: InlineKeyboard }): Promise<unknown> {
  return ctx.reply(view.text, { parse_mode: 'HTML', reply_markup: view.keyboard });
}
