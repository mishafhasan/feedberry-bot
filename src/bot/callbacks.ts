import { GrammyError, type Context, type InlineKeyboard } from 'grammy';
import type { Config } from '../config.ts';
import { tx, type Db } from '../db/index.ts';
import { destinations, ensurePrivateChat, ownChat, personalChat, upsertChat } from '../db/repos/chats.ts';
import { countDownloadsSince } from '../db/repos/deliveries.ts';
import { deleteSourceIfOrphan, findSourceByUrl, getSource, setSourceEnabled, setSourceInterval } from '../db/repos/sources.ts';
import { deleteSubscription, countSubscriptionsForUser, getSourceCard, listSourceCards, ownsSource, platformsForUser, sourceIdsForUser, subscribedByUser, setNextSlot, subscriptionSlots } from '../db/repos/subscriptions.ts';
import { ensureUser, setLocale } from '../db/repos/users.ts';
import { log } from '../obs/log.ts';
import type { MediaEngine, MediaItem } from '../media/cobalt.ts';
import { Coded, E, isCoded } from '../platform/errors.ts';
import type { FeedItem, ParsedFeed } from '../platform/feed/native.ts';
import { fetchThreadsThread, threadText } from '../platform/feed/threads.ts';
import { fetchYouTubePost } from '../platform/feed/youtube-post.ts';
import type { Http } from '../platform/http.ts';
import { classifyLink, detectSource, isWebsitePage, profileFromAuthor, profileOfPost, type DetectOptions, type LinkMatch, type SourceRef } from '../platform/registry.ts';
import { pinOwner } from '../platform/pinterest-pin.ts';
import { pageMeta } from '../platform/page-text.ts';
import { xFullText } from '../platform/x-text.ts';
import { resolveProfile } from '../pipeline/s1-resolve.ts';
import { fetchFeed } from '../pipeline/s2-feed.ts';
import { addSource, assertWithinSourceLimit } from '../pipeline/s4-dedupe.ts';
import { mediaSignal, prepareMedia } from '../pipeline/s5-media.ts';
import { renderDownload } from '../pipeline/s6-render.ts';
import { withReadMore, type ReadMorePage } from '../pipeline/read-more.ts';
import { postHeader } from '../render/caption.ts';
import { type MediaFile, type MessagePlan } from '../render/plan.ts';
import { planArticle } from '../pipeline/article-plan.ts';
import type { TelegraphClient } from '../article/telegraph.ts';
import { hiddenMenu, menuLabels } from './reply-menu.ts';
import { recordDelivery } from '../pipeline/s8-record.ts';
import { cleanupWorkDir, workDirFor } from '../pipeline/s9-cleanup.ts';
import { enqueue, PRIORITY } from '../jobs/queue.ts';
import { slotAfter } from '../scheduler/slots.ts';
import type { TelegramSender } from '../telegram/api.ts';
import { targetOf } from '../telegram/target.ts';
import { PREVIEW_TTL_MS, getSession, resetSession, setSession, type LastError, type PendingSource, type S7State } from './fsm.ts';
import { allowAdd, allowCallback, allowCheck } from './quotas.ts';
import { backKeyboard, downloadResultKeyboard, errorKeyboard, noticeKeyboard, openSourcesKeyboard, postLinkKeyboard, LANGUAGES } from './keyboards.ts';
import { handleAdminCallback } from './admin.ts';
import { s1View } from './screens/s1.ts';
import { s10View } from './screens/s10.ts';
import { s2View } from './screens/s2.ts';
import { s3View } from './screens/s3.ts';
import { s4View } from './screens/s4.ts';
import { s5View } from './screens/s5.ts';
import { s6View } from './screens/s6.ts';
import { s7View, PAGE_SIZE } from './screens/s7.ts';
import { s12View } from './screens/s12.ts';
import { s13View, s14View, s15View } from './screens/s13.ts';
import { s16List, s16Picker, SCHEDULE_OPTIONS } from './screens/s16.ts';
import { ADM } from './screens/s17.ts';
import { langFor, t, type Lang } from './i18n/index.ts';
import { actionToast, downloadDone, downloadPrompt, errorText, esc, genericToast, linkRequired, postLinkPrompt, sourceBody } from './texts.ts';

/** callback_data values (ARCHITECTURE §7.2). */
export const cb = {
  add: 'menu:add',
  sources: 'menu:sources',
  download: 'menu:download',
  back: 'nav:back',
  home: 'nav:home',
  retry: 'err:retry',
  dest: 'add:dest:',
  save: 'add:save',
  saveSilent: 'add:save_silent',
  page: 'src:page:',
  filter: 'src:filter:',
  on: 'src:on:',
  off: 'src:off:',
  check: 'src:check:',
  del: 'src:del:',
  delOk: 'src:delok:',
  delNo: 'src:delno:',
  downloadMore: 'dl:more',
  downloadPost: 'dl:post',
  addPost: 'add:post',
  supported: 'menu:supported',
  help: 'menu:help',
  language: 'menu:language',
  lang: 'lang:',
  schedule: 'menu:schedule',
  schedOpen: 'src:sched:',
  schedSet: 'sched:set:',
  schedPage: 'sched:page:',
  schedAll: 'sched:all',
  schedSetAll: 'sched:setall:',
} as const;

export interface BotDeps {
  cfg: Config;
  db: Db;
  http: Http;
  media: MediaEngine;
  sender: TelegramSender;
  /** Telegra.ph publisher; tests inject a recorder, production uses the real client. */
  telegraph?: TelegraphClient;
}

interface View {
  text: string;
  keyboard: InlineKeyboard;
}

/** S1 and S7 are rich messages: the body carries the formatting, the keyboard only navigation. */
interface RichView {
  html: string;
  keyboard: InlineKeyboard;
}

/** The interface language of one user; every text and keyboard is built with it. */
function langOf(deps: BotDeps, tgUserId: number): Lang {
  return langFor(ensureUser(deps.db, tgUserId).locale);
}

/** Single entry point for every callback: answer, then route (ARCHITECTURE §7.2). */
export async function handleCallback(ctx: Context, deps: BotDeps): Promise<void> {
  const { data } = ctx.callbackQuery ?? {};
  const userId = ctx.from?.id;
  if (data === undefined || userId === undefined) return;

  // The admin panel owns its callbacks; it re-checks the admin id and answers its own toast.
  if (data.startsWith(ADM.prefix)) return handleAdminCallback(ctx, deps, userId, data);

  // Answer before any network work: otherwise the client keeps its spinner running.
  const lang = langOf(deps, userId);
  const toast = toastFor(data, lang);

  // §12.4: one callback per interval; a tripped quota is a toast, not an exception.
  if (!allowCallback(userId, deps.cfg.limits.callbackIntervalMs)) {
    await ctx.answerCallbackQuery({ text: genericToast(lang).slowDown });
    return;
  }

  if (data.startsWith(cb.check)) return queueCheck(ctx, deps, userId, idOf(data, cb.check), toast, lang);
  if (data.startsWith(cb.schedSetAll) || data.startsWith(cb.schedSet)) return applySchedule(ctx, deps, userId, data, toast, lang);

  await ctx.answerCallbackQuery(toast === undefined ? undefined : { text: toast });

  if (data.startsWith(cb.schedOpen)) return schedulePicker(ctx, deps, userId, idOf(data, cb.schedOpen));
  if (data.startsWith(cb.schedPage)) return renderSchedule(ctx, deps, userId, idOf(data, cb.schedPage));
  if (data === cb.schedAll) return paint(ctx, s16Picker(null, lang));

  if (data.startsWith(cb.lang)) return setLanguage(ctx, deps, userId, data.slice(cb.lang.length));

  if (data === cb.downloadPost || data === cb.addPost) return choosePost(ctx, deps, userId, data === cb.downloadPost);

  if (data.startsWith(cb.dest)) return pickDest(ctx, deps, userId, idOf(data, cb.dest));
  if (data.startsWith(cb.page)) return renderS7(ctx, deps, userId, idOf(data, cb.page), getSession(userId).s7?.platform ?? null, getSession(userId).s7?.headerId ?? null);
  if (data.startsWith(cb.filter)) return changeFilter(ctx, deps, userId, data.slice(cb.filter.length));
  if (data.startsWith(cb.on) || data.startsWith(cb.off)) return toggle(ctx, deps, userId, data);
  if (data.startsWith(cb.del)) return askDelete(ctx, deps, userId, idOf(data, cb.del));
  if (data.startsWith(cb.delOk)) return confirmDelete(ctx, deps, userId, idOf(data, cb.delOk));
  if (data.startsWith(cb.delNo)) {
    await ctx.deleteMessage().catch(() => {});
    return;
  }

  switch (data) {
    case cb.add:
      setSession(userId, { state: 'awaiting_source_link', mode: undefined, error: undefined });
      return paint(ctx, s2View(deps.cfg.telegramBeta, lang));
    case cb.save:
      return save(ctx, deps, userId, true);
    case cb.saveSilent:
      return save(ctx, deps, userId, false);
    case cb.sources:
      return openSources(ctx, deps, userId);
    case cb.supported:
      return paint(ctx, s12View(lang));
    case cb.help:
      return paint(ctx, s13View(lang));
    case cb.language:
      return paint(ctx, s15View(lang));
    case cb.schedule:
      return renderSchedule(ctx, deps, userId, getSession(userId).s16?.page ?? 0);
    case cb.back:
      return goBack(ctx, deps, userId);
    case cb.home:
      resetSession(userId);
      return paintRich(ctx, mainMenu(userId, deps));
    case cb.retry:
      return retry(ctx, deps, userId);
    case cb.download:
      setSession(userId, { state: 'awaiting_source_link', mode: 'download', error: undefined });
      await ctx.reply(downloadPrompt(lang), { parse_mode: 'HTML', reply_markup: backKeyboard(lang) });
      return;
    case cb.downloadMore:
      setSession(userId, { state: 'awaiting_source_link', mode: 'download', error: undefined });
      return paint(ctx, { text: downloadPrompt(lang), keyboard: backKeyboard(lang) });
    default:
      log('warn', 'callback_unknown', { data, user: userId });
  }
}

/** A reply-keyboard tap arrives as text; this maps it back to the same actions. */
export async function handleReplyMenu(ctx: Context, deps: BotDeps, userId: number, text: string): Promise<boolean> {
  const lang = langOf(deps, userId);
  const action = menuLabels(lang).get(text.trim());
  if (!action) return false;

  switch (action) {
    case 'hide':
      await ctx.reply(t(lang, 'notice.menuHidden'), { reply_markup: hiddenMenu });
      return true;
    case 'add': {
      setSession(userId, { state: 'awaiting_source_link', mode: undefined, error: undefined });
      const view = s2View(deps.cfg.telegramBeta, lang);
      await ctx.reply(view.text, { parse_mode: 'HTML', reply_markup: view.keyboard });
      return true;
    }
    case 'sources':
      await renderS7(ctx, deps, userId, 0, null, null);
      return true;
    case 'supported': {
      const view = s12View(lang);
      await ctx.reply(view.text, { parse_mode: 'HTML', reply_markup: view.keyboard });
      return true;
    }
    case 'help': {
      const view = s13View(lang);
      await ctx.reply(view.text, { parse_mode: 'HTML', reply_markup: view.keyboard });
      return true;
    }
    case 'download':
      await startDownload(ctx, deps, userId);
      return true;
    case 'schedule':
      await openScheduleFor(ctx, deps, userId);
      return true;
  }
}

/** A link arrived in `awaiting_source_link`; the mode decides which flow owns it (ADR-013). */
export async function handleSourceLink(ctx: Context, deps: BotDeps): Promise<void> {
  const userId = ctx.from?.id;
  const link = ctx.message?.text?.trim();
  if (userId === undefined || !link) return;

  const download = getSession(userId).mode === 'download';
  const kind = kindOf(link, deps);
  if (download && kind === 'post') return runDownload(ctx, deps, userId, link);
  if (!download && kind === 'source') return runResolve(ctx, deps, userId, link);

  // The wrong kind of link for this screen: say which one it wants, since Retry would fail again.
  const lang = langOf(deps, userId);
  await ctx.reply(linkRequired(download ? 'post' : 'source', lang), { parse_mode: 'HTML', reply_markup: noticeKeyboard(lang) });
}

/**
 * A link pasted outside any flow is still useful: a source goes straight to S4, a post asks
 * whether to download it or subscribe to the account behind it.
 */
export async function handleFreeText(ctx: Context, deps: BotDeps): Promise<void> {
  const userId = ctx.from?.id;
  const text = ctx.message?.text?.trim();
  if (userId === undefined || !text) return;
  const { state } = getSession(userId);
  if (state !== 'idle' && state !== 'done' && state !== 'error') return;

  let match: LinkMatch;
  try {
    match = classifyLink(text, detectOpts(deps));
  } catch (err) {
    // Ordinary chatter in a private chat is not an error; only something that looks like a link is.
    if (!/^\s*https?:\/\//i.test(text)) return;
    // A link we cannot use is a one-line notice: a Retry button here would only fail again.
    setSession(userId, { state: 'idle', error: undefined });
    const lang = langOf(deps, userId);
    await ctx.reply(errorText(isCoded(err) ? err.code : E.TG_UNKNOWN, undefined, lang), { parse_mode: 'HTML', reply_markup: noticeKeyboard(lang) });
    return;
  }

  if (match.kind === 'source') return runResolve(ctx, deps, userId, text);

  // A pin link names no account; its oEmbed card does, so the chooser can still offer the source.
  const profileUrl = (await ownerOf(text, deps)) ?? (await engineOwnerOf(text, deps));
  setSession(userId, { state: 'choosing', chooser: { link: text, profile: profileUrl ?? undefined } });
  const lang = langOf(deps, userId);
  await ctx.reply(postLinkPrompt(lang), { parse_mode: 'HTML', reply_markup: postLinkKeyboard(profileUrl !== null, lang) });
}

/** The classifier's answer, or null for a link no flow can use. */
function kindOf(link: string, deps: BotDeps): LinkMatch['kind'] | null {
  try {
    return classifyLink(link, detectOpts(deps)).kind;
  } catch {
    return null;
  }
}

/** The source a post link stands for, including the oEmbed card a pin needs; null when it names none. */
async function ownerOf(link: string, deps: BotDeps): Promise<string | null> {
  const match = classifyLink(link, detectOpts(deps));
  if (match.kind === 'source') return null;
  return match.profileUrl ?? (await pinOwner(deps.http, link, detectOpts(deps)));
}

/** Platforms whose extractor names the poster, and whose profile has a feed to follow. */
const EXTRACTOR_OWNERS = new Set(['instagram', 'threads', 'tiktok', 'bluesky']);

/**
 * A bare post link names no account, but the extractor does (an Instagram reel); the chooser asks
 * it once so Download is not the only honest button. The download resolves the same post again.
 */
async function engineOwnerOf(link: string, deps: BotDeps): Promise<string | null> {
  try {
    const ref = detectSource(link, detectOpts(deps));
    if (!EXTRACTOR_OWNERS.has(ref.platform)) return null;
    const resolved = await deps.media.resolve(ref.canonicalUrl, mediaSignal(OWNER_TIMEOUT_MS));
    return resolved.artist === null ? null : profileFromAuthor(ref.platform, resolved.artist);
  } catch {
    // A post the engine cannot read is still downloadable; it just cannot offer a source.
    return null;
  }
}

/** Stage 1 reads the same settings wherever a link is classified. */
const detectOpts = (deps: BotDeps): DetectOptions => ({ rsshubBase: deps.cfg.rsshubBase, telegramBeta: deps.cfg.telegramBeta, xProfiles: deps.cfg.xProfiles });

/** The chooser from a pasted post link (`dl:post` / `add:post`). */
async function choosePost(ctx: Context, deps: BotDeps, userId: number, download: boolean): Promise<void> {
  const chooser = getSession(userId).chooser;
  if (!chooser) return restarted(ctx, deps, userId);
  // After a download the chooser already carries the profile, which is not always derivable from a URL.
  const profileUrl = download ? null : (chooser.profile ?? profileOfPost(chooser.link));
  setSession(userId, { state: 'idle', chooser: undefined });
  if (profileUrl) await runResolve(ctx, deps, userId, profileUrl);
  else await runDownload(ctx, deps, userId, chooser.link);
}

/** `/download` and the S1 button do the same work; only the delivery differs (reply vs edit). */
export async function startDownload(ctx: Context, deps: BotDeps, userId: number): Promise<void> {
  const lang = langOf(deps, userId);
  setSession(userId, { state: 'awaiting_source_link', mode: 'download', error: undefined });
  await ctx.reply(downloadPrompt(lang), { parse_mode: 'HTML', reply_markup: backKeyboard(lang) });
}

/** `/my_sources` opens the same S7 the button does, without a message to reuse. */
export async function openSourcesFor(ctx: Context, deps: BotDeps, userId: number): Promise<void> {
  await renderS7(ctx, deps, userId, 0, null, null);
}

/** `lang:<code>`: the choice is stored on the user row and S1 is repainted in that language. */
async function setLanguage(ctx: Context, deps: BotDeps, userId: number, code: string): Promise<void> {
  if (!LANGUAGES.some((language) => language.code === code)) return;
  ensureUser(deps.db, userId);
  setLocale(deps.db, userId, code);
  log('info', 'locale_set', { user: userId, locale: code });
  await paintRich(ctx, mainMenu(userId, deps));
}

async function runResolve(ctx: Context, deps: BotDeps, userId: number, link: string): Promise<void> {
  const user = ensureUser(deps.db, userId);
  ensurePrivateChat(deps.db, user.id, userId);
  const chatId = ctx.chat?.id;
  const lang = langOf(deps, userId);
  let working: number | undefined;

  try {
    // §12.4: one source-add per 10 s.
    if (!allowAdd(userId, deps.cfg.limits.addIntervalMs)) throw new Coded(E.SLOW_DOWN, 'add interval');
    const ref = resolveProfile(link, detectOpts(deps));

    // Checked before any fetch: a source the user already follows needs no preview, only a pointer.
    const known = findSourceByUrl(deps.db, ref.canonicalUrl);
    if (known && subscribedByUser(deps.db, user.id, known.id)) {
      const lang = langOf(deps, userId);
      setSession(userId, { state: 'idle', error: undefined });
      await ctx.reply(t(lang, 'notice.alreadySource', { title: esc(known.title ?? ref.externalId) }), { parse_mode: 'HTML', reply_markup: openSourcesKeyboard(lang) });
      return;
    }

    setSession(userId, { state: 'checking', error: undefined });
    working = (await ctx.reply(s3View(ref.canonicalUrl, langOf(deps, userId)).text, { parse_mode: 'HTML' })).message_id;

    const feed = await fetchFeed(deps.http, ref);
    // §5.4: every item is recorded as seen; the preview and the backfill use the newest few.
    const preview = newest(feed.items, deps.cfg.limits.backfillCount);
    const pending: PendingSource = {
      link,
      ...ref,
      author: feed.title ?? ref.externalId,
      avatarUrl: feed.avatarUrl,
      items: feed.items,
      bodyText: sourceBody({ platform: ref.platform, author: feed.title ?? ref.externalId, items: preview }),
      photo: false,
      at: Date.now(),
    };
    pending.photo = await sendPreview(ctx, deps, user.id, ref, feed, preview, lang);
    setSession(userId, { state: 'preview', pending });
  } catch (err) {
    await showError(ctx, deps, userId, err, { kind: 'source', link });
  } finally {
    if (working !== undefined && chatId !== undefined) {
      // S3 is a placeholder, not a screen: drop it so the chat matches the reference flow.
      await ctx.api.deleteMessage(chatId, working).catch(() => {});
    }
  }
}

/** Returns whether the preview went out as a photo (S5/S6 then edit a caption). */
async function sendPreview(ctx: Context, deps: BotDeps, ownerUserId: number, ref: SourceRef, feed: ParsedFeed, items: FeedItem[], lang: Lang): Promise<boolean> {
  const view = s4View({
    platform: ref.platform,
    author: feed.title ?? ref.externalId,
    avatarUrl: feed.avatarUrl,
    items,
    personalChatId: personalChat(deps.db, ownerUserId).id,
    chats: destinations(deps.db, ownerUserId),
    lang,
  });

  if (view.photoUrl) {
    try {
      await ctx.replyWithPhoto(view.photoUrl, { caption: view.text, parse_mode: 'HTML', reply_markup: view.keyboard });
      return true;
    } catch (err) {
      // An avatar URL Telegram cannot fetch must not cost the user the preview.
      log('warn', 'avatar_send_failed', { cause: message(err) });
    }
  }
  await ctx.reply(view.text, { parse_mode: 'HTML', reply_markup: view.keyboard });
  return false;
}

/** S4 → S5: the destination is chosen (§7.2 add:dest). */
async function pickDest(ctx: Context, deps: BotDeps, userId: number, chatId: number): Promise<void> {
  const session = getSession(userId);
  const pending = session.pending;
  if (!pending) return restarted(ctx, deps, userId);

  const chat = ownChat(deps.db, ensureUser(deps.db, userId).id, chatId);
  if (!chat) return showError(ctx, deps, userId, new Coded(E.BOT_NOT_ADMIN, 'destination not verified'), { kind: 'source', link: pending.link });

  setSession(userId, { state: 'add_mode', destChatId: chatId });
  const view = s5View(pending.bodyText, langOf(deps, userId));
  await editSourceMessage(ctx, pending.photo, view);
}

/** S5 → S6: stage 4 write half plus the backfill marker (§5.4). */
async function save(ctx: Context, deps: BotDeps, userId: number, deliverLatest: boolean): Promise<void> {
  const session = getSession(userId);
  const pending = session.pending;
  const chatId = session.destChatId;
  if (!pending || chatId === undefined) return restarted(ctx, deps, userId);

  const user = ensureUser(deps.db, userId);
  try {
    assertWithinSourceLimit(deps.db, user.id, deps.cfg.limits.maxSourcesPerUser);

    // The 60 s cache saves a refetch; after it expires stage 2 runs again (§4 M2.5).
    let items = pending.items;
    if (Date.now() - pending.at > PREVIEW_TTL_MS) {
      const feed = await fetchFeed(deps.http, refOf(pending));
      items = feed.items;
    }

    const result = addSource(deps.db, {
      userId: user.id,
      chatId,
      source: refOf(pending),
      title: pending.author,
      avatarUrl: pending.avatarUrl,
      items,
      deliverLatest,
      backfillCount: deps.cfg.limits.backfillCount,
    });

    log('info', 'source_added', { source: result.sourceId, pending: result.pending });
    setSession(userId, { state: 'done', pending: undefined, destChatId: undefined });
    const view = s6View(pending.author, langOf(deps, userId));
    await editSourceMessage(ctx, pending.photo, view);
  } catch (err) {
    await showError(ctx, deps, userId, err, { kind: 'source', link: pending.link });
  }
}

/** S7 (§7.2 menu:sources): one message holds the list, its actions and the pager. */
async function openSources(ctx: Context, deps: BotDeps, userId: number): Promise<void> {
  const headerId = ctx.callbackQuery?.message?.message_id ?? null;
  await renderS7(ctx, deps, userId, 0, null, headerId);
}

async function changeFilter(ctx: Context, deps: BotDeps, userId: number, platform: string): Promise<void> {
  const active = platform === 'all' ? null : platform;
  await renderS7(ctx, deps, userId, 0, active, getSession(userId).s7?.headerId ?? null);
}

/** Every action re-renders this one message, so the list never drifts from the database. */
async function renderS7(ctx: Context, deps: BotDeps, userId: number, page: number, platform: string | null, headerId: number | null): Promise<void> {
  const user = ensureUser(deps.db, userId);
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return;

  let pageIndex = Math.max(0, page);
  let { rows, total } = listSourceCards(deps.db, user.id, platform, PAGE_SIZE, pageIndex * PAGE_SIZE);
  if (rows.length === 0 && pageIndex > 0) {
    pageIndex = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1);
    ({ rows, total } = listSourceCards(deps.db, user.id, platform, PAGE_SIZE, pageIndex * PAGE_SIZE));
  }

  const view = s7View({
    cards: rows,
    offset: pageIndex * PAGE_SIZE,
    total,
    platforms: platformsForUser(deps.db, user.id),
    active: platform,
    page: pageIndex,
    lang: langOf(deps, userId),
  });
  const rich = { reply_markup: view.keyboard, message_thread_id: ctx.msg?.message_thread_id };

  // The list reuses the message the user tapped when we have it; otherwise it is a new message.
  let resolvedHeaderId = headerId;
  if (resolvedHeaderId === null) {
    resolvedHeaderId = (await ctx.api.sendRichMessage(chatId, { html: view.html }, rich)).message_id;
  } else {
    try {
      await ctx.api.editMessageText(chatId, resolvedHeaderId, { html: view.html }, { reply_markup: view.keyboard });
    } catch (err) {
      if (!notModified(err)) {
        // The old message was deleted or is too old to edit; send a fresh one.
        resolvedHeaderId = (await ctx.api.sendRichMessage(chatId, { html: view.html }, rich)).message_id;
      }
    }
  }

  const state: S7State = { headerId: resolvedHeaderId, page: pageIndex, platform };
  setSession(userId, { s7: state, state: 'idle' });
}

/** S8: toggling flips `sources.enabled` and re-renders the list in place. */
async function toggle(ctx: Context, deps: BotDeps, userId: number, data: string): Promise<void> {
  const enabled = data.startsWith(cb.on);
  const sourceId = idOf(data, enabled ? cb.on : cb.off);
  const user = ensureUser(deps.db, userId);
  if (!ownsSource(deps.db, user.id, sourceId)) return;

  setSourceEnabled(deps.db, sourceId, enabled);
  const state = getSession(userId).s7;
  await renderS7(ctx, deps, userId, state?.page ?? 0, state?.platform ?? null, state?.headerId ?? null);
}

/** S9 (§4.6): a priority-100 job that never moves next_slot_at, capped at 30 per hour. */
async function queueCheck(ctx: Context, deps: BotDeps, userId: number, sourceId: number, toast: string | undefined, lang: Lang): Promise<void> {
  const user = ensureUser(deps.db, userId);
  if (!allowCheck(user.id, deps.cfg.limits.checksPerHour)) {
    await ctx.answerCallbackQuery({ text: genericToast(lang).checksExhausted });
    return;
  }
  await ctx.answerCallbackQuery(toast === undefined ? undefined : { text: toast });
  if (!ownsSource(deps.db, user.id, sourceId)) return;
  enqueue(deps.db, { kind: 'manual_check', targetId: sourceId, priority: PRIORITY.manual });
}

/** S16 (§4.3): the list of sources with their cadence; `/schedule` and `menu:schedule` share it. */
export async function openScheduleFor(ctx: Context, deps: BotDeps, userId: number): Promise<void> {
  await renderSchedule(ctx, deps, userId, 0);
}

async function renderSchedule(ctx: Context, deps: BotDeps, userId: number, page: number): Promise<void> {
  const user = ensureUser(deps.db, userId);
  let pageIndex = Math.max(0, page);
  let { rows, total } = listSourceCards(deps.db, user.id, null, PAGE_SIZE, pageIndex * PAGE_SIZE);
  if (rows.length === 0 && pageIndex > 0) {
    pageIndex = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1);
    ({ rows, total } = listSourceCards(deps.db, user.id, null, PAGE_SIZE, pageIndex * PAGE_SIZE));
  }

  setSession(userId, { state: 'idle', s16: { page: pageIndex } });
  const view = s16List({ cards: rows, offset: pageIndex * PAGE_SIZE, total, page: pageIndex, lang: langOf(deps, userId) });
  await paintOrReply(ctx, view);
}

async function schedulePicker(ctx: Context, deps: BotDeps, userId: number, sourceId: number): Promise<void> {
  const card = getSourceCard(deps.db, ensureUser(deps.db, userId).id, sourceId);
  if (!card) return;
  await paint(ctx, s16Picker(card, langOf(deps, userId)));
}

/** `sched:set:<source>:<minutes>` for one source, `sched:setall:<minutes>` for the whole list; 0 is the default. */
async function applySchedule(ctx: Context, deps: BotDeps, userId: number, data: string, toast: string | undefined, lang: Lang): Promise<void> {
  await ctx.answerCallbackQuery(toast === undefined ? undefined : { text: toast });

  const all = data.startsWith(cb.schedSetAll);
  const parts = data.slice((all ? cb.schedSetAll : cb.schedSet).length).split(':');
  const minutes = Number(all ? parts[0] : parts[1]) === 0 ? null : Number(all ? parts[0] : parts[1]);
  const sourceId = all ? null : Number(parts[0]);
  // Only the offered values are legal; anything else is a forged callback.
  if ((!all && !Number.isInteger(sourceId)) || (minutes !== null && !SCHEDULE_OPTIONS.includes(minutes))) return;

  const user = ensureUser(deps.db, userId);
  const targets = all
    ? sourceIdsForUser(deps.db, user.id)
    : sourceId !== null && ownsSource(deps.db, user.id, sourceId)
      ? [sourceId]
      : [];
  if (targets.length === 0) return;

  const now = Date.now();
  tx(deps.db, () => {
    for (const id of targets) {
      setSourceInterval(deps.db, id, minutes);
      // The new cadence applies now, not at the old slot (§4.3).
      for (const slot of subscriptionSlots(deps.db, id)) setNextSlot(deps.db, slot.id, slotAfter(now, slot.tz, minutes));
    }
  });
  log('info', 'schedule_set', { sources: targets.length, minutes });

  if (all) return paint(ctx, s16Picker(null, lang));
  const card = sourceId === null ? undefined : getSourceCard(deps.db, user.id, sourceId);
  if (card) await paint(ctx, s16Picker(card, lang));
}

/** S10: the confirm is a separate message, so a mis-tap cannot delete anything (ADR-016). */
async function askDelete(ctx: Context, deps: BotDeps, userId: number, sourceId: number): Promise<void> {
  const user = ensureUser(deps.db, userId);
  if (!ownsSource(deps.db, user.id, sourceId)) return;
  const source = getSource(deps.db, sourceId);
  const view = s10View(source?.title ?? `#${sourceId}`, sourceId, langOf(deps, userId));
  await ctx.reply(view.text, { parse_mode: 'HTML', reply_markup: view.keyboard });
}

/** S11: cascade then re-render S7; the toast is the callback answer. */
async function confirmDelete(ctx: Context, deps: BotDeps, userId: number, sourceId: number): Promise<void> {
  const user = ensureUser(deps.db, userId);
  const state = getSession(userId);
  await ctx.deleteMessage().catch(() => {});

  if (ownsSource(deps.db, user.id, sourceId)) {
    tx(deps.db, () => {
      deleteSubscription(deps.db, user.id, sourceId);
      // Posts and the source itself go only when nobody else is subscribed (§7.2).
      deleteSourceIfOrphan(deps.db, sourceId);
    });
    log('info', 'source_deleted', { source: sourceId });
  }
  await renderS7(ctx, deps, userId, state.s7?.page ?? 0, state.s7?.platform ?? null, state.s7?.headerId ?? null);
}

async function goBack(ctx: Context, deps: BotDeps, userId: number): Promise<void> {
  const session = getSession(userId);
  setSession(userId, { s7: undefined });

  if (session.state === 'add_mode' && session.pending) {
    setSession(userId, { state: 'preview', destChatId: undefined });
    const owner = ensureUser(deps.db, userId);
    const view = s4View({
      platform: session.pending.platform,
      author: session.pending.author,
      avatarUrl: session.pending.avatarUrl,
      items: newest(session.pending.items, deps.cfg.limits.backfillCount),
      personalChatId: personalChat(deps.db, owner.id).id,
      chats: destinations(deps.db, owner.id),
      lang: langOf(deps, userId),
    });
    return editSourceMessage(ctx, session.pending.photo, view);
  }
  if (session.state === 'preview') {
    setSession(userId, { state: 'awaiting_source_link', pending: undefined });
    return paint(ctx, s2View(deps.cfg.telegramBeta, langOf(deps, userId)));
  }
  resetSession(userId);
  return paintRich(ctx, mainMenu(userId, deps));
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
    await ctx.api.sendMessage(tgChatId, errorText(code, undefined, langOf(deps, userId)), { parse_mode: 'HTML', reply_markup: errorKeyboard(langOf(deps, userId)) }).catch(() => {});
  }
}

async function retry(ctx: Context, deps: BotDeps, userId: number): Promise<void> {
  const last = getSession(userId).error;
  if (last?.kind === 'source') return runResolve(ctx, deps, userId, last.link);
  if (last?.kind === 'download') return runDownload(ctx, deps, userId, last.link);
  if (last?.kind === 'chat') return verifyAndStoreChat(ctx, deps, last.tgChatId);
  setSession(userId, { state: 'awaiting_source_link' });
  return paint(ctx, s2View(deps.cfg.telegramBeta, langOf(deps, userId)));
}

/**
 * Download mode (ADR-013, OQ-8): stages 1 and 3–7 without a subscription. The delivery row keeps
 * post_id NULL because no `posts` row exists for a single link.
 */
async function runDownload(ctx: Context, deps: BotDeps, userId: number, link: string): Promise<void> {
  const user = ensureUser(deps.db, userId);
  const chat = ensurePrivateChat(deps.db, user.id, userId);
  const chatId = ctx.chat?.id;
  let working: number | undefined;

  try {
    const ref = detectSource(link, detectOpts(deps));
    // A website page is a post too: only a real profile on a known platform is refused here.
    const websitePage = isWebsitePage(ref);
    if (ref.strategy !== 'single_post' && !websitePage) throw new Coded(E.POST_REQUIRED, 'profile link in download mode');

    const since = Date.now() - 24 * 60 * 60 * 1000;
    if (countDownloadsSince(deps.db, user.id, since) >= deps.cfg.limits.maxDownloadsPerDay) {
      throw new Coded(E.DOWNLOAD_LIMIT, 'daily quota');
    }

    setSession(userId, { state: 'checking', error: undefined });
    working = (await ctx.reply(s3View(ref.canonicalUrl, langOf(deps, userId)).text, { parse_mode: 'HTML' })).message_id;

    const target = targetOf(chat.tg_chat_id, chat.message_thread_id, chat.type);

    // A blog or website arrives as an Instant View article, exactly like a scheduled one.
    if (websitePage) {
      const article = await planArticle({ http: deps.http, telegraph: deps.telegraph }, {
        url: ref.canonicalUrl,
        title: null,
        publishedAt: null,
        sourceTitle: new URL(ref.canonicalUrl).hostname.replace(/^www\./, ''),
        platform: ref.platform,
      });
      if (!article) throw new Coded(E.FEED_DOWN, 'article extraction failed');
      const ids = await deps.sender.send(article, target);
      recordDelivery(deps.db, { postId: null, chatId: chat.id, status: 'sent', parts: ids.length, messageIds: ids.join(','), errorCode: null });
      log('info', 'download_article', { user: userId, parts: ids.length });
      const lang = langOf(deps, userId);
      const source = await ownerOf(link, deps);
      setSession(userId, { state: 'idle', mode: undefined, chooser: source === null ? undefined : { link: source, profile: source } });
      await ctx.reply(downloadDone(lang), { parse_mode: 'HTML', reply_markup: downloadResultKeyboard(lang, source !== null) });
      return;
    }

    const signal = mediaSignal(DOWNLOAD_TIMEOUT_MS);
    const dir = workDirFor(`download-${userId}-${Date.now()}`);
    let engineAuthor: string | null = null;
    let channel: PagePost['channel'] = null;
    let plan: MessagePlan;
    try {
      // Threads and YouTube render the post itself into the page; cobalt would only see a video.
      const page = await pageOrNull(ref.platform, deps, ref.canonicalUrl);
      if (page !== null) {
        engineAuthor = page.author;
        channel = page.channel;
        plan = await pagePostDelivery(deps, page, ref.canonicalUrl, dir, signal, ref.platform);
      } else {
        const resolved = await deps.media.resolve(ref.canonicalUrl, signal);
        // X/Twitter, TikTok and Facebook extractors return media only; the page still names its words.
        // X's public text surfaces stop at 280, so the full post comes from the mirror when it answers.
        // One page fetch carries what the extractor did not: the account, the date, the words.
        const meta = await pageMeta(deps.http, ref.canonicalUrl);
        const engineText = resolved.title?.trim() || null;
        const text = (ref.platform === 'x' ? await xFullText(deps.http, ref.canonicalUrl) : null) ?? engineText ?? meta.text;
        engineAuthor = resolved.artist?.trim() || null;
        // The page names the account as it prints it; then the extractor, then the account the link names.
        const owner = profileOfPost(ref.canonicalUrl);
        const source = meta.name ?? engineAuthor ?? (owner !== null ? nameOf(owner) : text === null ? null : hostOf(ref.canonicalUrl));
        const files = await prepareMedia(deps.media, resolved.items, dir, { maxMb: deps.cfg.limits.maxDownloadMb, signal });
        // A long caption keeps the media and links the rest to Instant View, like a scheduled post.
        const page: ReadMorePage = {
          id: 0,
          url: ref.canonicalUrl,
          publishedAt: meta.publishedAt,
          // The post's own words are the body; a title here would print its first line twice.
          title: null,
          parts: text === null ? [] : [text],
          images: resolved.items.filter((item) => item.kind === 'photo').map((item) => item.url),
        };
        plan = await withReadMore(renderDownload(files, { title: text, artist: source, publishedAt: meta.publishedAt, platform: ref.platform }, ref.canonicalUrl), page, { telegraph: deps.telegraph, sourceTitle: source }, new Map());
      }
      const ids = await deps.sender.send(plan, target);
      recordDelivery(deps.db, { postId: null, chatId: chat.id, status: 'sent', parts: ids.length, messageIds: ids.join(','), errorCode: null });
      log('info', 'download_done', { user: userId, parts: ids.length });
    } finally {
      await cleanupWorkDir(dir);
    }
    // A bare post link does not name its account; the page, the engine or the link itself does.
    const lang = langOf(deps, userId);
    const named = channel?.url ?? (engineAuthor === null ? null : profileFromAuthor(ref.platform, engineAuthor));
    const profile = named ?? (await ownerOf(link, deps));
    // The label may only promise the account the button will add, so a link-derived source gets the plain one.
    const handle = named === null ? null : (channel?.handle ?? engineAuthor);
    setSession(userId, { state: 'idle', mode: undefined, chooser: profile === null ? undefined : { link: profile, profile } });
    await ctx.reply(downloadDone(lang), {
      parse_mode: 'HTML',
      reply_markup: downloadResultKeyboard(lang, profile !== null, handle),
    });
  } catch (err) {
    await showError(ctx, deps, userId, err, { kind: 'download', link });
  } finally {
    if (working !== undefined && chatId !== undefined) await ctx.api.deleteMessage(chatId, working).catch(() => {});
  }
}

/** What a page-rendered post hands the renderer: who wrote it, its words, and what to download. */
interface PagePost {
  author: string | null;
  /** The name the account prints; a handle alone is not what a header shows. */
  name: string | null;
  publishedAt: number | null;
  /** The account to offer as a source; only a page that names its channel can. */
  channel: { url: string; handle: string } | null;
  text: string;
  items: MediaItem[];
}

/**
 * Threads and YouTube render the post itself into the page. Threads keeps cobalt behind it; a
 * community post has no cobalt extractor, so a YouTube failure is surfaced instead of retried.
 */
async function pageOrNull(platform: string, deps: BotDeps, url: string): Promise<PagePost | null> {
  if (platform === 'threads') return threadsPage(deps, url);
  if (platform === 'youtube') return youtubePage(deps, url);
  // cobalt has no Snapchat extractor, so the page itself is the only door.
  if (platform === 'snapchat') return snapchatPage(deps, url);
  return null;
}

async function threadsPage(deps: BotDeps, url: string): Promise<PagePost | null> {
  try {
    const thread = await fetchThreadsThread(deps.http, url);
    return {
      author: thread.author,
      name: thread.name,
      publishedAt: thread.posts[0]?.publishedAt ?? null,
      channel: null,
      text: threadText(thread),
      items: thread.posts.flatMap((post) => post.media.map((media) => ({ kind: media.type, url: media.url, picker: false }))),
    };
  } catch (err) {
    return pageFallback(err, 'threads', url);
  }
}

async function youtubePage(deps: BotDeps, url: string): Promise<PagePost | null> {
  // cobalt has no extractor for a community post, so a failure here is the honest answer: a
  // fallback would only turn "this post is gone" into "couldn't extract media".
  const post = await fetchYouTubePost(deps.http, url);
  return {
    author: post.author,
    name: null,
    publishedAt: post.publishedAt,
    channel: post.channel,
    text: post.text,
    items: post.media.map((photo) => ({ kind: 'photo' as const, url: photo, picker: false })),
  };
}

/** Snapchat's spotlight page carries the clip, the words and the date in its head. */
async function snapchatPage(deps: BotDeps, url: string): Promise<PagePost> {
  const meta = await pageMeta(deps.http, url);
  // A page that names neither words nor a clip is the same dead end cobalt reports.
  if (meta.text === null && meta.video === null) throw new Coded(E.NO_MEDIA, 'snapchat page carried no post');
  return {
    author: null,
    name: meta.name,
    publishedAt: meta.publishedAt,
    channel: null,
    text: meta.text ?? '',
    items: meta.video === null ? [] : [{ kind: 'video' as const, url: meta.video, picker: false }],
  };
}

/** Any page-side refusal or outage still has cobalt behind it, exactly as before the adapter. */
function pageFallback(err: unknown, adapter: string, url: string): null {
  if (isCoded(err) && err.code !== E.LINK_INVALID) {
    log('warn', `${adapter}_fallback`, { url, error: err.code });
    return null;
  }
  throw err;
}

/** One message for a post the page itself carried: its words, then its media, tail on Instant View. */
async function pagePostDelivery(deps: BotDeps, post: PagePost, link: string, dir: string, signal: AbortSignal, platform: string): Promise<MessagePlan> {
  const text = post.text;
  // The account names the source; an unnamed one falls back to the host, so the text stays the body.
  const source = post.name ?? post.author ?? hostOf(link);
  const header = postHeader({ sourceTitle: source, url: link, publishedAt: post.publishedAt, platform });

  let files: MediaFile[] = [];
  try {
    files = await prepareMedia(deps.media, post.items, dir, { maxMb: deps.cfg.limits.maxDownloadMb, signal });
  } catch (err) {
    // Over the size cap the post still ships its words; the media is the part that is lost.
    log('warn', 'page_media_failed', { code: isCoded(err) ? err.code : 'unknown' });
  }
  if (files.length === 0) return { kind: 'text', text: text === '' ? header : `${header}\n\n${esc(text)}` };

  // A caption past the limit keeps the media and moves the post's tail to an Instant View page.
  const page: ReadMorePage = { id: 0, url: link, publishedAt: null, title: null, parts: text === '' ? [] : [text], images: post.items.filter((item) => item.kind === 'photo').map((item) => item.url) };
  const plan = renderDownload(files, { title: text === '' ? null : text, artist: source, publishedAt: post.publishedAt, platform }, link);
  return withReadMore(plan, page, { telegraph: deps.telegraph, sourceTitle: source }, new Map());
}

async function showError(ctx: Context, deps: BotDeps, userId: number, err: unknown, last: LastError): Promise<void> {
  const code = isCoded(err) ? err.code : E.TG_UNKNOWN;
  log('warn', 'check_failed', { code, cause: message(err) });
  // Stay ready for the next link: sending a new one is the natural retry for a bad link.
  setSession(userId, { state: 'awaiting_source_link', error: last });
  const limit = code === E.SOURCE_LIMIT ? deps.cfg.limits.maxSourcesPerUser : code === E.DOWNLOAD_LIMIT ? deps.cfg.limits.maxDownloadsPerDay : undefined;
  const lang = langOf(deps, userId);
  await ctx.reply(errorText(code, limit, lang), { parse_mode: 'HTML', reply_markup: errorKeyboard(lang) });
}

/** The chat was built by a previous session state that no longer exists. */
async function restarted(ctx: Context, deps: BotDeps, userId: number): Promise<void> {
  setSession(userId, { state: 'awaiting_source_link', pending: undefined, destChatId: undefined, error: undefined });
  const lang = langOf(deps, userId);
  await ctx.reply(errorText(E.TG_UNKNOWN, undefined, lang), { parse_mode: 'HTML', reply_markup: errorKeyboard(lang) });
}

function toastFor(data: string, lang: Lang): string | undefined {
  const toast = actionToast(lang);
  if (data.startsWith(cb.on)) return toast.enabled;
  if (data.startsWith(cb.off)) return toast.disabled;
  if (data.startsWith(cb.check)) return toast.checkQueued;
  if (data.startsWith(cb.schedSetAll)) return toast.scheduleSet;
  if (data.startsWith(cb.schedSet)) return toast.scheduleSet;
  // The list, its pager and the bulk picker answer silently; only a cadence change deserves a toast.
  if (data.startsWith(cb.schedOpen) || data.startsWith(cb.schedPage) || data === cb.schedAll) return undefined;
  if (data.startsWith(cb.delOk)) return toast.deleted;
  switch (data) {
    case cb.sources:
    case cb.add:
    case cb.back:
    case cb.home:
    case cb.retry:
    case cb.save:
    case cb.saveSilent:
    case cb.download:
    case cb.downloadMore:
    case cb.downloadPost:
    case cb.addPost:
    case cb.supported:
    case cb.help:
    case cb.language:
    case cb.schedule:
      return undefined;
    default:
      return genericToast(lang).unknown;
  }
}

export function mainMenu(userId: number, deps: BotDeps): RichView {
  const user = ensureUser(deps.db, userId);
  return s1View({
    userId,
    sourceCount: countSubscriptionsForUser(deps.db, user.id),
    limit: deps.cfg.limits.maxSourcesPerUser,
    trialEnabled: deps.cfg.trialEnabled,
    lang: langFor(user.locale),
  });
}

/** §5.4: the newest N items, returned oldest → newest. */
export function newest(items: FeedItem[], count: number): FeedItem[] {
  return [...items].sort((a, b) => (a.publishedAt ?? 0) - (b.publishedAt ?? 0)).slice(-count);
}

const refOf = (pending: PendingSource): SourceRef => ({
  platform: pending.platform,
  canonicalUrl: pending.canonicalUrl,
  externalId: pending.externalId,
  feedUrl: pending.feedUrl,
  strategy: pending.strategy,
});

const idOf = (data: string, prefix: string): number => Number(data.slice(prefix.length));

/** A header label for a post nobody signed: the site itself is the least invented name. */
const hostOf = (url: string): string => new URL(url).hostname.replace(/^www\./, '');

/** `@account` for a profile URL, the site itself for an origin: what a caption can promise. */
function nameOf(profileUrl: string): string {
  const segment = new URL(profileUrl).pathname.split('/').filter(Boolean).pop();
  // A numeric Facebook page id reads better as its host than as a fake handle.
  return segment === undefined || /^\d+$/.test(segment) ? hostOf(profileUrl) : `@${decodeURIComponent(segment).replace(/^@/, '')}`;
}

/** Screens replace the current message so the chat does not fill with drafts. */
async function paint(ctx: Context, view: View): Promise<void> {
  try {
    await ctx.editMessageText(view.text, { parse_mode: 'HTML', reply_markup: view.keyboard });
  } catch (err) {
    if (notModified(err)) return;
    throw err;
  }
}

/** A command has no message to edit; the S1 button does. */
async function paintOrReply(ctx: Context, view: View): Promise<void> {
  if (ctx.callbackQuery?.message !== undefined) return paint(ctx, view);
  await ctx.reply(view.text, { parse_mode: 'HTML', reply_markup: view.keyboard });
}

/** Same, for a rich message: the body travels in the html field, not in text. */
async function paintRich(ctx: Context, view: RichView): Promise<void> {
  const chatId = ctx.chat?.id;
  const messageId = ctx.callbackQuery?.message?.message_id;
  if (chatId === undefined || messageId === undefined) return;
  try {
    await ctx.api.editMessageText(chatId, messageId, { html: view.html }, { reply_markup: view.keyboard });
  } catch (err) {
    if (notModified(err)) return;
    throw err;
  }
}

/** S4/S5/S6 all live in one message, which is a photo when the source has an avatar. */
async function editSourceMessage(ctx: Context, photo: boolean, view: View): Promise<void> {
  const chatId = ctx.chat?.id;
  const messageId = ctx.callbackQuery?.message?.message_id;
  if (chatId === undefined || messageId === undefined) return;
  try {
    if (photo) await ctx.api.editMessageCaption(chatId, messageId, { caption: view.text, parse_mode: 'HTML', reply_markup: view.keyboard });
    else await ctx.api.editMessageText(chatId, messageId, view.text, { parse_mode: 'HTML', reply_markup: view.keyboard });
  } catch (err) {
    if (notModified(err)) return;
    throw err;
  }
}

async function editMessage(ctx: Context, view: View): Promise<void> {
  await paint(ctx, view);
}

/** A double tap can re-render identical content; Telegram rejects that, and it is harmless. */
function notModified(err: unknown): boolean {
  return err instanceof GrammyError && err.description.includes('message is not modified');
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** One link must never hold a worker slot forever (M8 adds the job-level timeout). */
const DOWNLOAD_TIMEOUT_MS = 120_000;

/** Naming the poster of a pasted link is a nicety; it never holds the chooser for long. */
const OWNER_TIMEOUT_MS = 10_000;
