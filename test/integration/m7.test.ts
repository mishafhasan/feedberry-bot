/**
 * M7 verification (IMPLEMENTATION_PLAN §4 M7): three article posts through the pipeline.
 * wired.html → one createPage and a telegra.ph link; long-70kb.html → two chained pages;
 * thin.html → R13 with the original link and no createPage call.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TelegraphPage } from '../../src/article/telegraph.ts';
import { createBot } from '../../src/bot/index.ts';
import { parseConfig } from '../../src/config.ts';
import { openDb } from '../../src/db/index.ts';
import { ensurePrivateChat } from '../../src/db/repos/chats.ts';
import { markPendingDelivery } from '../../src/db/repos/deliveries.ts';
import { insertPosts } from '../../src/db/repos/posts.ts';
import { upsertSource } from '../../src/db/repos/sources.ts';
import { insertSubscription } from '../../src/db/repos/subscriptions.ts';
import { ensureUser } from '../../src/db/repos/users.ts';
import type { MediaEngine } from '../../src/media/cobalt.ts';
import type { Http } from '../../src/platform/http.ts';
import { deliverPending } from '../../src/pipeline/run.ts';
import { TelegramSender } from '../../src/telegram/api.ts';
import { fakeBotApi } from '../fake-api.ts';

const TOKEN = '123456:AAHfakeTokenForTestsOnly_1234567890abc';
const USER_ID = 555;

const fixture = (name: string): string => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');
const PAGES: Record<string, string> = {
  'https://blog.example.test/wired': fixture('wired.html'),
  'https://blog.example.test/long': fixture('long-70kb.html'),
  'https://blog.example.test/thin': fixture('thin.html'),
};

const http: Http = async (url) => {
  const body = PAGES[url];
  if (body === undefined) throw new Error(`unexpected fetch ${url}`);
  return { status: 200, url, contentType: 'text/html', body };
};

/** Articles have no media; the engine must never be asked for bytes. */
const noMedia: MediaEngine = {
  async resolve() {
    return { items: [], title: null, artist: null };
  },
  async download() {
    throw new Error('no media expected');
  },
};

test('M7: article posts become Instant View links, thin posts become link cards', async () => {
  const api = await fakeBotApi();
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-m7-'));
  const cfg = parseConfig({ BOT_TOKEN: TOKEN, ADMIN_CHAT_ID: '1', RSSHUB_BASE: 'http://rsshub.test' });
  const db = openDb(join(dir, 'bot.db'));
  const pages: TelegraphPage[] = [];

  try {
    const user = ensureUser(db, USER_ID);
    const chat = ensurePrivateChat(db, user.id, USER_ID);
    const source = upsertSource(db, {
      platform: 'rss',
      canonicalUrl: 'https://blog.example.test',
      externalId: 'blog',
      feedUrl: 'https://blog.example.test/rss',
      strategy: 'native_rss',
      title: 'Blog',
      avatarUrl: null,
    });
    insertSubscription(db, { userId: user.id, sourceId: source.id, chatId: chat.id, deliver: true, nextSlotAt: null });

    const posts = [
      { guid: 'a-wired', link: 'https://blog.example.test/wired', title: 'Wired piece' },
      { guid: 'a-long', link: 'https://blog.example.test/long', title: 'Long read' },
      { guid: 'a-thin', link: 'https://blog.example.test/thin', title: 'Short note' },
    ].map((raw) => ({ ...raw, summary: null, publishedAt: Date.parse('2025-10-24T10:00:00Z'), media: [] }));
    for (const entry of insertPosts(db, source.id, posts)) markPendingDelivery(db, entry.id, chat.id);

    const bot = createBot({ cfg, db, apiRoot: api.apiRoot, http, media: noMedia });
    await bot.init();
    const result = await deliverPending(
      {
        db,
        http,
        cfg,
        media: noMedia,
        thumbnail: async () => null,
        telegraph: {
          async createPage(page) {
            pages.push(page);
            return `https://telegra.ph/page-${pages.length}`;
          },
        },
        sender: new TelegramSender(bot.api),
      },
      source.id,
    );

    assert.equal(result.delivered, 3);
    assert.equal(pages.length, 3, 'one page for wired, two for the long read, none for the thin page');

    const texts = api.calls.filter((c) => c.method === 'sendMessage').map((c) => String(c.body.text));
    const ivMessages = texts.filter((text) => text.includes('telegra.ph'));
    assert.equal(ivMessages.length, 2, 'wired and long arrive as Instant View links');
    assert.match(ivMessages[0] ?? '', /The quiet return of the personal website/, 'R12 keeps the title');
    assert.match(ivMessages[0] ?? '', /Page 0|Paragraph 0/, 'R12 carries a one-line lead');

    const thinMessage = texts.find((text) => text.includes('blog.example.test/thin'));
    assert.ok(thinMessage, 'the thin page falls back to its original link (R13)');
    assert.doesNotMatch(thinMessage ?? '', /telegra.ph/);

    const chained = pages.filter((page) => page.content.includes('Read Next page'));
    assert.equal(chained.length, 1, 'the long article links page one to page two');
  } finally {
    db.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
