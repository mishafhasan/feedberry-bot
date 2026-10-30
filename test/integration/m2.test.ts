/**
 * M2 verification (IMPLEMENTATION_PLAN §4 M2): fixture ig-profile.rss + chats.json.
 * A profile link yields S3 then S4 with the five newest titles ascending; the destination list
 * holds the verified channel and the personal row, never a channel without posting rights.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createBot } from '../../src/bot/index.ts';
import { parseConfig } from '../../src/config.ts';
import { openDb } from '../../src/db/index.ts';
import type { Http } from '../../src/platform/http.ts';
import { callbackUpdate, chatMemberUpdate, fakeBotApi, startUpdate, textUpdate, type FakeChat } from '../fake-api.ts';

const TOKEN = '123456:AAHfakeTokenForTestsOnly_1234567890abc';
const USER_ID = 555;
const RSSHUB_BASE = 'http://rsshub.test';

const chats = JSON.parse(readFileSync(new URL('../fixtures/chats.json', import.meta.url), 'utf8')) as Record<
  string,
  { id: number; type: string; title: string; member: Record<string, unknown> }
>;
const fixture = readFileSync(new URL('../fixtures/ig-profile.rss', import.meta.url), 'utf8');

const apiChats: Record<number, FakeChat> = {};
for (const entry of Object.values(chats)) apiChats[entry.id] = { chat: { id: entry.id, type: entry.type, title: entry.title }, member: entry.member };

const adminChannel = chats.adminChannel as NonNullable<typeof chats.adminChannel>;
const plainChannel = chats.plainChannel as NonNullable<typeof chats.plainChannel>;
const mutedChannel = chats.mutedChannel as NonNullable<typeof chats.mutedChannel>;

/** Only the one RSSHub route may be fetched; anything else is a bug in the pipeline. */
const http: Http = async (url) => {
  if (url === `${RSSHUB_BASE}/instagram/user/cristiano`) {
    return { status: 200, url, contentType: 'application/rss+xml', body: fixture };
  }
  throw new Error(`unexpected fetch ${url}`);
};

const itemLines = (text: string): string[] => text.split('\n').filter((line) => line.startsWith('• '));

test('M2: profile → S3 → S4 with five ascending titles and verified destinations', async () => {
  const api = await fakeBotApi(apiChats);
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-m2-'));
  const cfg = parseConfig({ BOT_TOKEN: TOKEN, ADMIN_CHAT_ID: '1', RSSHUB_BASE });
  const db = openDb(join(dir, 'bot.db'));

  try {
    const bot = createBot({ cfg, db, apiRoot: api.apiRoot, http });
    await bot.init();

    // ADR-014: admin channel stored, plain member channel refused and never stored.
    await bot.handleUpdate(chatMemberUpdate(1, USER_ID, adminChannel.id, 'administrator'));
    await bot.handleUpdate(chatMemberUpdate(2, USER_ID, plainChannel.id, 'member'));

    const adminLink = api.calls.find((c) => c.method === 'sendMessage' && Number(c.body.chat_id) === adminChannel.id);
    assert.equal(adminLink, undefined, 'an admin channel needs no complaint');
    const refused = api.calls.find((c) => c.method === 'sendMessage' && Number(c.body.chat_id) === plainChannel.id);
    assert.match(refused?.body.text ?? '', /admin with permission to post/, 'E_BOT_NOT_ADMIN reaches the chat');
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM chats WHERE tg_chat_id = ?').get(plainChannel.id) as { n: number }).n, 0, 'refused chat not stored');

    // A channel where the bot is admin but may not post is refused too.
    await bot.handleUpdate(chatMemberUpdate(3, USER_ID, mutedChannel.id, 'administrator'));
    assert.match(
      api.calls.filter((c) => Number(c.body.chat_id) === mutedChannel.id && c.method === 'sendMessage').at(-1)?.body.text ?? '',
      /admin with permission to post/,
    );
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM chats WHERE tg_chat_id = ?').get(mutedChannel.id) as { n: number }).n, 0);

    await bot.handleUpdate(startUpdate(4, USER_ID));
    await bot.handleUpdate(callbackUpdate(5, USER_ID, 'menu:add'));

    const before = api.calls.length;
    await bot.handleUpdate(textUpdate(6, USER_ID, 'https://www.instagram.com/cristiano/'));

    const flow = api.callsSince(before);
    const s3 = flow.find((c) => c.method === 'sendMessage' && /Checking source/.test(c.body.text ?? ''));
    assert.ok(s3, 'S3 is shown while the feed is fetched');
    assert.match(s3.body.text, /https:\/\/instagram\.com\/cristiano/, 'S3 shows the canonical URL');

    const s4 = flow.find((c) => c.method === 'sendPhoto');
    assert.ok(s4, 'S4 is sent as a photo with the avatar');
    assert.equal(s4.body.photo, 'https://cdn.example.test/avatar.jpg');

    const lines = itemLines(s4.body.caption);
    assert.equal(lines.length, 5, 'exactly five titles');
    assert.match(lines[0] ?? '', /Putting in the work/, 'oldest of the newest five comes first');
    assert.match(lines[4] ?? '', /Newest post/, 'newest comes last');
    const stamps = lines.map((line) => /\[(\d{2})\/(\d{2}) (\d{2}):(\d{2})\]/.exec(line)?.slice(1).join('') ?? '');
    assert.deepEqual(stamps, [...stamps].sort(), 'titles ascend by published_at');

    const buttons = (s4.body.reply_markup?.inline_keyboard ?? []).flat().map((b: { text: string }) => b.text);
    assert.ok(buttons.includes('👤 Personal account'), 'personal row always offered');
    assert.ok(buttons.includes(`📢 ${adminChannel.title}`), 'verified channel listed');
    assert.ok(!buttons.includes(`📢 ${plainChannel.title}`), 'unverified channel never listed');
    assert.equal(buttons.at(-1), '← Back');

    assert.ok(flow.some((c) => c.method === 'deleteMessage'), 'the S3 placeholder is removed');
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM chats WHERE type = 'private'").get() as { n: number }).n, 1);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM sources').get() as { n: number }).n, 0, 'M2 stays read-only (ADR-015)');
  } finally {
    db.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
