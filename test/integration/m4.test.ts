/**
 * M4 verification (IMPLEMENTATION_PLAN §4 M4): fixture text-source.rss with interval_minutes=1.
 * One tick → one R1 message and an advanced slot; an immediate second tick → nothing; the S9
 * manual check queues a priority-100 job without moving next_slot_at.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createBot } from '../../src/bot/index.ts';
import { parseConfig } from '../../src/config.ts';
import { openDb, type Db } from '../../src/db/index.ts';
import { runOnce } from '../../src/jobs/worker.ts';
import type { MediaEngine } from '../../src/media/cobalt.ts';
import type { Http } from '../../src/platform/http.ts';
import { tick } from '../../src/scheduler/tick.ts';
import { TelegramSender } from '../../src/telegram/api.ts';
import { callbackUpdate, fakeBotApi, startUpdate, textUpdate } from '../fake-api.ts';

const TOKEN = '123456:AAHfakeTokenForTestsOnly_1234567890abc';
const USER_ID = 555;
const RSSHUB_BASE = 'http://rsshub.test';
const BASE = readFileSync(new URL('../fixtures/text-source.rss', import.meta.url), 'utf8');
const NEW_ITEM = `<item>
      <title>Third post</title>
      <link>https://blog.example.test/third</link>
      <guid isPermaLink="false">t-3</guid>
      <pubDate>Fri, 24 Oct 2025 10:00:00 GMT</pubDate>
      <description><![CDATA[<p>Body of the third post.</p>]]></description>
    </item>`;
const UPDATED = BASE.replace('</channel>', `${NEW_ITEM}\n  </channel>`);

let feedBody = BASE;
const http: Http = async (url) => {
  // The canonical URL drops the trailing slash, so both shapes must answer.
  if (url === 'https://blog.example.test/' || url === 'https://blog.example.test') return { status: 200, url, contentType: 'application/rss+xml', body: feedBody };
  throw new Error(`unexpected fetch ${url}`);
};

const count = (db: Db, sql: string, ...args: Array<string | number>): number => (db.prepare(sql).get(...args) as { n: number }).n;

/** M4 is text-only: the engine reports no media for any URL. */
const noMedia: MediaEngine = {
  async resolve() {
    return { items: [], title: null };
  },
  async download() {
    throw new Error('no media in M4');
  },
};

test('M4: tick delivers a new text post once, then the slot stays quiet; S9 queues without moving it', async () => {
  feedBody = BASE;
  const api = await fakeBotApi();
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-m4-'));
  const cfg = parseConfig({ BOT_TOKEN: TOKEN, ADMIN_CHAT_ID: '1', RSSHUB_BASE });
  const db = openDb(join(dir, 'bot.db'));
  let updateId = 10;

  try {
    const bot = createBot({ cfg, db, apiRoot: api.apiRoot, http });
    await bot.init();
    const deps = { db, http, cfg, media: noMedia, thumbnail: async () => null, sender: new TelegramSender(bot.api), workerConcurrency: 2 };

    await bot.handleUpdate(startUpdate(1, USER_ID));
    const personal = db.prepare("SELECT id FROM chats WHERE type = 'private'").get() as { id: number };

    // "Add without sending": every current item is seen, nothing is queued for backfill.
    await bot.handleUpdate(callbackUpdate(updateId++, USER_ID, 'menu:add'));
    await bot.handleUpdate(textUpdate(updateId++, USER_ID, 'https://blog.example.test/'));
    await bot.handleUpdate(callbackUpdate(updateId++, USER_ID, `add:dest:${personal.id}`));
    await bot.handleUpdate(callbackUpdate(updateId++, USER_ID, 'add:save_silent'));
    assert.equal(count(db, 'SELECT COUNT(*) AS n FROM jobs'), 0, 'silent add queues no delivery');

    const source = db.prepare("SELECT id FROM sources WHERE canonical_url = 'https://blog.example.test'").get() as { id: number };
    const due = Date.now() - 1000;
    db.prepare('UPDATE sources SET interval_minutes = 1 WHERE id = ?').run(source.id);
    db.prepare('UPDATE subscriptions SET next_slot_at = ? WHERE source_id = ?').run(due, source.id);

    // The feed gains one post; the next tick sees it.
    feedBody = UPDATED;
    const firstTick = tick(db, Date.now());
    assert.equal(firstTick.sources, 1);
    assert.equal(firstTick.advanced, 1, 'the slot advances before the job runs');
    assert.equal(firstTick.enqueued, 1, 'one fetch per source');

    const slotAfterTick = (db.prepare('SELECT next_slot_at FROM subscriptions WHERE source_id = ?').get(source.id) as { next_slot_at: number }).next_slot_at;
    assert.ok(slotAfterTick > Date.now(), 'next_slot_at moved into the future');

    const sentBefore = api.calls.filter((c) => c.method === 'sendMessage').length;
    assert.equal(await runOnce(deps, Date.now()), true, 'the worker claims the fetch job');

    const sent = api.calls.filter((c) => c.method === 'sendMessage').slice(sentBefore);
    assert.equal(sent.length, 1, 'exactly one R1 message');
    assert.match(sent[0]?.body.text ?? '', /Third post/);
    assert.match(sent[0]?.body.text ?? '', /Body of the third post/);
    assert.equal(sent[0]?.body.parse_mode, 'HTML');
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM deliveries WHERE status = 'sent'"), 1);
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM posts WHERE guid = 't-3'"), 1);

    // Immediately again: nothing is due, so no fetch is queued (the daily cleanup job may still be).
    const secondTick = tick(db, Date.now());
    assert.equal(secondTick.enqueued, 0, 'no duplicate fetch');
    while (await runOnce(deps, Date.now())) {
      // drain whatever is left (the daily retention job)
    }
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM jobs WHERE kind = 'fetch_source' AND state = 'queued'"), 0);
    assert.equal(api.calls.filter((c) => c.method === 'sendMessage').length, sentBefore + 1, 'no duplicate message');

    // S9: the manual check is queued at priority 100 and leaves the slot alone.
    const slotBeforeCheck = slotAfterTick;
    const mark = api.calls.length;
    await bot.handleUpdate(callbackUpdate(updateId++, USER_ID, `src:check:${source.id}`));
    const checkCalls = api.callsSince(mark);
    assert.equal(checkCalls[0]?.method, 'answerCallbackQuery');
    assert.equal(checkCalls[0]?.body.text, 'Queued for a check — the source will be polled within a minute.');
    const job = db.prepare("SELECT kind, priority FROM jobs WHERE kind = 'manual_check'").get() as { kind: string; priority: number };
    assert.equal(job.priority, 100);
    assert.equal((db.prepare('SELECT next_slot_at FROM subscriptions WHERE source_id = ?').get(source.id) as { next_slot_at: number }).next_slot_at, slotBeforeCheck);
  } finally {
    db.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
