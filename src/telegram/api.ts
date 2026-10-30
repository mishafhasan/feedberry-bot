import { GrammyError, type Api } from 'grammy';
import { Coded, E } from '../platform/errors.ts';
import { log } from '../obs/log.ts';
import { RateLimiter } from './ratelimit.ts';
import type { Target } from './target.ts';

const MAX_INLINE_WAIT_MS = 300_000;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The only place that talks to the Bot API for delivery (§9). Rate limited, 429-aware. */
export class TelegramSender {
  private readonly api: Api;
  readonly limiter: RateLimiter;

  constructor(api: Api, limiter: RateLimiter = new RateLimiter()) {
    this.api = api;
    this.limiter = limiter;
  }

  async sendText(target: Target, text: string): Promise<number[]> {
    const message = await this.limiter.run(target.chatId, target.isGroup, 1, () => this.send(target, text));
    return [message.message_id];
  }

  private async send(target: Target, text: string) {
    const other = { parse_mode: 'HTML' as const, message_thread_id: target.messageThreadId ?? undefined };
    try {
      return await this.api.sendMessage(target.chatId, text, other);
    } catch (err) {
      if (!(err instanceof GrammyError) || err.error_code !== 429) throw err;

      // §9.2: sleep retry_after + 1 s and retry the same call; a 429 never consumes an attempt.
      const waitMs = (err.parameters?.retry_after ?? 5) * 1000;
      if (waitMs > MAX_INLINE_WAIT_MS) throw new Coded(E.TG_429, `retry_after ${waitMs}ms`);
      log('warn', 'tg_429', { chat: target.chatId, waitMs });
      await sleep(waitMs + 1000);
      return await this.api.sendMessage(target.chatId, text, other);
    }
  }
}
