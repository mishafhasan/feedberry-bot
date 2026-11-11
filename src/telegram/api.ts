import { GrammyError, InputFile, type Api } from 'grammy';
import type { InputRichMessage } from 'grammy/types';
import { log } from '../obs/log.ts';
import { Coded, E, isCoded } from '../platform/errors.ts';
import { chunk } from '../render/albums.ts';
import { splitMessage } from '../render/caption.ts';
import type { MediaKind, MessagePlan } from '../render/message-plan.ts';
import { RateLimiter, sharedLimiter } from './ratelimit.ts';
import { moreToken, rememberMore, type MorePayload } from './more.ts';
import type { Target } from './target.ts';

/** Telegram's caption cap; the pipeline's Read-more budget is derived from it. */
export const CAPTION_LIMIT = 1024;
const MESSAGE_LIMIT = 4096;
const MAX_INLINE_WAIT_MS = 300_000;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The only place that talks to the Bot API for delivery (§9). Rate limited, 429-aware. */
export class TelegramSender {
  private readonly api: Api;
  readonly limiter: RateLimiter;

  constructor(api: Api, limiter: RateLimiter = sharedLimiter) {
    this.api = api;
    this.limiter = limiter;
  }

  /** Stage 7's single entry point: any plan becomes one or more messages. */
  async send(plan: MessagePlan, target: Target): Promise<number[]> {
    switch (plan.kind) {
      case 'text':
        return this.sendTextParts(target, plan.text, plan.previewUrl);
      case 'link_only':
        return this.sendTextParts(target, plan.text);
      case 'album':
        return this.sendAlbum(target, plan.items, plan.caption);
      case 'rich':
        return this.sendRich(target, plan.html, plan.media);
      case 'rich_more':
        return this.sendRichMore(target, plan);
      case 'thumbnail':
        return this.sendThumbnail(target, plan.file, plan.caption, plan.link, plan.remote === true);
      default:
        return this.sendSingle(target, plan.kind, plan.file, plan.caption);
    }
  }

  async sendText(target: Target, text: string): Promise<number[]> {
    return this.sendTextParts(target, text);
  }

  private async sendTextParts(target: Target, text: string, previewUrl?: string): Promise<number[]> {
    try {
      return await this.sendParts(target, text, true, previewUrl);
    } catch (err) {
      // §8.2 rule 5: a post that cannot be parsed is resent as plain text, never dropped.
      if (!isCoded(err) || err.code !== E.TG_PARSE) throw err;
      log('warn', 'tg_parse_fallback', { chat: target.chatId });
      return this.sendParts(target, plainText(text), false, previewUrl);
    }
  }

  private async sendParts(target: Target, text: string, html: boolean, previewUrl?: string): Promise<number[]> {
    const ids: number[] = [];
    let replyTo: number | undefined;
    for (const part of splitMessage(text, MESSAGE_LIMIT)) {
      const message = await this.run(target, 1, () => this.api.sendMessage(target.chatId, part, this.textBody(target, replyTo, html, previewUrl)));
      ids.push(message.message_id);
      replyTo = message.message_id;
    }
    return ids;
  }

  /** R2/R6/R9/R10/R11: one media message, caption split into that caption plus reply-chained texts. */
  private async sendSingle(target: Target, kind: 'photo' | 'video' | 'animation' | 'audio', file: string, caption: string, remote = false): Promise<number[]> {
    const parts = splitMessage(caption, CAPTION_LIMIT);
    const first = parts[0] ?? '';
    // A URL is sent as-is (Telegram fetches it); a local path is uploaded.
    const input = remote ? file : new InputFile(file);
    const message = await this.run(target, 1, async () => {
      const body = this.mediaBody(target, first);
      if (kind === 'photo') return this.api.sendPhoto(target.chatId, input, body);
      if (kind === 'video') return this.api.sendVideo(target.chatId, input, { ...body, supports_streaming: true });
      if (kind === 'animation') return this.api.sendAnimation(target.chatId, input, body);
      return this.api.sendAudio(target.chatId, input, body);
    });

    const ids = [message.message_id];
    let replyTo = message.message_id;
    for (const part of parts.slice(1)) {
      const next = await this.run(target, 1, () => this.api.sendMessage(target.chatId, part, this.textBody(target, replyTo)));
      ids.push(next.message_id);
      replyTo = next.message_id;
    }
    return ids;
  }

  /** ADR-023: one rich message per post — the whole text rides inside, media uploaded by grammY. */
  private async sendRich(target: Target, html: string, media: Array<{ id: string; file: string; kind: MediaKind }>): Promise<number[]> {
    const rich: InputRichMessage = {
      html,
      // Source captions are full of bare URLs/@handles/#tags; only our own <a href> may become a link.
      skip_entity_detection: true,
      ...(media.length > 0 ? { media: media.map((m) => ({ id: m.id, media: { type: m.kind, media: new InputFile(m.file) } })) } : {}),
    };
    try {
      const message = await this.run(target, 1, () => this.api.sendRichMessage(target.chatId, rich, { message_thread_id: target.messageThreadId ?? undefined }));
      return [message.message_id];
    } catch (err) {
      // §8.2 rule 5: a post that cannot be parsed is resent as plain text, never dropped.
      if (!isCoded(err) || err.code !== E.TG_PARSE) throw err;
      log('warn', 'tg_parse_fallback', { chat: target.chatId });
      return this.sendParts(target, plainText(html), false);
    }
  }

  /** ADR-024: the truncated post; the button's token recalls the full body for the edit. */
  private async sendRichMore(target: Target, plan: Extract<MessagePlan, { kind: 'rich_more' }>): Promise<number[]> {
    const token = moreToken();
    const rich: InputRichMessage = {
      html: `${plan.html}${moreButton(token)}`,
      skip_entity_detection: true,
      ...(plan.media.length > 0 ? { media: plan.media.map((m) => ({ id: m.id, media: { type: m.kind, media: new InputFile(m.file) } })) } : {}),
    };
    const message = await this.run(target, 1, () => this.api.sendRichMessage(target.chatId, rich, { message_thread_id: target.messageThreadId ?? undefined }));
    // Stage 9 deletes the files, so the expansion edits with the file_ids this send returned.
    const media = fileRefsOf(message, plan.media);
    if (media.length !== plan.media.length) log('warn', 'more_media_refs_missing', { want: plan.media.length, got: media.length });
    rememberMore(token, { html: plan.fullHtml, media });
    return [message.message_id];
  }

  /** ADR-024: reveal the full body in place, keeping the slideshow by file_id. */
  async expandMore(target: Target, messageId: number, full: MorePayload): Promise<void> {
    const rich: InputRichMessage = {
      html: full.html,
      skip_entity_detection: true,
      ...(full.media.length > 0 ? { media: full.media.map((m) => ({ id: m.id, media: { type: m.kind, media: m.fileId } })) } : {}),
    };
    try {
      await this.run(target, 1, () => this.api.editMessageText(target.chatId, messageId, rich));
    } catch (err) {
      // §8.2 rule 5: a body Telegram cannot parse is edited as plain text, never left half broken.
      if (!isCoded(err) || err.code !== E.TG_PARSE) throw err;
      log('warn', 'tg_parse_fallback', { chat: target.chatId });
      await this.run(target, 1, () => this.api.editMessageText(target.chatId, messageId, plainText(full.html)));
    }
  }

  /** R7/R8: the preview image carries the caption, the link follows as its own message. */
  private async sendThumbnail(target: Target, file: string, caption: string, link: string, remote = false): Promise<number[]> {
    const ids = await this.sendSingle(target, 'photo', file, caption, remote);
    const message = await this.run(target, 1, () => this.api.sendMessage(target.chatId, link, this.textBody(target)));
    ids.push(message.message_id);
    return ids;
  }

  /** R3/R4: groups of 10, caption on the first item only, groups reply to each other. */
  private async sendAlbum(target: Target, items: Array<{ file: string; kind: 'photo' | 'video' }>, caption: string): Promise<number[]> {
    const parts = splitMessage(caption, CAPTION_LIMIT);
    const ids: number[] = [];
    let replyTo: number | undefined;

    for (const [index, group] of chunk(items).entries()) {
      const head = index === 0 ? parts[0] : undefined;
      let messageIds: number[];

      // §8.3: a group takes 2–10 items, so an album's tail of one travels as its own media message.
      if (group.length === 1 && group[0]) {
        messageIds = [await this.sendLone(target, group[0], replyTo, head)];
      } else {
        const media = group.map((item, itemIndex) => ({
          type: item.kind,
          media: new InputFile(item.file),
          ...(itemIndex === 0 && head ? { caption: head, parse_mode: 'HTML' as const } : {}),
        }));
        // OQ-12: an album reserves one token per item against the group/global buckets.
        const messages = await this.run(target, group.length, () => this.api.sendMediaGroup(target.chatId, media, this.groupBody(target, replyTo)));
        messageIds = messages.map((message) => message.message_id);
      }

      ids.push(...messageIds);
      replyTo = messageIds[0];
    }

    for (const part of parts.slice(1)) {
      const next = await this.run(target, 1, () => this.api.sendMessage(target.chatId, part, this.textBody(target, replyTo)));
      ids.push(next.message_id);
      replyTo = next.message_id;
    }
    return ids;
  }

  /** The album item that could not join a group: same caption and reply rules, one media message. */
  private async sendLone(target: Target, item: { file: string; kind: 'photo' | 'video' }, replyTo: number | undefined, caption?: string): Promise<number> {
    const body = {
      parse_mode: 'HTML' as const,
      message_thread_id: target.messageThreadId ?? undefined,
      reply_parameters: replyTo === undefined ? undefined : { message_id: replyTo },
      ...(caption ? { caption } : {}),
    };
    const input = new InputFile(item.file);
    const message = await this.run(target, 1, async () =>
      item.kind === 'photo' ? this.api.sendPhoto(target.chatId, input, body) : this.api.sendVideo(target.chatId, input, { ...body, supports_streaming: true }),
    );
    return message.message_id;
  }

  /** Every send goes through the limiter and the 429 handler; nothing else may call the Api. */
  private async run<T>(target: Target, tokens: number, call: () => Promise<T>): Promise<T> {
    return this.limiter.run(target.chatId, target.isGroup, tokens, () => this.retrying(target, call));
  }

  private async retrying<T>(target: Target, call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (err) {
      if (!(err instanceof GrammyError)) throw err;

      // §11: a chat we can no longer post to is demoted by the caller, never retried forever.
      if (err.error_code === 403) throw new Coded(E.TG_FORBIDDEN, err.description);

      // §8.2 rule 5: a parse failure is reported so the post can be resent as plain text.
      if (err.error_code === 400 && /can't parse entities/i.test(err.description)) throw new Coded(E.TG_PARSE, err.description);

      if (err.error_code !== 429) throw err;

      // §9.2: sleep retry_after + 1 s and retry the same call; a 429 never consumes an attempt.
      const waitMs = (err.parameters?.retry_after ?? 5) * 1000;
      if (waitMs > MAX_INLINE_WAIT_MS) throw new Coded(E.TG_429, `retry_after ${waitMs}ms`);
      log('warn', 'tg_429', { chat: target.chatId, waitMs });
      await sleep(waitMs + 1000);
      return await call();
    }
  }

  private textBody(target: Target, replyTo?: number, html = true, previewUrl?: string) {
    return {
      parse_mode: html ? ('HTML' as const) : undefined,
      message_thread_id: target.messageThreadId ?? undefined,
      reply_parameters: replyTo === undefined ? undefined : { message_id: replyTo },
      link_preview_options: previewUrl === undefined ? undefined : { url: previewUrl },
    };
  }

  private mediaBody(target: Target, caption: string) {
    return {
      parse_mode: 'HTML' as const,
      message_thread_id: target.messageThreadId ?? undefined,
      ...(caption ? { caption } : {}),
    };
  }

  private groupBody(target: Target, replyTo?: number) {
    return {
      message_thread_id: target.messageThreadId ?? undefined,
      reply_parameters: replyTo === undefined ? undefined : { message_id: replyTo },
    };
  }
}

/** Kept for callers that only have text (health notices, operator alerts). */
export const senderTarget = (chatId: number): Target => ({ chatId, messageThreadId: null, isGroup: false });

/** Text we built, minus its HTML: what goes out when Telegram cannot parse the original. */
export function plainText(html: string): string {
  return html.replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/** The one button of the preview; `more:<token>` stays far below the 64-byte callback cap. */
const moreButton = (token: string): string => `<tg-button-row align="left"><tg-button type="callback_data" data="more:${token}">Show more</tg-button></tg-button-row>`;

/**
 * The file_ids the send returned, in `media` order: the slideshow keeps visual order and audio its
 * own blocks. A photo lists every size, so the last (largest) file_id represents it.
 */
function fileRefsOf(message: { rich_message?: { blocks?: unknown } }, media: Array<{ id: string; kind: MediaKind }>): MorePayload['media'] {
  const blocks = (Array.isArray(message.rich_message?.blocks) ? message.rich_message.blocks : []) as any[];
  const visual: string[] = [];
  const audio: string[] = [];
  for (const block of blocks) {
    if (block?.type === 'slideshow' && Array.isArray(block.blocks)) {
      for (const item of block.blocks) {
        const sizes = Array.isArray(item?.photo) ? item.photo : [];
        const fileId = sizes.length > 0 ? sizes[sizes.length - 1]?.file_id : item?.video?.file_id ?? item?.animation?.file_id;
        if (typeof fileId === 'string') visual.push(fileId);
      }
    } else if (block?.type === 'audio' && typeof block.audio?.file_id === 'string') {
      audio.push(block.audio.file_id);
    }
  }
  return media.flatMap((entry) => {
    const fileId = entry.kind === 'audio' ? audio.shift() : visual.shift();
    return fileId === undefined ? [] : [{ id: entry.id, kind: entry.kind, fileId }];
  });
}
