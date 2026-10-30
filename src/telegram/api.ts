import { GrammyError, InputFile, type Api } from 'grammy';
import { log } from '../obs/log.ts';
import { Coded, E } from '../platform/errors.ts';
import { chunk } from '../render/albums.ts';
import { splitMessage } from '../render/caption.ts';
import type { MessagePlan } from '../render/plan.ts';
import { RateLimiter, sharedLimiter } from './ratelimit.ts';
import type { Target } from './target.ts';

const CAPTION_LIMIT = 1024;
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
      case 'link_only':
        return this.sendTextParts(target, plan.text);
      case 'album':
        return this.sendAlbum(target, plan.items, plan.caption);
      case 'sequential':
        return this.sendSequential(target, plan.items, plan.caption);
      default:
        return this.sendSingle(target, plan.kind, plan.file, plan.caption);
    }
  }

  async sendText(target: Target, text: string): Promise<number[]> {
    return this.sendTextParts(target, text);
  }

  private async sendTextParts(target: Target, text: string): Promise<number[]> {
    const ids: number[] = [];
    let replyTo: number | undefined;
    for (const part of splitMessage(text, MESSAGE_LIMIT)) {
      const message = await this.run(target, 1, () => this.api.sendMessage(target.chatId, part, this.textBody(target, replyTo)));
      ids.push(message.message_id);
      replyTo = message.message_id;
    }
    return ids;
  }

  /** R2/R6/R9/R10/R11: one media message, caption split into that caption plus reply-chained texts. */
  private async sendSingle(target: Target, kind: 'photo' | 'video' | 'animation' | 'audio', file: string, caption: string): Promise<number[]> {
    const parts = splitMessage(caption, CAPTION_LIMIT);
    const first = parts[0] ?? '';
    const input = new InputFile(file);
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

  /** R3/R4: same-kind groups of 10, caption on the first item only, groups reply to each other. */
  private async sendAlbum(target: Target, items: Array<{ file: string; kind: 'photo' | 'video' }>, caption: string): Promise<number[]> {
    const parts = splitMessage(caption, CAPTION_LIMIT);
    const ids: number[] = [];
    let replyTo: number | undefined;

    for (const [index, group] of chunk(items).entries()) {
      const media = group.map((item, itemIndex) => ({
        type: item.kind,
        media: new InputFile(item.file),
        ...(index === 0 && itemIndex === 0 && parts[0] ? { caption: parts[0], parse_mode: 'HTML' as const } : {}),
      }));
      // OQ-12: an album reserves one token per item against the group/global buckets.
      const messages = await this.run(target, group.length, () => this.api.sendMediaGroup(target.chatId, media, this.groupBody(target, replyTo)));
      ids.push(...messages.map((message) => message.message_id));
      replyTo = messages[0]?.message_id;
    }

    for (const part of parts.slice(1)) {
      const next = await this.run(target, 1, () => this.api.sendMessage(target.chatId, part, this.textBody(target, replyTo)));
      ids.push(next.message_id);
      replyTo = next.message_id;
    }
    return ids;
  }

  /** R5: photo and video cannot share a group, so each item is its own message. */
  private async sendSequential(target: Target, items: Array<{ file: string; kind: 'photo' | 'video' }>, caption: string): Promise<number[]> {
    const ids: number[] = [];
    for (const [index, item] of items.entries()) {
      const sent = await this.sendSingle(target, item.kind, item.file, index === 0 ? caption : '');
      ids.push(...sent);
    }
    return ids;
  }

  /** Every send goes through the limiter and the 429 handler; nothing else may call the Api. */
  private async run<T>(target: Target, tokens: number, call: () => Promise<T>): Promise<T> {
    return this.limiter.run(target.chatId, target.isGroup, tokens, () => this.retrying(target, call));
  }

  private async retrying<T>(target: Target, call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (err) {
      if (!(err instanceof GrammyError) || err.error_code !== 429) throw err;

      // §9.2: sleep retry_after + 1 s and retry the same call; a 429 never consumes an attempt.
      const waitMs = (err.parameters?.retry_after ?? 5) * 1000;
      if (waitMs > MAX_INLINE_WAIT_MS) throw new Coded(E.TG_429, `retry_after ${waitMs}ms`);
      log('warn', 'tg_429', { chat: target.chatId, waitMs });
      await sleep(waitMs + 1000);
      return await call();
    }
  }

  private textBody(target: Target, replyTo?: number) {
    return {
      parse_mode: 'HTML' as const,
      message_thread_id: target.messageThreadId ?? undefined,
      reply_parameters: replyTo === undefined ? undefined : { message_id: replyTo },
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
