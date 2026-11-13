/**
 * A words-only post (a Tumblr text post) has no media to extract. Download Mode must still deliver
 * its text and its link, not the "couldn't extract media" notice.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createBot } from '../../src/bot/index.ts';
import { parseConfig } from '../../src/config.ts';
import { openDb } from '../../src/db/index.ts';
import type { MediaEngine } from '../../src/media/media-engine.ts';
import type { Http } from '../../src/platform/http.ts';
import { callbackUpdate, fakeBotApi, startUpdate, textUpdate } from '../fake-api.ts';
import { allowUser } from '../seed.ts';

const TOKEN = '123456:AAHfakeTokenForTestsOnly_1234567890abc';
const USER_ID = 555;
const POST = 'https://www.tumblr.com/jacobwren/802858401532116992?source=share';
const WORDS = 'But AI can’t do your job. It can help you do your job.';

const engine: MediaEngine = {
  async resolve() {
    return { items: [], title: WORDS, artist: 'jacobwren', publishedAt: Date.UTC(2025, 11, 13, 22, 37) };
  },
  async download() {
    throw new Error('a words-only post has nothing to download');
  },
};

const http: Http = async () => {
  throw new Error('no page fetch expected');
};

test('Download Mode: a words-only post arrives as its text and its link', async () => {
  const api = await fakeBotApi();
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-text-post-'));
  const cfg = parseConfig({ BOT_TOKEN: TOKEN, ADMIN_CHAT_ID: '1', RSSHUB_BASE: 'http://rsshub.test', CALLBACK_INTERVAL_MS: '0', ADD_INTERVAL_MS: '0' });
  const db = openDb(join(dir, 'bot.db'));
  allowUser(db, USER_ID);

  try {
    const bot = createBot({ cfg, db, apiRoot: api.apiRoot, http, media: engine });
    await bot.init();

    await bot.handleUpdate(startUpdate(1, USER_ID));
    await bot.handleUpdate(callbackUpdate(2, USER_ID, 'menu:download'));
    await bot.handleUpdate(textUpdate(3, USER_ID, POST));

    const html = String(api.last('sendRichMessage')?.body.rich_message?.html ?? '');
    assert.ok(html.includes(WORDS), `the words are delivered, saw: ${html.slice(0, 80)}`);
    assert.match(html, /⏱️ <b>Time<\/b>: 13\/12 22:37/, 'the publish date wears the time line of every other source');
    assert.match(html, /<a href="https:\/\/jacobwren\.tumblr\.com\/post\/802858401532116992">jacobwren<\/a> \| Tumblr/, 'the canonical post link is the header');
    const texts = api.calls.filter((call) => call.method === 'sendMessage').map((call) => String(call.body.text ?? ''));
    assert.ok(!texts.some((text) => text.includes('Couldn’t extract media') || text.includes("Couldn't extract media")), 'no extraction error notice');
  } finally {
    db.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
