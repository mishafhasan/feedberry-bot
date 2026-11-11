import { GrammyError, type Context } from 'grammy';
import type { BotDeps } from './callbacks.ts';
import { listSourceCards, setSubscriptionKeywords, subscriptionCard } from '../db/repos/subscriptions.ts';
import { ensureUser, setDefaultKeywords } from '../db/repos/users.ts';
import { log } from '../obs/log.ts';
import { formatKeywords, parseKeywords } from '../pipeline/keyword-filter.ts';
import { getSession, setSession, type KeywordStep } from './session.ts';
import { langFor, t } from './i18n/index.ts';
import { deliveryOptionsView } from './screens/delivery-options.ts';
import { keywordFilterView } from './screens/keyword-filter.ts';
import { esc } from './texts.ts';
import { PAGE_SIZE } from './screens/my-sources.ts';

const langOf = (deps: BotDeps, userId: number) => langFor(ensureUser(deps.db, userId).locale);

/** `/filter`: the fallback list and every source it covers, one page at a time (ADR-020). */
export async function openFilterFor(ctx: Context, deps: BotDeps, userId: number, page = 0): Promise<void> {
  await renderFilter(ctx, deps, userId, page, ctx.callbackQuery?.message?.message_id);
}

/** S5's `add:kw`: the prompt, then the answer lands in `pending.keywords` and S5 is repainted. */
export async function askPendingKeywords(ctx: Context, deps: BotDeps, userId: number, messageId: number | undefined): Promise<void> {
  const pending = getSession(userId).pending;
  if (!pending || messageId === undefined) return;
  await prompt(ctx, deps, userId, { target: 'add', messageId, page: 0 }, pending.author);
}

/** A /filter `✏️` row: the prompt names the source it will change. */
export async function askSourceKeywords(ctx: Context, deps: BotDeps, userId: number, subscriptionId: number, page: number): Promise<void> {
  const card = subscriptionCard(deps.db, ensureUser(deps.db, userId).id, subscriptionId);
  const messageId = ctx.callbackQuery?.message?.message_id;
  if (!card || messageId === undefined) return;
  await prompt(ctx, deps, userId, { target: subscriptionId, messageId, page }, card.title ?? card.canonical_url);
}

export async function askDefaultKeywords(ctx: Context, deps: BotDeps, userId: number, page: number): Promise<void> {
  const messageId = ctx.callbackQuery?.message?.message_id;
  if (messageId === undefined) return;
  setSession(userId, { state: 'awaiting_keywords', keywordStep: { target: 'default', messageId, page } });
  await ctx.reply(t(langOf(deps, userId), 'kw.promptDefault'));
}

/** `🗑` on a row: the subscription keeps its posts and hands itself back to the user default. */
export async function clearKeywords(ctx: Context, deps: BotDeps, userId: number, subscriptionId: number, page: number): Promise<void> {
  const user = ensureUser(deps.db, userId);
  const saved = setSubscriptionKeywords(deps.db, user.id, subscriptionId, null);
  log('info', saved ? 'keywords_cleared' : 'keywords_denied', { subscription: subscriptionId });
  await renderFilter(ctx, deps, userId, page, ctx.callbackQuery?.message?.message_id);
}

export async function clearDefaultKeywords(ctx: Context, deps: BotDeps, userId: number, page: number): Promise<void> {
  setDefaultKeywords(deps.db, userId, null);
  await renderFilter(ctx, deps, userId, page, ctx.callbackQuery?.message?.message_id);
}

/**
 * The typed answer. Returns false when no prompt is open, so the message still reaches the link
 * and menu handlers.
 */
export async function handleKeywordInput(ctx: Context, deps: BotDeps, userId: number): Promise<boolean> {
  const { state, keywordStep } = getSession(userId);
  const text = ctx.message?.text?.trim() ?? '';
  if (state !== 'awaiting_keywords' || keywordStep === undefined || text === '') return false;
  // A link or a slash command is not a keyword list: a stray "https://…" must never mute a source.
  if (/^https?:\/\//i.test(text) || (text.startsWith('/') && !/^\/skip$/i.test(text))) return false;

  // `/skip` is how a user removes a filter without hunting for the 🗑 button.
  const keywords = /^\/skip$/i.test(text) ? [] : parseKeywords(text);
  const stored = formatKeywords(keywords);
  const user = ensureUser(deps.db, userId);

  if (keywordStep.target === 'default') setDefaultKeywords(deps.db, userId, stored);
  else if (typeof keywordStep.target === 'number' && !setSubscriptionKeywords(deps.db, user.id, keywordStep.target, stored)) {
    // A row that is gone (deleted in another tap) must not leave the session waiting for text.
    setSession(userId, { state: 'idle', keywordStep: undefined });
    return true;
  }
  log('info', 'keywords_set', { user: userId, target: keywordStep.target, keywords: stored });

  await ctx.deleteMessage().catch(() => {});

  if (keywordStep.target === 'add') {
    const pending = getSession(userId).pending;
    setSession(userId, { state: 'add_mode', keywordStep: undefined, pending: pending && { ...pending, keywords } });
    await repaintS5(ctx, deps, userId, keywordStep.messageId);
    return true;
  }
  setSession(userId, { state: 'idle', keywordStep: undefined });
  await renderFilter(ctx, deps, userId, keywordStep.page, keywordStep.messageId);
  return true;
}

async function prompt(ctx: Context, deps: BotDeps, userId: number, step: KeywordStep, label: string): Promise<void> {
  setSession(userId, { state: 'awaiting_keywords', keywordStep: step });
  await ctx.reply(t(langOf(deps, userId), 'kw.prompt', { title: esc(label) }), { parse_mode: 'HTML' });
}

/** S5 lives in one message, which is a caption when the source has an avatar. */
async function repaintS5(ctx: Context, deps: BotDeps, userId: number, messageId: number): Promise<void> {
  const chatId = ctx.chat?.id;
  const pending = getSession(userId).pending;
  if (chatId === undefined || pending === undefined) return;
  const view = deliveryOptionsView(pending.bodyText, langOf(deps, userId), pending.keywords ?? [], ensureUser(deps.db, userId).default_keywords);
  const markup = { parse_mode: 'HTML' as const, reply_markup: view.keyboard };
  try {
    if (pending.photo) await ctx.api.editMessageCaption(chatId, messageId, { caption: view.text, ...markup });
    else await ctx.api.editMessageText(chatId, messageId, view.text, markup);
  } catch (err) {
    // The old S5 still works: its buttons read the session, which already holds the keywords.
    if (!notModified(err)) log('warn', 'keywords_repaint_failed', { cause: err instanceof Error ? err.message : String(err) });
  }
}

async function renderFilter(ctx: Context, deps: BotDeps, userId: number, page: number, messageId: number | undefined): Promise<void> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return;
  const user = ensureUser(deps.db, userId);

  let pageIndex = Math.max(0, page);
  let { rows, total } = listSourceCards(deps.db, user.id, null, PAGE_SIZE, pageIndex * PAGE_SIZE);
  if (rows.length === 0 && pageIndex > 0) {
    pageIndex = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1);
    ({ rows, total } = listSourceCards(deps.db, user.id, null, PAGE_SIZE, pageIndex * PAGE_SIZE));
  }

  const view = keywordFilterView({ cards: rows, offset: pageIndex * PAGE_SIZE, total, page: pageIndex, defaults: user.default_keywords, lang: langFor(user.locale) });
  // Any repaint of the list is also a cancel: a prompt left armed would eat the next ordinary message.
  setSession(userId, { state: 'idle', keywordStep: undefined, kwPage: pageIndex });
  const markup = { reply_markup: view.keyboard };
  if (messageId === undefined) {
    await ctx.api.sendRichMessage(chatId, { html: view.html }, markup);
    return;
  }
  try {
    await ctx.api.editMessageText(chatId, messageId, { html: view.html }, markup);
  } catch (err) {
    if (notModified(err)) return;
    // Too old to edit, or a plain message from before the rich screen: a new one is the honest fix.
    await ctx.api.sendRichMessage(chatId, { html: view.html }, markup);
  }
}

/** Telegram rejects an identical repaint; that is not an error. */
const notModified = (err: unknown): boolean => err instanceof GrammyError && err.description.includes('message is not modified');
