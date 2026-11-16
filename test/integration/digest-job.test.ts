/**
 * ADR-029 end to end, offline: the tick enqueues a due digest, the job fetches its sources, summarises
 * the window through a faked Gemini, sends one rich message with the audio player, and commits the
 * window. A dead Gemini leaves the window pinned for the retry.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createBot } from '../../src/bot/index.ts';
import { parseConfig, type Config } from '../../src/config.ts';
import { openDb, type Db } from '../../src/db/index.ts';
import { ensurePrivateChat } from '../../src/db/repos/chats.ts';
import { advanceDigest, ensureDigest, getDigest, setDigestEnabled, toggleDigestSource, type DigestRow } from '../../src/db/repos/digests.ts';
import { insertPosts } from '../../src/db/repos/posts.ts';
import { upsertSource } from '../../src/db/repos/sources.ts';
import { insertSubscription } from '../../src/db/repos/subscriptions.ts';
import { ensureUser } from '../../src/db/repos/users.ts';
import { geminiClient, type Gemini } from '../../src/digest/gemini.ts';
import { runDigest } from '../../src/digest/run.ts';
import { enqueue, PRIORITY } from '../../src/jobs/queue.ts';
import { runOnce, type WorkerDeps } from '../../src/jobs/worker.ts';
import type { MediaEngine } from '../../src/media/media-engine.ts';
import type { Http } from '../../src/platform/http.ts';
import type { AudioEncoder } from '../../src/digest/audio.ts';
import { tick } from '../../src/scheduler/tick.ts';
import { TelegramSender } from '../../src/telegram/api.ts';
import { fakeBotApi } from '../fake-api.ts';
import { allowUser } from '../seed.ts';

const TOKEN = '123456:AAHfakeTokenForTestsOnly_1234567890abc';
const USER_ID = 621;
const HOUR = 3_600_000;

const config = (): Config => {
  const cfg = parseConfig({
    BOT_TOKEN: TOKEN,
    ADMIN_CHAT_ID: '1',
    RSSHUB_BASE: 'http://rsshub.test',
    GEMINI_API_KEY: 'test-key',
    DIGEST_MAX_POSTS: '10',
    CALLBACK_INTERVAL_MS: '0',
    ADD_INTERVAL_MS: '0',
  });
  assert.ok(cfg.digest);
  return cfg;
};

/** The whole network is offline in this test; the feed and the page fetches fail on purpose. */
const http: Http = async (url) => {
  throw new Error(`offline: ${url}`);
};

const noMedia: MediaEngine = {
  async resolve() {
    throw new Error('no media in a digest test');
  },
  async download() {
    throw new Error('no media in a digest test');
  },
};

const writeOnly: AudioEncoder = (pcm, file) => writeFile(file, pcm);

const json = (payload: unknown, status = 200): Response => new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });

/** Answers the interactions API: JSON for summaries, text for the script, PCM for the voice. */
function fakeGemini(options: { failJson?: boolean } = {}): { gemini: Gemini; bodies: Array<Record<string, any>>; headers: string[] } {
  const bodies: Array<Record<string, any>> = [];
  const headers: string[] = [];
  const doFetch: typeof fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    headers.push(String((init?.headers as Record<string, string> | undefined)?.['x-goog-api-key'] ?? ''));
    const body = bodies[bodies.length - 1] as Record<string, any>;
    if (body.response_format?.type === 'audio') {
      return json({ steps: [{ type: 'model_output', content: [{ type: 'audio', data: Buffer.alloc(48_000).toString('base64') }] }] });
    }
    if (body.response_format?.mime_type === 'application/json') {
      if (options.failJson === true) return json({ error: { message: 'down' } }, 500);
      const summary = { headline: 'Model headline', description: 'Model description of the story.', key_points: ['point one', 'point two'] };
      return json({ steps: [{ type: 'model_output', content: [{ type: 'text', text: JSON.stringify(summary) }] }] });
    }
    return json({ steps: [{ type: 'model_output', content: [{ type: 'text', text: 'Welcome to the digest. First story. Second story. Goodbye from FeedBerry.' }] }] });
  };
  return { gemini: geminiClient(config().digest as NonNullable<Config['digest']>, doFetch), bodies, headers };
}

interface Seeded {
  dir: string;
  db: Db;
  digest: DigestRow;
  sourceIds: number[];
}

function seed(): Seeded {
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-digest-job-'));
  const db = openDb(join(dir, 'bot.db'));
  const user = ensureUser(db, USER_ID);
  const chat = ensurePrivateChat(db, user.id, USER_ID);
  const sourceIds: number[] = [];
  const now = Date.UTC(2026, 10, 16, 8, 0);

  for (const [index, title] of ['Blog', 'Second Blog'].entries()) {
    const source = upsertSource(db, {
      platform: 'rss',
      canonicalUrl: `https://blog${index}.test`,
      externalId: `blog${index}.test`,
      feedUrl: `https://blog${index}.test/feed`,
      strategy: 'native_rss',
      title,
      avatarUrl: null,
    });
    // A far slot keeps the tick from queueing normal fetches: only the digest is under test.
    const subscription = insertSubscription(db, { userId: user.id, sourceId: source.id, chatId: chat.id, deliver: true, nextSlotAt: now + 24 * HOUR });
    assert.ok(subscription);
    sourceIds.push(source.id);
    const digest = ensureDigest(db, user.id, chat.id);
    assert.equal(toggleDigestSource(db, user.id, digest.id, subscription.id), 'added');
  }

  const seedPost = (sourceId: number, guid: string, seenAt: number): void => {
    insertPosts(db, sourceId, [{ guid, link: `https://blog.test/${guid}`, title: `Feed title ${guid}`, summary: `Feed body ${guid}`, publishedAt: null, media: [] }], seenAt);
  };
  seedPost(sourceIds[0] as number, 'inside-a', now - 2 * HOUR);
  seedPost(sourceIds[0] as number, 'too-old', now - 30 * HOUR);
  seedPost(sourceIds[1] as number, 'inside-b', now - 3 * HOUR);
  // Stamped at the run instant, the way the pre-run check records what it just found: it must be in
  // this digest, not in tomorrow's (the window's upper bound is strict).
  seedPost(sourceIds[0] as number, 'found-by-the-check', now);

  const digest = ensureDigest(db, user.id, chat.id);
  setDigestEnabled(db, digest.id, true, now - 1000);
  return { dir, db, digest, sourceIds };
}

function workerDeps(db: Db, apiRoot: string, gemini: Gemini, api: Awaited<ReturnType<typeof fakeBotApi>>): WorkerDeps {
  const bot = createBot({ cfg: config(), db, apiRoot, http, media: noMedia });
  return {
    db,
    http,
    cfg: config(),
    media: noMedia,
    thumbnail: async () => null,
    sender: new TelegramSender(bot.api),
    gemini,
    encodeAudio: writeOnly,
    workerConcurrency: 1,
  };
}

test('digest job: one rich message with the player, the numbered items and the audio media', async () => {
  const api = await fakeBotApi();
  const { dir, db, digest, sourceIds } = seed();
  const now = Date.UTC(2026, 10, 16, 8, 0);
  const { gemini, bodies, headers } = fakeGemini();
  const deps = workerDeps(db, api.apiRoot, gemini, api);

  try {
    const ticked = tick(db, now, { digests: true });
    assert.equal(ticked.digests, 1, 'a due digest is enqueued once');

    while (await runOnce(deps, now)) {
      // drain the digest (and the daily cleanup the tick also queues)
    }

    const rich = api.last('sendRichMessage')?.body.rich_message as { html?: string; media?: Array<{ id: string; media: { type: string } }> };
    const html = String(rich?.html ?? '');
    assert.match(html, /🫐 Daily Digest/);
    assert.match(html, /📅 .* · 🗞 3 posts · 2 sources/, 'the window holds the two fresh posts and the one the check just found');
    assert.match(html, /<audio src="tg:\/\/audio\?id=overview"><\/audio>/);
    assert.match(html, /🎧 Audio overview · 1 min/);
    assert.match(html, /<h3>1\. Model headline<\/h3>/);
    assert.match(html, /<h3>2\. Model headline<\/h3>/);
    assert.match(html, /<h3>3\. Model headline<\/h3>/);
    assert.match(html, /🔑 Key points<\/b><\/p><ul><li>point one<\/li><li>point two<\/li><\/ul>/);
    assert.match(html, /📖 Read full article — <a href="https:\/\/blog.test\//, 'no Telegraph client: the post is the link');
    assert.match(html, /<footer>🤖 AI-generated summary of 3 posts/);

    const media = rich?.media ?? [];
    assert.equal(media.length, 1, 'the MP3 is the only attachment');
    assert.equal(media[0]?.media.type, 'audio');

    assert.ok(bodies.some((body) => typeof body.input === 'string' && body.input.includes('<<<ARTICLE')), 'the article text is wrapped as data');
    assert.ok(bodies.some((body) => typeof body.input === 'string' && body.input.includes('Feed title inside-a')), 'the feed title reaches the prompt');
    assert.ok(bodies.every((body) => body.model !== undefined), 'both models are named');
    assert.equal(headers.every((value) => value === 'test-key'), true, 'the key travels in its header');

    const after = getDigest(db, digest.id);
    assert.equal(after?.window_end, null, 'the pin is released after the last part');
    assert.equal(after?.last_window_end, now + 1, 'the window ended just after the pre-check stamped its posts');
    assert.equal(sourceIds.length, 2);
  } finally {
    db.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('digest job: a second run inside the same day sends the empty-window message once', async () => {
  const api = await fakeBotApi();
  const { dir, db, digest } = seed();
  const now = Date.UTC(2026, 10, 16, 8, 0);
  const { gemini } = fakeGemini();
  const deps = workerDeps(db, api.apiRoot, gemini, api);

  try {
    await runDigest(deps, digest.id, now);
    assert.ok(api.last('sendRichMessage'));

    const mark = api.calls.length;
    advanceDigest(db, digest.id, now + 60_000);
    await runDigest(deps, digest.id, now + 60_000);
    const second = api.callsSince(mark).filter((call) => call.method === 'sendRichMessage');
    assert.equal(second.length, 1, 'no new posts, still one message');
    assert.match(String(second[0]?.body.rich_message?.html ?? ''), /No new posts from your digest sources in the last 24 hours\./);
    assert.doesNotMatch(String(second[0]?.body.rich_message?.html ?? ''), /tg:\/\/audio/);
    assert.equal(getDigest(db, digest.id)?.last_window_end, now + 60_000 + 1, 'the empty window is committed too, one instant past its run clock');
  } finally {
    db.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('digest job: every summary failing leaves the window pinned and the job queued', async () => {
  const api = await fakeBotApi();
  const { dir, db, digest } = seed();
  const now = Date.UTC(2026, 10, 16, 8, 0);
  const { gemini } = fakeGemini({ failJson: true });
  const deps = workerDeps(db, api.apiRoot, gemini, api);

  try {
    enqueue(db, { kind: 'digest', targetId: digest.id, priority: PRIORITY.scheduled, runAfter: now });
    await runOnce(deps, now);

    assert.equal(api.last('sendRichMessage'), undefined, 'nothing ships when every story failed');
    const job = db.prepare("SELECT state, attempts, last_error FROM jobs WHERE kind = 'digest'").get() as { state: string; attempts: number; last_error: string | null };
    assert.equal(job.state, 'queued', 'the worker reschedules instead of failing the job');
    assert.equal(job.attempts, 1);
    assert.match(String(job.last_error), /E_FEED_DOWN/);

    const after = getDigest(db, digest.id);
    assert.equal(after?.window_end, now + 1, 'the retry must select the same posts');
    assert.equal(after?.last_window_end, null);
  } finally {
    db.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
