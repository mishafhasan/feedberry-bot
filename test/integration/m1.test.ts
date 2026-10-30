/**
 * M1 verification (IMPLEMENTATION_PLAN §4 M1): fake Bot API + temp DB.
 * /start renders S1, menu:add renders S2, nav:back returns, a restart keeps the user.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Update } from 'grammy/types';
import { createBot } from '../../src/bot/index.ts';
import { parseConfig } from '../../src/config.ts';
import { openDb, schemaVersion } from '../../src/db/index.ts';

const TOKEN = '123456:AAHfakeTokenForTestsOnly_1234567890abc';
const USER_ID = 555;
const CHAT = { id: USER_ID, type: 'private' };

interface Call {
  method: string;
  body: Record<string, any>;
}

/** Records every Bot API call and answers with a plausible result. */
async function fakeBotApi() {
  const calls: Call[] = [];
  let messageId = 100;

  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const method = new URL(req.url ?? '/', 'http://localhost').pathname.split('/').pop() ?? '';
      const body = raw ? JSON.parse(raw) : {};
      calls.push({ method, body });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, result: resultFor(method, body) }));
    });
  });

  const resultFor = (method: string, body: Record<string, any>): unknown => {
    switch (method) {
      case 'getMe':
        return {
          id: 999,
          is_bot: true,
          first_name: 'FeedBerry',
          username: 'feedberry_bot',
          can_join_groups: true,
          can_read_all_group_messages: false,
          supports_inline_queries: false,
        };
      case 'answerCallbackQuery':
        return true;
      case 'sendMessage':
      case 'editMessageText':
        return { message_id: ++messageId, date: 0, chat: { id: body.chat_id, type: 'private' } };
      default:
        return true;
    }
  };

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    apiRoot: `http://127.0.0.1:${port}`,
    calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const startUpdate = (updateId: number): Update => ({
  update_id: updateId,
  message: {
    message_id: 1,
    date: 0,
    chat: CHAT,
    from: { id: USER_ID, is_bot: false, first_name: 'Tester' },
    text: '/start',
    entities: [{ type: 'bot_command', offset: 0, length: 6 }],
  },
});

const callbackUpdate = (updateId: number, data: string): Update => ({
  update_id: updateId,
  callback_query: {
    id: `cb${updateId}`,
    from: { id: USER_ID, is_bot: false, first_name: 'Tester' },
    chat_instance: 'ci',
    data,
    message: { message_id: 42, date: 0, chat: CHAT },
  },
});

function lastCall(calls: Call[], method: string): Call {
  const found = calls.filter((c) => c.method === method).at(-1);
  assert.ok(found, `expected a ${method} call`);
  return found;
}

test('M1: /start → S1, menu:add → S2, nav:back → S1, user survives a restart', async () => {
  const api = await fakeBotApi();
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-m1-'));
  const dbPath = join(dir, 'bot.db');
  const cfg = parseConfig({ BOT_TOKEN: TOKEN, ADMIN_CHAT_ID: '1', RSSHUB_BASE: 'http://rsshub:1200' });

  let db = openDb(dbPath);
  try {
    assert.equal(schemaVersion(db), 1, 'schema_version = 1 after boot on an empty file');

    const bot = createBot({ cfg, db, apiRoot: api.apiRoot });
    await bot.init(); // production calls this from bot.start()

    await bot.handleUpdate(startUpdate(1));
    const s1 = lastCall(api.calls, 'sendMessage');
    assert.match(s1.body.text, /Sources: 0 \/ 250/);
    assert.doesNotMatch(s1.body.text, /Trial ends/, 'OQ-7: trial line hidden');
    assert.equal(s1.body.reply_markup.inline_keyboard.length, 3, 'three S1 buttons');
    assert.equal(s1.body.parse_mode, 'HTML');

    const beforeAdd = api.calls.length;
    await bot.handleUpdate(callbackUpdate(2, 'menu:add'));
    const addCalls = api.calls.slice(beforeAdd);
    assert.equal(addCalls[0]?.method, 'answerCallbackQuery', 'callback answered before any work');
    assert.equal(addCalls[1]?.method, 'editMessageText');
    assert.match(addCalls[1]?.body.text ?? '', /Adding a source/);

    await bot.handleUpdate(callbackUpdate(3, 'nav:back'));
    assert.match(lastCall(api.calls, 'editMessageText').body.text, /FeedBerry — fresh posts/);

    // Restart: a fresh process means a fresh DB handle and a fresh Bot on the same file.
    db.close();
    assert.equal(db.isOpen, false, 'handle closed before the restart');
    db = openDb(dbPath);
    const restarted = createBot({ cfg, db, apiRoot: api.apiRoot });
    await restarted.init();
    const beforeRestart = api.calls.length;
    await restarted.handleUpdate(startUpdate(4));

    assert.match(lastCall(api.calls.slice(beforeRestart), 'sendMessage').body.text, /Sources: 0 \/ 250/);
    const users = db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
    assert.equal(users.n, 1, 'first contact persisted once, not on every /start');
  } finally {
    if (db.isOpen) db.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
