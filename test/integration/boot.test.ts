/**
 * Boot smoke (M9 evidence that does not need Docker): the real entry point, started as a child
 * process, long-polls a local Bot API server and delivers a post it fetched over real HTTP from a
 * local RSSHub stand-in. Nothing here mocks the network stack or the runner.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDb } from '../../src/db/index.ts';
import { ensurePrivateChat } from '../../src/db/repos/chats.ts';
import { upsertSource } from '../../src/db/repos/sources.ts';
import { insertSubscription } from '../../src/db/repos/subscriptions.ts';
import { ensureUser } from '../../src/db/repos/users.ts';

const TOKEN = '123456:AAHfakeTokenForTestsOnly_1234567890abc';
const USER_ID = 555;
const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Text Blog</title>
  <item><title>First post</title><link>https://blog.example.test/first</link>
  <guid>t-1</guid><pubDate>Fri, 24 Oct 2025 10:00:00 GMT</pubDate>
  <description>Body of the first post.</description></item>
</channel></rss>`;

interface Call {
  method: string;
  body: Record<string, any>;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function waitFor(what: string, predicate: () => boolean, ms = 20_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

test('boot: the real entry point polls, fetches over HTTP and delivers a post', async () => {
  const calls: Call[] = [];
  const updates: unknown[] = [];
  let messageId = 100;

  const telegram = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const method = new URL(req.url ?? '/', 'http://x').pathname.split('/').pop() ?? '';
      const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
      calls.push({ method, body });
      res.setHeader('content-type', 'application/json');
      if (method === 'getUpdates') {
        const batch = updates.splice(0);
        // Long polling without the wait: answer immediately, but do not let the bot spin.
        setTimeout(() => res.end(JSON.stringify({ ok: true, result: batch })), batch.length > 0 ? 0 : 200);
        return;
      }
      if (method === 'getMe') {
        res.end(JSON.stringify({ ok: true, result: { id: 999, is_bot: true, first_name: 'FeedBerry', username: 'feedberry_bot' } }));
        return;
      }
      if (method === 'sendMessage') {
        res.end(JSON.stringify({ ok: true, result: { message_id: ++messageId, date: 0, chat: { id: Number(body.chat_id), type: 'private' } } }));
        return;
      }
      res.end(JSON.stringify({ ok: true, result: true }));
    });
  });

  const rsshub = createServer((req, res) => {
    if (req.url === '/feed') {
      res.writeHead(200, { 'content-type': 'application/rss+xml' });
      res.end(feedXml);
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const dir = mkdtempSync(join(tmpdir(), 'feedberry-boot-'));
  const dbPath = join(dir, 'bot.db');
  const tgUrl = await listen(telegram);
  const rsshubUrl = await listen(rsshub);
  // The post link points at the local stand-in: a real answer in milliseconds beats DNS for a
  // reserved `.test` host, which can stall the article/media stages past this test's budget.
  const feedXml = FEED.replace('https://blog.example.test/first', `${rsshubUrl}/post`);
  let child: ReturnType<typeof spawn> | undefined;

  try {
    // Seed one due subscription; everything else is the process's own work.
    const seed = openDb(dbPath);
    const user = ensureUser(seed, USER_ID);
    const chat = ensurePrivateChat(seed, user.id, USER_ID);
    const source = upsertSource(seed, {
      platform: 'rss',
      canonicalUrl: 'https://blog.example.test',
      externalId: 'blog',
      feedUrl: `${rsshubUrl}/feed`,
      strategy: 'native_rss',
      title: 'Text Blog',
      avatarUrl: null,
    });
    insertSubscription(seed, { userId: user.id, sourceId: source.id, chatId: chat.id, deliver: true, nextSlotAt: Date.now() - 1000 });
    seed.prepare('UPDATE sources SET interval_minutes = 1 WHERE id = ?').run(source.id);
    seed.close();

    child = spawn(process.execPath, ['src/main.ts'], {
      env: {
        ...process.env,
        BOT_TOKEN: TOKEN,
        ADMIN_CHAT_ID: '1',
        RSSHUB_BASE: rsshubUrl,
        DB_PATH: dbPath,
        TELEGRAM_API_ROOT: tgUrl,
        CALLBACK_INTERVAL_MS: '0',
        ADD_INTERVAL_MS: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));

    await waitFor('polling_started', () => output.includes('polling_started'), 20_000);
    await waitFor(
      'the delivered post',
      () => calls.some((call) => call.method === 'sendMessage' && String(call.body.text).includes('First post')),
      20_000,
    );

    // The bot is still answering updates: /start renders S1 with the seeded source counted.
    updates.push({
      update_id: 1,
      message: {
        message_id: 1,
        date: 0,
        chat: { id: USER_ID, type: 'private' },
        from: { id: USER_ID, is_bot: false, first_name: 'Tester' },
        text: '/start',
        entities: [{ type: 'bot_command', offset: 0, length: 6 }],
      },
    });
    await waitFor(
      'S1 after /start',
      () => calls.some((call) => call.method === 'sendRichMessage' && String(call.body.rich_message?.html).includes('Sources: 1 / 250')),
      20_000,
    );

    const delivered = calls.filter((call) => call.method === 'sendMessage').map((call) => String(call.body.text));
    assert.ok(delivered.some((text) => text.includes('Body of the first post.')), 'the feed body reached Telegram');
    assert.ok(output.includes('fetch_done'), `expected a fetch log, got: ${output.slice(0, 400)}`);

    // Stage 8 writes the row just after the send leaves. Poll for it while the writer is alive:
    // a killed process can leave a WAL the next connection refuses to replay under I/O load.
    await waitFor('the delivery row', () => {
      const db = openDb(dbPath);
      const rows = db.prepare('SELECT status FROM deliveries').all() as Array<{ status: string }>;
      db.close();
      assert.ok(rows.length <= 1, `one row per (post, chat), found ${JSON.stringify(rows)}`);
      return rows.length === 1 && rows[0].status === 'sent';
    }, 10_000);
  } finally {
    child?.kill();
    await new Promise<void>((resolve) => telegram.close(() => resolve()));
    await new Promise<void>((resolve) => rsshub.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
