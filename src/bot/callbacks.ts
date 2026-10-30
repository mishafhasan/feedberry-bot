import { GrammyError, type Context, type InlineKeyboard } from 'grammy';
import type { Config } from '../config.ts';
import type { Db } from '../db/index.ts';
import { destinations, ensurePrivateChat, personalChat, upsertChat } from '../db/repos/chats.ts';
import { countSubscriptions, ensureUser } from '../db/repos/users.ts';
import { log } from '../obs/log.ts';
import { Coded, E, isCoded } from '../platform/errors.ts';
import type { FeedItem, ParsedFeed } from '../platform/feed/native.ts';
import type { Http } from '../platform/http.ts';
import type { SourceRef } from '../platform/registry.ts';
import { resolveProfile } from '../pipeline/s1-resolve.ts';
import { fetchFeed } from '../pipeline/s2-feed.ts';
import { getSession, resetSession, setSession } from './fsm.ts';
import { errorKeyboard } from './keyboards.ts';
import { s1View } from './screens/s1.ts';
import { s2View } from './screens/s2.ts';
import { s3View } from './screens/s3.ts';
import { s4View } from './screens/s4.ts';
import { errorText, genericToast, stubToast } from './texts.ts';

/** callback_data values (ARCHITECTURE §7.2). */
export const cb = {
  add: 'menu:add',
  sources: 'menu:sources',
  download: 'menu:download',
  back: 'nav:back',
  home: 'nav:home',
  retry: 'err:retry',
  dest: 'add:dest:',
} as const;

export interface BotDeps {
  cfg: Config;
  db: Db;
  http: Http;
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

  if (data.startsWith(cb.dest)) return; // M2 stub: M3 turns this into S5

  switch (data) {
    case cb.add:
      setSession(userId, { state: 'awaiting_source_link', mode: undefined, error: undefined });
      return paint(ctx, s2View(deps.cfg.telegramBeta));
    case cb.back:
      if (getSession(userId).state === 'preview') {
        setSession(userId, { state: 'awaiting_source_link', pending: undefined });
        return paint(ctx, s2View(deps.cfg.telegramBeta));
      }
      resetSession(userId);
      return paint(ctx, mainMenu(userId, deps));
    case cb.home:
      resetSession(userId);
      return paint(ctx, mainMenu(userId, deps));
    case cb.retry:
      return retry(ctx, deps, userId);
    case cb.sources:
    case cb.download:
      return; // stub toast already answered (Appendix A)
    default:
      log('warn', 'callback_unknown', { data, user: userId });
  }
}

/** A source link arrived in `awaiting_source_link` (stages 1–2, then S3 → S4). */
export async function handleSourceLink(ctx: Context, deps: BotDeps): Promise<void> {
  const userId = ctx.from?.id;
  const link = ctx.message?.text?.trim();
  if (userId === undefined || !link) return;
  await runResolve(ctx, deps, userId, link);
}

async function runResolve(ctx: Context, deps: BotDeps, userId: number, link: string): Promise<void> {
  const user = ensureUser(deps.db, userId);
  ensurePrivateChat(deps.db, user.id, userId);
  const chatId = ctx.chat?.id;
  let working: number | undefined;

  try {
    const ref = resolveProfile(link, { rsshubBase: deps.cfg.rsshubBase, telegramBeta: deps.cfg.telegramBeta });
    setSession(userId, { state: 'checking', error: undefined });
    working = (await ctx.reply(s3View(ref.canonicalUrl).text, { parse_mode: 'HTML' })).message_id;

    const feed = await fetchFeed(deps.http, ref);
    const items = newest(feed.items, deps.cfg.limits.backfillCount);
    setSession(userId, {
      state: 'preview',
      pending: { link, ...ref, author: feed.title ?? ref.externalId, avatarUrl: feed.avatarUrl, items, at: Date.now() },
    });
    await sendPreview(ctx, deps, user.id, ref, feed, items);
  } catch (err) {
    await showError(ctx, userId, err, { kind: 'source', link });
  } finally {
    if (working !== undefined && chatId !== undefined) {
      // S3 is a placeholder, not a screen: drop it so the chat matches the reference flow.
      await ctx.api.deleteMessage(chatId, working).catch(() => {});
    }
  }
}

async function sendPreview(ctx: Context, deps: BotDeps, ownerUserId: number, ref: SourceRef, feed: ParsedFeed, items: FeedItem[]): Promise<void> {
  const view = s4View({
    platform: ref.platform,
    author: feed.title ?? ref.externalId,
    avatarUrl: feed.avatarUrl,
    items,
    personalChatId: personalChat(deps.db, ownerUserId).id,
    chats: destinations(deps.db, ownerUserId),
  });

  if (view.photoUrl) {
    try {
      await ctx.replyWithPhoto(view.photoUrl, { caption: view.text, parse_mode: 'HTML', reply_markup: view.keyboard });
      return;
    } catch (err) {
      // An avatar URL Telegram cannot fetch must not cost the user the preview.
      log('warn', 'avatar_send_failed', { cause: message(err) });
    }
  }
  await ctx.reply(view.text, { parse_mode: 'HTML', reply_markup: view.keyboard });
}

/** ADR-014: getChat → getChatMember(bot) → store only when the bot may post. */
export async function verifyAndStoreChat(ctx: Context, deps: BotDeps, tgChatId: number): Promise<void> {
  const userId = ctx.from?.id;
  if (userId === undefined) return;
  const user = ensureUser(deps.db, userId);

  try {
    const chat = await ctx.api.getChat(tgChatId);
    if (chat.type === 'private') return;
    const member = await ctx.api.getChatMember(tgChatId, ctx.me.id);
    const isAdmin = member.status === 'administrator' && (chat.type !== 'channel' || member.can_post_messages === true);
    if (!isAdmin) throw new Coded(E.BOT_NOT_ADMIN, `status ${member.status}`);

    upsertChat(deps.db, {
      ownerUserId: user.id,
      tgChatId,
      type: chat.type,
      title: 'title' in chat ? (chat.title ?? null) : null,
      messageThreadId: null,
      canPost: true,
      verifiedAt: Date.now(),
      rightsJson: JSON.stringify(member),
    });
    setSession(userId, { error: undefined });
    log('info', 'chat_linked', { chat: tgChatId, type: chat.type });
  } catch (err) {
    const code = isCoded(err) ? err.code : E.TG_UNKNOWN;
    log('warn', 'chat_verify_failed', { code, chat: tgChatId, cause: message(err) });
    setSession(userId, { state: 'error', error: { kind: 'chat', tgChatId } });
    await ctx.api.sendMessage(tgChatId, errorText(code), { parse_mode: 'HTML', reply_markup: errorKeyboard() }).catch(() => {});
  }
}

async function retry(ctx: Context, deps: BotDeps, userId: number): Promise<void> {
  const last = getSession(userId).error;
  if (last?.kind === 'source') return runResolve(ctx, deps, userId, last.link);
  if (last?.kind === 'chat') return verifyAndStoreChat(ctx, deps, last.tgChatId);
  setSession(userId, { state: 'awaiting_source_link' });
  return paint(ctx, s2View(deps.cfg.telegramBeta));
}

async function showError(ctx: Context, userId: number, err: unknown, last: { kind: 'source'; link: string }): Promise<void> {
  const code = isCoded(err) ? err.code : E.TG_UNKNOWN;
  log('warn', 'check_failed', { code, cause: message(err) });
  setSession(userId, { state: 'error', error: last });
  await ctx.reply(errorText(code), { parse_mode: 'HTML', reply_markup: errorKeyboard() });
}

function toastFor(data: string): string | undefined {
  if (data.startsWith(cb.dest)) return stubToast.destination;
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

/** §5.4: the newest N items, returned oldest → newest. */
export function newest(items: FeedItem[], count: number): FeedItem[] {
  return [...items].sort((a, b) => (a.publishedAt ?? 0) - (b.publishedAt ?? 0)).slice(-count);
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

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));
