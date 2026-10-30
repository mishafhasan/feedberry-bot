/**
 * §9.1 token buckets: 1 msg/s per chat, 20 msg/min per group, 30 msg/s process-wide, plus a
 * per-chat serializer so two subscriptions cannot interleave (§9.1, ADR-004).
 */
const CHAT_INTERVAL_MS = 1000;
const GROUP_WINDOW_MS = 60_000;
const GROUP_LIMIT = 20;
const GLOBAL_WINDOW_MS = 1000;
const GLOBAL_LIMIT = 30;

interface ChatState {
  last: number;
  window: number[];
  chain: Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class RateLimiter {
  private readonly global: number[] = [];
  private readonly chats = new Map<number, ChatState>();

  /** Runs `send` once every bucket allows it; serialized per chat. */
  async run<T>(chatId: number, isGroup: boolean, tokens: number, send: () => Promise<T>): Promise<T> {
    const state = this.stateOf(chatId);
    const previous = state.chain;
    let release = (): void => {};
    state.chain = new Promise<void>((resolve) => (release = resolve));
    await previous;

    try {
      await this.acquire(state, isGroup, tokens);
      return await send();
    } finally {
      release();
    }
  }

  private stateOf(chatId: number): ChatState {
    let state = this.chats.get(chatId);
    if (!state) {
      state = { last: 0, window: [], chain: Promise.resolve() };
      this.chats.set(chatId, state);
    }
    return state;
  }

  private async acquire(state: ChatState, isGroup: boolean, tokens: number): Promise<void> {
    for (;;) {
      const now = Date.now();
      while (this.global.length > 0 && now - (this.global[0] as number) >= GLOBAL_WINDOW_MS) this.global.shift();
      while (state.window.length > 0 && now - (state.window[0] as number) >= GROUP_WINDOW_MS) state.window.shift();

      const chatReady = now - state.last >= CHAT_INTERVAL_MS;
      const groupReady = !isGroup || state.window.length + tokens <= GROUP_LIMIT;
      const globalReady = this.global.length + tokens <= GLOBAL_LIMIT;

      if (chatReady && groupReady && globalReady) {
        // An album reserves one token per item against the group/global buckets (OQ-12).
        for (let i = 0; i < tokens; i++) {
          this.global.push(now);
          state.window.push(now);
        }
        state.last = now;
        return;
      }
      await sleep(200);
    }
  }
}

/** One set of buckets per process: the bot and the worker must share them (9.1). */
export const sharedLimiter = new RateLimiter();
