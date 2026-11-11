/**
 * Milestone H (IMPLEMENTATION_PLAN §4 H): the pipeline exposes one extension point after `render`.
 * A hook receives an immutable context and may replace the plan; it never gets a Telegram client,
 * so stage 7 stays the only sender and the rate limiter cannot be bypassed (§5.7).
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createBot } from '../../src/bot/index.ts';
import { parseConfig } from '../../src/config.ts';
import { openDb, type Db } from '../../src/db/index.ts';
import { ensurePrivateChat } from '../../src/db/repos/chats.ts';
import { markPendingDelivery } from '../../src/db/repos/deliveries.ts';
import { insertPosts } from '../../src/db/repos/posts.ts';
import { upsertSource } from '../../src/db/repos/sources.ts';
import { insertSubscription } from '../../src/db/repos/subscriptions.ts';
import { ensureUser } from '../../src/db/repos/users.ts';
import type { MediaEngine } from '../../src/media/media-engine.ts';
import type { Http } from '../../src/platform/http.ts';
import { deliverPending, registerHook, resetHooks } from '../../src/pipeline/run.ts';
import { TelegramSender } from '../../src/telegram/api.ts';
import { fakeBotApi, type FakeApi } from '../fake-api.ts';

const TOKEN = '123456:AAHfakeTokenForTestsOnly_1234567890abc';
const USER_ID = 555;

const noMedia: MediaEngine = {
  async resolve() {
    return { items: [], title: null, artist: null };
  },
  async download() {
    throw new Error('no media');
  },
};

const http: Http = async (url) => {
  throw new Error(`no fetch expected, got ${url}`);
};

async function deliver(api: FakeApi, dir: string): Promise<string> {
  const cfg = parseConfig({ BOT_TOKEN: TOKEN, ADMIN_CHAT_ID: '1', RSSHUB_BASE: 'http://rsshub.test' });
  const db: Db = openDb(join(dir, 'bot.db'));
  try {
    const user = ensureUser(db, USER_ID);
    const chat = ensurePrivateChat(db, user.id, USER_ID);
    const source = upsertSource(db, {
      platform: 'instagram',
      canonicalUrl: 'https://instagram.com/cristiano',
      externalId: 'cristiano',
      feedUrl: 'http://rsshub.test/instagram/user/cristiano',
      strategy: 'rsshub',
      title: 'Cristiano Ronaldo',
      avatarUrl: null,
    });
    insertSubscription(db, { userId: user.id, sourceId: source.id, chatId: chat.id, deliver: true, nextSlotAt: null });
    const post = insertPosts(db, source.id, [
      { guid: 'h-1', link: 'https://instagram.com/p/1', title: 'Hello', publishedAt: Date.parse('2025-10-24T10:00:00Z'), summary: 'Body text', media: [] },
    ])[0];
    assert.ok(post);
    markPendingDelivery(db, post.id, chat.id);

    const bot = createBot({ cfg, db, apiRoot: api.apiRoot, http, media: noMedia });
    await bot.init();
    await deliverPending({ db, http, cfg, media: noMedia, thumbnail: async () => null, sender: new TelegramSender(bot.api) }, source.id);
    return String(api.last('sendRichMessage')?.body.rich_message?.html ?? '');
  } finally {
    db.close();
  }
}

test('H: a no-op hook runs once after render and the message is byte-identical', async () => {
  const api = await fakeBotApi();
  const baselineDir = mkdtempSync(join(tmpdir(), 'feedberry-h0-'));
  const hookedDir = mkdtempSync(join(tmpdir(), 'feedberry-h1-'));

  try {
    const baseline = await deliver(api, baselineDir);

    const seen: Array<{ id: string; kinds: string[] }> = [];
    registerHook({
      id: 'noop',
      after: 'render',
      run(context, plan) {
        seen.push({ id: 'noop', kinds: [...Object.keys(context).sort(), plan.kind] });
        return plan;
      },
    });

    const hooked = await deliver(api, hookedDir);

    assert.equal(seen.length, 1, 'the hook is called exactly once');
    assert.equal(hooked, baseline, 'the delivered message is byte-identical to the baseline');
    assert.match(hooked, /Body text/);
  } finally {
    resetHooks();
    await api.close();
    rmSync(baselineDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    rmSync(hookedDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
