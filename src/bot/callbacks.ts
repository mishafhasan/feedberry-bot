import { GrammyError, type Context, type InlineKeyboard } from 'grammy';
import type { Config } from '../config.ts';
import { tx, type Db } from '../db/index.ts';
import { destinations, ensurePrivateChat, ownChat, personalChat, upsertChat } from '../db/repos/chats.ts';
import { countDownloadsSince } from '../db/repos/deliveries.ts';
import { deleteSourceIfOrphan, findSourceByUrl, getSource, setSourceEnabled, setSourceInterval } from '../db/repos/sources.ts';
import { deleteSubscription, countSubscriptionsForUser, getSourceCard, listSourceCards, ownsSource, platformsForUser, sourceIdsForUser, subscribedByUser, setNextSlot, subscriptionCard, subscriptionSlots, setSubscriptionContentTypes } from '../db/repos/subscriptions.ts';
import { ensureUser, setLocale } from '../db/repos/users.ts';
import { log } from '../obs/log.ts';
import type { MediaEngine, MediaItem } from '../media/media-engine.ts';
import { type Thumbnailer } from '../media/thumbnail.ts';
import { Coded, E, isCoded } from '../platform/errors.ts';
import type { FeedItem, ParsedFeed } from '../platform/feed/native.ts';
import { fetchThreadsThread, threadText } from '../platform/feed/threads.ts';
import { fetchYouTubePost, youtubePostId } from '../platform/feed/youtube-post.ts';
import type { Http } from '../platform/http.ts';
import { CONTENT_KINDS, filterByContentTypes, parseContentTypes, type ContentKind } from '../platform/content-types.ts';
import { classifyLink, detectSource, isWebsitePage, linksIn, profileFromAuthor, profileOfPost, sectionOf, type DetectOptions, type LinkMatch, type SourceRef } from '../platform/registry.ts';
import { pinOwner } from '../platform/pinterest-pin.ts';
import { pageMeta } from '../platform/page-text.ts';
import { youtubeChannelOf } from '../platform/youtube-channel.ts';
import { xFullText } from '../platform/x-text.ts';
import { resolveProfile } from '../pipeline/resolve-source.ts';
import { fetchPageSource, fetchSourceFeed } from '../pipeline/fetch-feed.ts';
import { addSource, assertWithinSourceLimit } from '../pipeline/dedupe.ts';
import { mediaSignal, prepareMedia } from '../pipeline/prepare-media.ts';
import { formatKeywords } from '../pipeline/keyword-filter.ts';
import { renderDownload } from '../pipeline/render-post.ts';
import { type MediaFile, type MessagePlan } from '../render/message-plan.ts';
import { planArticle } from '../pipeline/article-plan.ts';
import type { TelegraphClient } from '../article/telegraph.ts';
import { menuLabels, replyMenu } from './reply-menu.ts';
import { recordDelivery } from '../pipeline/record-delivery.ts';
import { cleanupWorkDir, workDirFor } from '../pipeline/cleanup.ts';
import { enqueue, PRIORITY } from '../jobs/queue.ts';
import { slotAfter } from '../scheduler/slots.ts';
import type { TelegramSender } from '../telegram/api.ts';
import { morePayload } from '../telegram/more.ts';
import { targetOf } from '../telegram/target.ts';
import { PREVIEW_TTL_MS, getSession, resetSession, setSession, type LastError, type PendingSource, type S7State } from './session.ts';
import { allowAdd, allowCallback, allowCheck } from './quotas.ts';
import { backKeyboard, downloadResultKeyboard, errorKeyboard, noticeKeyboard, openSourcesKeyboard, postLinkKeyboard, LANGUAGES } from './keyboards.ts';
import { handleAdminCallback } from './admin.ts';
import { askDefaultKeywords, askPendingKeywords, askSourceKeywords, clearDefaultKeywords, clearKeywords, openFilterFor } from './keywords.ts';
import { mainMenuView } from './screens/main-menu.ts';
import { deleteConfirmView } from './screens/delete-confirm.ts';
import { addSourceView } from './screens/add-source.ts';
import { checkingView } from './screens/checking.ts';
import { sourcePreviewView } from './screens/source-preview.ts';
import { deliveryOptionsView } from './screens/delivery-options.ts';
import { sourceAddedView } from './screens/source-added.ts';
import { mySourcesView, PAGE_SIZE } from './screens/my-sources.ts';
import { supportedSitesView } from './screens/supported-sites.ts';
import { helpView, aboutView, languageView } from './screens/static-screens.ts';
import { scheduleListView, schedulePickerView, SCHEDULE_OPTIONS } from './screens/schedule.ts';
import { contentTypePickerView } from './screens/content-type-picker.ts';
import { ADM } from './screens/admin-screens.ts';
import { langFor, t, type Lang } from './i18n/index.ts';
import { actionToast, downloadDone, downloadPrompt, errorText, esc, genericToast, linkInvalid, linkRequired, oneLink, postLinkPrompt, sourceBody, sourceTitle } from './texts.ts';

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
  filterMenu: 'menu:filter',
  help: 'menu:help',
  language: 'menu:language',
  lang: 'lang:',
  schedule: 'menu:schedule',
  schedOpen: 'src:sched:',
  schedSet: 'sched:set:',
  schedPage: 'sched:page:',
  schedAll: 'sched:all',
  schedSetAll: 'sched:setall:',
  typesOpen: 'ct:open:',
  typesToggle: 'ct:t:',
  typesDone: 'ct:done',
  typesAll: 'ct:all',
  typesBack: 'ct:back',
  keywords: 'add:kw',
  kwEdit: 'kw:edit:',
  kwClear: 'kw:clear:',
  kwDefault: 'kw:def',
  kwClearDefault: 'kw:cleardef',
  kwPage: 'kw:page:',
} as const;

export interface BotDeps {
  cfg: Config;
  db: Db;
  http: Http;
  media: MediaEngine;
  /** Frame for a video past the upload ceiling (R15). */
  thumbnail: Thumbnailer;
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

  // ADR-024: "Show more" rewrites the post in place; it is not a menu action, so it skips the quota.
  if (data.startsWith('more:')) return expandPost(ctx, deps, data.slice('more:'.length));

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
  if (data === cb.schedAll) return paint(ctx, schedulePickerView(null, lang));

  if (data.startsWith(cb.lang)) return setLanguage(ctx, deps, userId, data.slice(cb.lang.length));

  if (data === cb.typesDone) return saveTypes(ctx, deps, userId, lang);
  if (data === cb.typesAll) return selectAllTypes(ctx, deps, userId, lang);
  if (data === cb.typesBack) return backFromTypes(ctx, deps, userId, lang);
  if (data.startsWith(cb.typesToggle)) return toggleType(ctx, deps, userId, data.slice(cb.typesToggle.length), lang);
  if (data.startsWith(cb.typesOpen)) return openTypesForSource(ctx, deps, userId, idOf(data, cb.typesOpen), lang);

  if (data === cb.downloadPost || data === cb.addPost) return choosePost(ctx, deps, userId, data === cb.downloadPost);

  if (data === cb.keywords) return askPendingKeywords(ctx, deps, userId, ctx.callbackQuery?.message?.message_id);
  if (data === cb.kwDefault) return askDefaultKeywords(ctx, deps, userId, getSession(userId).kwPage ?? 0);
  if (data === cb.kwClearDefault) return clearDefaultKeywords(ctx, deps, userId, getSession(userId).kwPage ?? 0);
  if (data.startsWith(cb.kwClear)) return clearKeywords(ctx, deps, userId, idOf(data, cb.kwClear), getSession(userId).kwPage ?? 0);
  if (data.startsWith(cb.kwEdit)) return askSourceKeywords(ctx, deps, userId, idOf(data, cb.kwEdit), getSession(userId).kwPage ?? 0);
  if (data.startsWith(cb.kwPage)) return openFilterFor(ctx, deps, userId, idOf(data, cb.kwPage));

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
      return paint(ctx, addSourceView(deps.cfg.telegramBeta, lang));
    case cb.save:
      return save(ctx, deps, userId, true);
    case cb.saveSilent:
      return save(ctx, deps, userId, false);
    case cb.sources:
      return openSources(ctx, deps, userId);
    case cb.supported:
      return paint(ctx, supportedSitesView(lang));
    case cb.filterMenu:
      return openFilterFor(ctx, deps, userId);
    case cb.help:
      return paint(ctx, helpView(lang));
    case cb.language:
      return paint(ctx, languageView(lang));
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

/** The label the old keyboard shipped; only a chat that has not seen /start since can still send it. */
const LEGACY_HIDE = '✖️ Hide menu';

/** A reply-keyboard tap arrives as text; this maps it back to the same actions. */
export async function handleReplyMenu(ctx: Context, deps: BotDeps, userId: number, text: string): Promise<boolean> {
  const lang = langOf(deps, userId);
  // The row this rework deleted: a chat that still shows the old keyboard must not be stuck with a dead
  // button and no keyboard icon. Tapping it installs the new, foldable menu instead.
  if (text.trim() === LEGACY_HIDE) {
    await ctx.reply(t(lang, 'notice.menuReady'), { reply_markup: replyMenu(lang) });
    return true;
  }
  const action = menuLabels(lang).get(text.trim());
  if (!action) return false;

  switch (action) {
    case 'add': {
      setSession(userId, { state: 'awaiting_source_link', mode: undefined, error: undefined });
      const view = addSourceView(deps.cfg.telegramBeta, lang);
      await ctx.reply(view.text, { parse_mode: 'HTML', reply_markup: view.keyboard });
      return true;
    }
    case 'sources':
      await renderS7(ctx, deps, userId, 0, null, null);
      return true;
    case 'filter':
      await openFilterFor(ctx, deps, userId);
      return true;
    case 'supported': {
      const view = supportedSitesView(lang);
      await ctx.reply(view.text, { parse_mode: 'HTML', reply_markup: view.keyboard });
      return true;
    }
    case 'help': {
      const view = helpView(lang);
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
  const text = ctx.message?.text?.trim();
  if (userId === undefined || !text) return;

  const download = getSession(userId).mode === 'download';
  const links = linksIn(text);
  const [link] = links;
  // No link, or several: say what to send, since neither Retry nor a download would help.
  if (link === undefined || links.length > 1) return answerUnusable(ctx, deps, userId, text, links.length, download ? 'post' : 'source');

  const kind = kindOf(link, deps);
  // A website page is one article (download) or one category (subscribe); both flows take it.
  const page = isPageLink(link, deps);
  if (download && (kind === 'post' || page)) return runDownload(ctx, deps, userId, link);
  if (!download && (kind === 'source' || page)) return resolveOrAskTypes(ctx, deps, userId, link);

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
  // The chooser is a prompt, not a draft: a new link replaces it instead of being ignored.
  if (state !== 'idle' && state !== 'done' && state !== 'error' && state !== 'choosing') return;

  const links = linksIn(text);
  const [link] = links;
  // Ordinary chatter in a private chat is not an error; only something that meant a link is.
  if (link === undefined && !looksLikeLink(text)) return;
  if (link === undefined || links.length > 1) {
    setSession(userId, { state: 'idle', error: undefined });
    return answerUnusable(ctx, deps, userId, text, links.length, 'source');
  }

  let match: LinkMatch;
  try {
    match = classifyLink(link, detectOpts(deps));
  } catch (err) {
    // A link we cannot use is a one-line notice: a Retry button here would only fail again.
    setSession(userId, { state: 'idle', error: undefined });
    const lang = langOf(deps, userId);
    await ctx.reply(errorText(isCoded(err) ? err.code : E.TG_UNKNOWN, undefined, lang), { parse_mode: 'HTML', reply_markup: noticeKeyboard(lang) });
    return;
  }

  if (match.kind === 'source') return resolveOrAskTypes(ctx, deps, userId, link);

  // A website page may be a category; its own feed decides, and an article keeps the download choice.
  if (isPageLink(link, deps)) return resolveOrAskTypes(ctx, deps, userId, link, { askIfNotSection: true });

  // A pin link names no account; its oEmbed card does, so the chooser can still offer the source.
  const profileUrl = (await ownerOf(link, deps)) ?? (await engineOwnerOf(link, deps)) ?? (await youtubeChannelOf(deps.http, link))?.url ?? null;
  await askPostOrSource(ctx, deps, userId, link, profileUrl);
}

/** Text that meant to be a link: a scheme or a `www.` host, neither of which prose says by accident. */
const looksLikeLink = (text: string): boolean => /:\/\/|(^|\s)www\./i.test(text);

/** No usable link in a message, or more than one: one line that says what to send instead. */
async function answerUnusable(ctx: Context, deps: BotDeps, userId: number, text: string, count: number, want: 'post' | 'source'): Promise<void> {
  const lang = langOf(deps, userId);
  const notice = count > 1 ? oneLink(count, lang) : looksLikeLink(text) ? linkInvalid(lang) : linkRequired(want, lang);
  await ctx.reply(notice, { parse_mode: 'HTML', reply_markup: noticeKeyboard(lang) });
}

/** The download-or-subscribe choice for a link that is not a source. */
async function askPostOrSource(ctx: Context, deps: BotDeps, userId: number, link: string, profileUrl: string | null): Promise<void> {
  setSession(userId, { state: 'choosing', chooser: { link, profile: profileUrl ?? undefined } });
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

/** A plain website page: neither a known platform nor a URL that is already a feed. */
function isPageLink(link: string, deps: BotDeps): boolean {
  try {
    return isWebsitePage(detectSource(link, detectOpts(deps)));
  } catch {
    return false;
  }
}

/**
 * The page's own answer for anything that pasted a website page. `null` means "offer the download":
 * with `askIfNotSection`, a page that is not a category — or whose feed is down — is still a post, and
 * the download needs no feed at all.
 */
async function pageSourceFor(deps: BotDeps, ref: SourceRef, askIfNotSection: boolean): Promise<{ ref: SourceRef; feed: ParsedFeed; section: boolean } | null> {
  try {
    return await fetchPageSource(deps.http, ref, !askIfNotSection);
  } catch (err) {
    if (!isCoded(err) || !askIfNotSection) throw err;
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
  const page = isPageLink(chooser.link, deps);
  setSession(userId, { state: 'idle', chooser: undefined });
  // A website page is resolved as itself: its own feed decides whether it is a category or a site.
  if (page) return download ? runDownload(ctx, deps, userId, chooser.link) : resolveOrAskTypes(ctx, deps, userId, chooser.link, { quotaPaid: true });
  if (profileUrl) await resolveOrAskTypes(ctx, deps, userId, profileUrl);
  else await runDownload(ctx, deps, userId, chooser.link);
}

/** §5.4: the kinds the picker is holding, or null for a link that never opened it. */
const chosenTypes = (userId: number): ContentKind[] | null => getSession(userId).typePicker?.selected ?? null;

/** How a resolve was entered: what to do when a page turns out not to be a category, and who paid. */
interface ResolveOptions {
  /** A page's own feed decides the flow; an article keeps the download chooser. */
  askIfNotSection?: boolean;
  /** The caller already spent the add quota on this link (the chooser's Add follows a probe). */
  quotaPaid?: boolean;
}

/**
 * A YouTube channel is asked what to watch before anything is fetched; every other source keeps the
 * one-step add. A link no flow can use falls through, so runResolve reports its own code.
 */
async function resolveOrAskTypes(ctx: Context, deps: BotDeps, userId: number, link: string, options: ResolveOptions = {}): Promise<void> {
  // Only the classification is guarded: a paint that fails must not become an add with default kinds.
  let ref: SourceRef | undefined;
  try {
    ref = detectSource(link, detectOpts(deps));
  } catch {
    // A bad link is runResolve's to report, with the keyboard that fits the code.
  }
  if (ref?.platform === 'youtube') return openTypePicker(ctx, deps, userId, ref, link);
  await runResolve(ctx, deps, userId, link, options);
}

/** `@handle`, or the channel id when the link named no handle. */
const channelLabel = (ref: SourceRef): string => (ref.externalId.startsWith('UC') ? ref.externalId : `@${ref.externalId}`);

/** S18 for a channel about to be added; the choice rides in the session until stage 4 writes it. */
async function openTypePicker(ctx: Context, deps: BotDeps, userId: number, ref: SourceRef, link: string): Promise<void> {
  const selected: ContentKind[] = [...CONTENT_KINDS];
  const handle = channelLabel(ref);
  setSession(userId, { state: 'choosing_types', typePicker: { link, handle, selected } });
  await paintRich(ctx, contentTypePickerView({ handle, selected, lang: langOf(deps, userId) }));
}

/** S18 for a card in My Sources: a new message, so the list underneath keeps its place. */
async function openTypesForSource(ctx: Context, deps: BotDeps, userId: number, subscriptionId: number, lang: Lang): Promise<void> {
  const card = subscriptionCard(deps.db, ensureUser(deps.db, userId).id, subscriptionId);
  if (!card) return;
  const selected = parseContentTypes(card.content_types) ?? [...CONTENT_KINDS];
  const handle = card.title ?? card.canonical_url;
  setSession(userId, { state: 'choosing_types', typePicker: { subscriptionId, handle, selected } });
  const view = contentTypePickerView({ handle, selected, lang });
  const chatId = ctx.chat?.id;
  // A new message: the list underneath keeps its place, and the picker gets deleted when it closes.
  if (chatId !== undefined) await ctx.api.sendRichMessage(chatId, { html: view.html }, { reply_markup: view.keyboard });
}

/** A tap flips one kind in place; the last one cannot be turned off, so Done is always valid. */
async function toggleType(ctx: Context, deps: BotDeps, userId: number, kind: string, lang: Lang): Promise<void> {
  const picker = getSession(userId).typePicker;
  if (!picker || !(CONTENT_KINDS as readonly string[]).includes(kind)) return;
  const name = kind as ContentKind;
  const off = picker.selected.includes(name);
  if (off && picker.selected.length === 1) return;
  const selected = off ? picker.selected.filter((other) => other !== name) : [...picker.selected, name];
  setSession(userId, { typePicker: { ...picker, selected } });
  await paintRich(ctx, contentTypePickerView({ handle: picker.handle, selected, lang }));
}

/** `ct:all`: the requested "All content" preset, which leaves the toggles free for a mix. */
async function selectAllTypes(ctx: Context, deps: BotDeps, userId: number, lang: Lang): Promise<void> {
  const picker = getSession(userId).typePicker;
  if (!picker) return;
  const selected: ContentKind[] = [...CONTENT_KINDS];
  setSession(userId, { typePicker: { ...picker, selected } });
  await paintRich(ctx, contentTypePickerView({ handle: picker.handle, selected, lang }));
}

/** `ct:done`: the add flow continues into stage 1, the My Sources flow writes the row and repaints. */
async function saveTypes(ctx: Context, deps: BotDeps, userId: number, lang: Lang): Promise<void> {
  const picker = getSession(userId).typePicker;
  if (!picker) return restarted(ctx, deps, userId);
  // Unreachable from the picker (it refuses to empty), kept for a forged callback: an empty list would
  // store '' and read back as "everything".
  if (picker.selected.length === 0) return;
  await ctx.deleteMessage().catch(() => {});

  if (picker.subscriptionId !== undefined) {
    const saved = setSubscriptionContentTypes(deps.db, ensureUser(deps.db, userId).id, picker.subscriptionId, picker.selected);
    log('info', saved ? 'content_types_set' : 'content_types_denied', { subscription: picker.subscriptionId, kinds: picker.selected.join(',') });
    const state = getSession(userId).s7;
    setSession(userId, { state: 'idle', typePicker: undefined });
    return renderS7(ctx, deps, userId, state?.page ?? 0, state?.platform ?? null, state?.headerId ?? null);
  }
  // A picker reached without a link cannot add anything; the Add Source screen is the answer.
  if (picker.link === undefined) return restarted(ctx, deps, userId);
  await runResolve(ctx, deps, userId, picker.link);
}

/** `ct:back`: an edit returns to the list, an add returns to the Add Source screen. */
async function backFromTypes(ctx: Context, deps: BotDeps, userId: number, lang: Lang): Promise<void> {
  const picker = getSession(userId).typePicker;
  setSession(userId, { state: 'idle', typePicker: undefined });
  if (picker?.subscriptionId !== undefined) {
    await ctx.deleteMessage().catch(() => {});
    const state = getSession(userId).s7;
    return renderS7(ctx, deps, userId, state?.page ?? 0, state?.platform ?? null, state?.headerId ?? null);
  }
  setSession(userId, { state: 'awaiting_source_link' });
  await paint(ctx, addSourceView(deps.cfg.telegramBeta, lang));
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

async function runResolve(ctx: Context, deps: BotDeps, userId: number, link: string, options: ResolveOptions = {}): Promise<void> {
  const user = ensureUser(deps.db, userId);
  ensurePrivateChat(deps.db, user.id, userId);
  const chatId = ctx.chat?.id;
  const lang = langOf(deps, userId);
  let working: number | undefined;

  try {
    // §12.4: one source-add per 10 s. A chooser's Add already paid for its probe.
    if (!options.quotaPaid && !allowAdd(userId, deps.cfg.limits.addIntervalMs)) throw new Coded(E.SLOW_DOWN, 'add interval');
    // A website page is resolved last: its category URL is only known after the feed answers below.
    let ref = resolveProfile(link, detectOpts(deps));

    // Checked before any fetch: a source the user already follows needs no preview, only a pointer.
    const known = findSourceByUrl(deps.db, ref.canonicalUrl);
    if (known && subscribedByUser(deps.db, user.id, known.id)) {
      const lang = langOf(deps, userId);
      setSession(userId, { state: 'idle', error: undefined });
      await ctx.reply(t(lang, 'notice.alreadySource', { title: esc(known.title ?? ref.externalId) }), { parse_mode: 'HTML', reply_markup: openSourcesKeyboard(lang) });
      return;
    }

    setSession(userId, { state: 'checking', error: undefined });
    working = (await ctx.reply(checkingView(ref.canonicalUrl, langOf(deps, userId)).text, { parse_mode: 'HTML' })).message_id;

    // A website page may be a category listing: its own feed decides, and a page with none is the site.
    let feed: ParsedFeed;
    if (isWebsitePage(ref)) {
      const page = await pageSourceFor(deps, ref, options.askIfNotSection === true);
      if (page === null) {
        // A page with no feed is an article: the download choice needs no feed at all.
        await askPostOrSource(ctx, deps, userId, link, profileOfPost(link));
        return;
      }
      ref = page.ref;
      feed = page.feed;
    } else {
      feed = await fetchSourceFeed(deps.http, ref, chosenTypes(userId), deps.cfg.rsshubBase);
    }
    const section = sectionOf(ref.canonicalUrl);
    const author = sourceTitle(feed.title ?? ref.externalId, section);
    // §5.4: every item is recorded as seen; the preview and the backfill use the newest few.
    const preview = newest(filterByContentTypes(ref.platform, feed.items, chosenTypes(userId)), deps.cfg.limits.backfillCount);
    const pending: PendingSource = {
      link,
      ...ref,
      // A feed discovered from the page is what stage 2 and every later check will use.
      feedUrl: feed.feedUrl ?? ref.feedUrl,
      author,
      avatarUrl: feed.avatarUrl,
      items: feed.items,
      bodyText: sourceBody({ platform: ref.platform, author, items: preview, section, lang }),
      photo: false,
      at: Date.now(),
    };
    pending.photo = await sendPreview(ctx, deps, user.id, ref, feed, preview, lang, section);
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
async function sendPreview(ctx: Context, deps: BotDeps, ownerUserId: number, ref: SourceRef, feed: ParsedFeed, items: FeedItem[], lang: Lang, section: string | null): Promise<boolean> {
  const view = sourcePreviewView({
    platform: ref.platform,
    author: sourceTitle(feed.title ?? ref.externalId, section),
    section,
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
  const view = deliveryOptionsView(pending.bodyText, langOf(deps, userId), pending.keywords ?? [], ensureUser(deps.db, userId).default_keywords);
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
      const ref = refOf(pending);
      const feed = await fetchSourceFeed(deps.http, ref, chosenTypes(userId), deps.cfg.rsshubBase);
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
      contentTypes: chosenTypes(userId),
      keywords: formatKeywords(pending.keywords ?? []),
    });

    log('info', 'source_added', { source: result.sourceId, pending: result.pending });
    setSession(userId, { state: 'done', pending: undefined, destChatId: undefined, typePicker: undefined });
    const view = sourceAddedView(pending.author, langOf(deps, userId));
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

  const view = mySourcesView({
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
  const view = scheduleListView({ cards: rows, offset: pageIndex * PAGE_SIZE, total, page: pageIndex, lang: langOf(deps, userId) });
  await paintOrReply(ctx, view);
}

async function schedulePicker(ctx: Context, deps: BotDeps, userId: number, sourceId: number): Promise<void> {
  const card = getSourceCard(deps.db, ensureUser(deps.db, userId).id, sourceId);
  if (!card) return;
  await paint(ctx, schedulePickerView(card, langOf(deps, userId)));
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

  if (all) return paint(ctx, schedulePickerView(null, lang));
  const card = sourceId === null ? undefined : getSourceCard(deps.db, user.id, sourceId);
  if (card) await paint(ctx, schedulePickerView(card, lang));
}

/** S10: the confirm is a separate message, so a mis-tap cannot delete anything (ADR-016). */
async function askDelete(ctx: Context, deps: BotDeps, userId: number, sourceId: number): Promise<void> {
  const user = ensureUser(deps.db, userId);
  if (!ownsSource(deps.db, user.id, sourceId)) return;
  const source = getSource(deps.db, sourceId);
  const view = deleteConfirmView(source?.title ?? `#${sourceId}`, sourceId, langOf(deps, userId));
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
  setSession(userId, { s7: undefined, keywordStep: undefined });

  // A prompt opened from S5 is one step inside the add: Back drops the prompt, not the draft.
  if ((session.state === 'add_mode' || session.state === 'awaiting_keywords') && session.pending) {
    setSession(userId, { state: 'preview', destChatId: undefined });
    const owner = ensureUser(deps.db, userId);
    const view = sourcePreviewView({
      platform: session.pending.platform,
      author: session.pending.author,
      section: sectionOf(session.pending.canonicalUrl),
      avatarUrl: session.pending.avatarUrl,
      // Back shows the same preview the picker promised: only the kinds this chat still watches.
      items: newest(filterByContentTypes(session.pending.platform, session.pending.items, chosenTypes(userId)), deps.cfg.limits.backfillCount),
      personalChatId: personalChat(deps.db, owner.id).id,
      chats: destinations(deps.db, owner.id),
      lang: langOf(deps, userId),
    });
    return editSourceMessage(ctx, session.pending.photo, view);
  }
  if (session.state === 'preview') {
    setSession(userId, { state: 'awaiting_source_link', pending: undefined, typePicker: undefined });
    return paint(ctx, addSourceView(deps.cfg.telegramBeta, langOf(deps, userId)));
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
  return paint(ctx, addSourceView(deps.cfg.telegramBeta, langOf(deps, userId)));
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
    working = (await ctx.reply(checkingView(ref.canonicalUrl, langOf(deps, userId)).text, { parse_mode: 'HTML' })).message_id;

    const target = targetOf(chat.tg_chat_id, chat.message_thread_id, chat.type);

    // A blog or website arrives as an Instant View article, exactly like a scheduled one.
    if (websitePage) {
      const article = await planArticle({ http: deps.http, telegraph: deps.telegraph }, {
        url: ref.canonicalUrl,
        title: null,
        publishedAt: null,
        // The page names itself (`og:site_name`); the host is the fallback inside planArticle.
        sourceTitle: null,
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
        plan = await pagePostDelivery(deps, page, ref.canonicalUrl, dir, signal, ref.platform, user.tz);
      } else {
        const resolved = await deps.media.resolve(ref.canonicalUrl, signal);
        // X/Twitter, TikTok and Facebook extractors return media only; the page still names its words.
        // X's public text surfaces stop at 280, so the full post comes from the mirror when it answers.
        // One page fetch carries what the extractor did not: the account, the date, the words.
        const meta = await pageMeta(deps.http, ref.canonicalUrl);
        // A video page is too heavy for the page budget; oEmbed names its channel in a fraction of it.
        channel = await youtubeChannelOf(deps.http, ref.canonicalUrl);
        const engineText = resolved.title?.trim() || null;
        const text = (ref.platform === 'x' ? await xFullText(deps.http, ref.canonicalUrl) : null) ?? engineText ?? meta.text;
        engineAuthor = resolved.artist?.trim() || null;
        // The page states the date first; the extractor is the fallback for pages that hide it (Tumblr).
        const publishedAt = meta.publishedAt ?? resolved.publishedAt ?? null;
        // The page names the account as it prints it; then the extractor, then the account the link names.
        const owner = profileOfPost(ref.canonicalUrl);
        const source = meta.name ?? engineAuthor ?? (owner !== null ? nameOf(owner) : text === null ? null : hostOf(ref.canonicalUrl));
        const files = await prepareMedia(deps.media, resolved.items, dir, { maxMb: deps.cfg.limits.maxDownloadMb, signal });
        // ADR-023: one rich message carries the whole post; a video too big to upload keeps its link.
        plan = renderDownload(files, { title: text, artist: source, publishedAt, platform: ref.platform, tz: user.tz }, ref.canonicalUrl);
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
    // A channel without a handle (a topic channel) prints the plain button, never a fake @name.
    const handle = channel !== null ? channel.handle : named === null ? null : engineAuthor;
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
  channel: { url: string; handle: string | null } | null;
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
  // Only a community post lives in its own page. A video, a Short or a live stream is cobalt's job,
  // and sending it here made every YouTube download fail as "not a supported source".
  if (youtubePostId(url) === null) return null;
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

/** One rich message for a post the page itself carried: its words and its media (ADR-023). */
async function pagePostDelivery(deps: BotDeps, post: PagePost, link: string, dir: string, signal: AbortSignal, platform: string, tz: string): Promise<MessagePlan> {
  // The account names the source; an unnamed one falls back to the host, so the text stays the body.
  const source = post.name ?? post.author ?? hostOf(link);
  let files: MediaFile[] = [];
  try {
    files = await prepareMedia(deps.media, post.items, dir, { maxMb: deps.cfg.limits.maxDownloadMb, signal });
  } catch (err) {
    // Over the size cap the post still ships its words; the media is the part that is lost.
    log('warn', 'page_media_failed', { code: isCoded(err) ? err.code : 'unknown' });
  }
  return renderDownload(files, { title: post.text === '' ? null : post.text, artist: source, publishedAt: post.publishedAt, platform, tz }, link);
}

/** ADR-024: replace a truncated post with its full body, same message, media kept by file_id. */
async function expandPost(ctx: Context, deps: BotDeps, token: string): Promise<void> {
  const chat = ctx.chat;
  const messageId = ctx.callbackQuery?.message?.message_id;
  if (chat === undefined || messageId === undefined) return;
  const full = morePayload(token);
  if (full === undefined) {
    // The payload is process-local and expires; the preview stays untouched.
    await ctx.answerCallbackQuery({ text: 'This post can no longer be expanded.' });
    return;
  }
  await ctx.answerCallbackQuery();
  try {
    await deps.sender.expandMore({ chatId: chat.id, messageThreadId: null, isGroup: chat.type !== 'private' }, messageId, full);
  } catch (err) {
    log('warn', 'expand_failed', { chat: chat.id, cause: err instanceof Error ? err.message : String(err) });
  }
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
  // The picker repaints itself; every tap is silent.
  if (data.startsWith(cb.typesOpen) || data.startsWith(cb.typesToggle) || data === cb.typesDone || data === cb.typesAll || data === cb.typesBack) return undefined;
  // The keyword screens repaint themselves too (ADR-020).
  if (data === cb.keywords || data === cb.kwDefault || data === cb.kwClearDefault || data.startsWith(cb.kwClear) || data.startsWith(cb.kwEdit) || data.startsWith(cb.kwPage)) return undefined;
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
    case cb.filterMenu:
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
  return mainMenuView({
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
  if (chatId === undefined) return;
  const messageId = ctx.callbackQuery?.message?.message_id;
  // A screen reached from plain text has no message to edit: the rich message is its own.
  if (messageId === undefined) {
    await ctx.api.sendRichMessage(chatId, { html: view.html }, { reply_markup: view.keyboard });
    return;
  }
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
