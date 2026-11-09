import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createBot } from '../../src/bot/index.ts';
import { parseConfig } from '../../src/config.ts';
import { openDb, SCHEMA_VERSION, schemaVersion } from '../../src/db/index.ts';
import { callbackUpdate, fakeBotApi, startUpdate } from '../fake-api.ts';
import { allowUser } from '../seed.ts';

const TOKEN = '123456:AAHfakeTokenForTestsOnly_1234567890abc';
const USER_ID = 555;

test('M1: /start → S1, menu:add → S2, nav:back → S1, user survives a restart', async () => {
  const api = await fakeBotApi();
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-m1-'));
  const dbPath = join(dir, 'bot.db');
  const cfg = parseConfig({ BOT_TOKEN: TOKEN, ADMIN_CHAT_ID: '1', RSSHUB_BASE: 'http://rsshub.test', CALLBACK_INTERVAL_MS: '0', ADD_INTERVAL_MS: '0' });

  let db = openDb(dbPath);
  allowUser(db, USER_ID);
  try {
    assert.equal(schemaVersion(db), SCHEMA_VERSION, 'a fresh file is migrated to the current schema');

    const bot = createBot({ cfg, db, apiRoot: api.apiRoot });
    await bot.init(); // production calls this from bot.start()

    await bot.handleUpdate(startUpdate(1, USER_ID));
    const s1 = api.last('sendRichMessage');
    assert.ok(s1);
    const s1Html = String(s1.body.rich_message?.html ?? '');
    assert.match(s1Html, /Sources: 0 \/ 250/);
    assert.match(s1Html, /<b>FeedBerry<\/b>/, 'the dictionary bold markers become real bold');
    assert.doesNotMatch(s1Html, /Trial ends/, 'OQ-7: trial line hidden');
    assert.equal(s1.body.reply_markup.inline_keyboard.flat().length, 7, 'seven S1 buttons in four rows');

    const beforeAdd = api.calls.length;
    await bot.handleUpdate(callbackUpdate(2, USER_ID, 'menu:add'));
    const addCalls = api.callsSince(beforeAdd);
    assert.equal(addCalls[0]?.method, 'answerCallbackQuery', 'callback answered before any work');
    assert.equal(addCalls[1]?.method, 'editMessageText');
    assert.match(addCalls[1]?.body.text ?? '', /Adding a source/);

    await bot.handleUpdate(callbackUpdate(3, USER_ID, 'nav:back'));
    assert.match(String(api.last('editMessageText')?.body.rich_message?.html ?? ''), /<b>FeedBerry<\/b> - fresh posts/);

    // Restart: a fresh process means a fresh DB handle and a fresh Bot on the same file.
    db.close();
    assert.equal(db.isOpen, false, 'handle closed before the restart');
    db = openDb(dbPath);
    const restarted = createBot({ cfg, db, apiRoot: api.apiRoot });
    await restarted.init();
    const beforeRestart = api.calls.length;
    await restarted.handleUpdate(startUpdate(4, USER_ID));

    // /start after a restart reinstalls the reply keyboard (non-persistent, so the input-area icon
    // folds it away) and then S1.
    const afterRestart = api.callsSince(beforeRestart);
    const keyboards = afterRestart.filter((call) => call.body.reply_markup && 'keyboard' in (call.body.reply_markup as object));
    assert.equal(keyboards.length, 1, 'one reply-keyboard install');
    assert.notEqual((keyboards[0]?.body.reply_markup as { is_persistent?: boolean }).is_persistent, true, 'non-persistent: the icon hides and re-opens it');
    assert.equal(afterRestart.filter((call) => call.method === 'sendRichMessage').length, 1, 'S1 follows it');
    assert.match(
      afterRestart.map((call) => String(call.body.rich_message?.html ?? '')).find((text) => text.includes('Sources:')) ?? '',
      /Sources: 0 \/ 250/,
    );
    const users = db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
    assert.equal(users.n, 1, 'first contact persisted once, not on every /start');
  } finally {
    if (db.isOpen) db.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
