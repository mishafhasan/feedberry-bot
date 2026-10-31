import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createBot } from '../../src/bot/index.ts';
import { parseConfig } from '../../src/config.ts';
import { openDb, schemaVersion } from '../../src/db/index.ts';
import { callbackUpdate, fakeBotApi, startUpdate } from '../fake-api.ts';

const TOKEN = '123456:AAHfakeTokenForTestsOnly_1234567890abc';
const USER_ID = 555;

test('M1: /start → S1, menu:add → S2, nav:back → S1, user survives a restart', async () => {
  const api = await fakeBotApi();
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-m1-'));
  const dbPath = join(dir, 'bot.db');
  const cfg = parseConfig({ BOT_TOKEN: TOKEN, ADMIN_CHAT_ID: '1', RSSHUB_BASE: 'http://rsshub.test', CALLBACK_INTERVAL_MS: '0', ADD_INTERVAL_MS: '0' });

  let db = openDb(dbPath);
  try {
    assert.equal(schemaVersion(db), 2, 'schema_version = 2 after boot on an empty file');

    const bot = createBot({ cfg, db, apiRoot: api.apiRoot });
    await bot.init(); // production calls this from bot.start()

    await bot.handleUpdate(startUpdate(1, USER_ID));
    const s1 = api.last('sendMessage');
    assert.ok(s1);
    assert.match(s1.body.text, /Sources: 0 \/ 250/);
    assert.doesNotMatch(s1.body.text, /Trial ends/, 'OQ-7: trial line hidden');
    assert.equal(s1.body.reply_markup.inline_keyboard.length, 3, 'three S1 buttons');
    assert.equal(s1.body.parse_mode, 'HTML');

    const beforeAdd = api.calls.length;
    await bot.handleUpdate(callbackUpdate(2, USER_ID, 'menu:add'));
    const addCalls = api.callsSince(beforeAdd);
    assert.equal(addCalls[0]?.method, 'answerCallbackQuery', 'callback answered before any work');
    assert.equal(addCalls[1]?.method, 'editMessageText');
    assert.match(addCalls[1]?.body.text ?? '', /Adding a source/);

    await bot.handleUpdate(callbackUpdate(3, USER_ID, 'nav:back'));
    assert.match(api.last('editMessageText')?.body.text ?? '', /FeedBerry — fresh posts/);

    // Restart: a fresh process means a fresh DB handle and a fresh Bot on the same file.
    db.close();
    assert.equal(db.isOpen, false, 'handle closed before the restart');
    db = openDb(dbPath);
    const restarted = createBot({ cfg, db, apiRoot: api.apiRoot });
    await restarted.init();
    const beforeRestart = api.calls.length;
    await restarted.handleUpdate(startUpdate(4, USER_ID));

    assert.match(api.callsSince(beforeRestart)[0]?.body.text ?? '', /Sources: 0 \/ 250/);
    const users = db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
    assert.equal(users.n, 1, 'first contact persisted once, not on every /start');
  } finally {
    if (db.isOpen) db.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
