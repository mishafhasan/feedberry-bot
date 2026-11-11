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
    return { items: [], title: WORDS, artist: 'jacobwren' };
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

    const texts = api.calls.filter((call) => call.method === 'sendMessage').map((call) => String(call.body.text ?? ''));
    const post = texts.find((text) => text.includes(WORDS));
    assert.ok(post, `the words are delivered, saw: ${texts.map((t) => t.slice(0, 40)).join(' | ')}`);
    assert.ok(post.endsWith('https://jacobwren.tumblr.com/post/802858401532116992'), 'the canonical post link closes it');
    assert.ok(!texts.some((text) => text.includes('Couldn’t extract media') || text.includes("Couldn't extract media")), 'no extraction error notice');
  } finally {
    db.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
