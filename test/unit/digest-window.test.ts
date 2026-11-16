/**
 * ADR-029's window: the hour is wall clock in the owner's zone (DST included), and consecutive runs
 * tile — no post twice, none older than 24 h, and a stale last_window_end is clamped.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDb } from '../../src/db/index.ts';
import { ensurePrivateChat } from '../../src/db/repos/chats.ts';
import { commitDigestWindow, digestPosts, ensureDigest, pinDigestWindow, toggleDigestSource } from '../../src/db/repos/digests.ts';
import { insertPosts } from '../../src/db/repos/posts.ts';
import { upsertSource } from '../../src/db/repos/sources.ts';
import { insertSubscription } from '../../src/db/repos/subscriptions.ts';
import { ensureUser } from '../../src/db/repos/users.ts';
import { digestSlot } from '../../src/scheduler/slots.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

test('digestSlot: later today when the hour has not passed, tomorrow when it has', () => {
  const now = Date.UTC(2026, 10, 16, 6, 30);
  assert.equal(digestSlot(now, 'UTC', 8), Date.UTC(2026, 10, 16, 8, 0), '08:00 today is still ahead');
  assert.equal(digestSlot(now, 'UTC', 5), Date.UTC(2026, 10, 17, 5, 0), '05:00 has passed, so tomorrow');
});

test('digestSlot: the hour stays a wall clock across a DST change', () => {
  // Berlin springs forward on 2026-03-29 at 01:00 UTC: 07:00 local is then CEST (+2) = 05:00Z.
  const beforeSpring = Date.UTC(2026, 2, 28, 22, 0);
  assert.equal(digestSlot(beforeSpring, 'Europe/Berlin', 7), Date.UTC(2026, 2, 29, 5, 0));

  // Berlin falls back on 2026-10-25 at 01:00 UTC: 07:00 local is then CET (+1) = 06:00Z.
  const beforeAutumn = Date.UTC(2026, 9, 24, 22, 0);
  assert.equal(digestSlot(beforeAutumn, 'Europe/Berlin', 7), Date.UTC(2026, 9, 25, 6, 0));

  // Tamil Nadu keeps one offset, so the same hour is the same UTC time every day.
  assert.equal(digestSlot(Date.UTC(2026, 4, 1, 0, 0), 'Asia/Kolkata', 7), Date.UTC(2026, 4, 1, 1, 30));
});

test('the window query tiles two runs and never reaches past 24 hours', () => {
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-digest-'));
  const db = openDb(join(dir, 'bot.db'));

  try {
    const user = ensureUser(db, 900);
    const chat = ensurePrivateChat(db, user.id, 900);
    const source = upsertSource(db, {
      platform: 'rss',
      canonicalUrl: 'https://blog.test',
      externalId: 'blog.test',
      feedUrl: 'https://blog.test/feed',
      strategy: 'native_rss',
      title: 'Blog',
      avatarUrl: null,
    });
    const other = upsertSource(db, {
      platform: 'rss',
      canonicalUrl: 'https://other.test',
      externalId: 'other.test',
      feedUrl: 'https://other.test/feed',
      strategy: 'native_rss',
      title: 'Other',
      avatarUrl: null,
    });
    const subscription = insertSubscription(db, { userId: user.id, sourceId: source.id, chatId: chat.id, deliver: true, nextSlotAt: null });
    assert.ok(subscription);
    const outside = insertSubscription(db, { userId: user.id, sourceId: other.id, chatId: chat.id, deliver: true, nextSlotAt: null });
    assert.ok(outside);

    const digest = ensureDigest(db, user.id, chat.id);
    assert.equal(toggleDigestSource(db, user.id, digest.id, subscription.id), 'added');

    const t0 = Date.UTC(2026, 10, 16, 8, 0);
    const seed = (guid: string, seen: number, sourceId = source.id): number => {
      const rows = insertPosts(db, sourceId, [{ guid, link: `https://blog.test/${guid}`, title: guid, summary: 'body', publishedAt: null, media: [] }], seen);
      return rows[0]?.id ?? 0;
    };
    const insideFirst = seed('first-window', t0 - 2 * HOUR);
    const tooOld = seed('older-than-a-day', t0 - 25 * HOUR);
    const notSelected = seed('not-in-digest', t0 - 2 * HOUR, other.id);

    // Run 1: pin at t0, select, commit.
    const pin1 = pinDigestWindow(db, digest.id, t0);
    assert.equal(pin1, t0);
    assert.equal(pinDigestWindow(db, digest.id, t0 + HOUR), t0, 'a retry reuses the pin');
    const first = digestPosts(db, digest.id, Math.max(digest.last_window_end ?? 0, pin1 - DAY), pin1);
    assert.deepEqual(first.map((post) => post.id), [insideFirst], 'only the selected source, only the last 24 h');
    assert.ok(!first.some((post) => post.id === notSelected), 'a source outside digest_sources never appears');
    commitDigestWindow(db, digest.id);

    // Run 2: the window starts where run 1 ended.
    const t1 = t0 + HOUR;
    const afterCommit = db.prepare('SELECT last_window_end AS w, window_end AS e FROM digests WHERE id = ?').get(digest.id) as { w: number; e: number | null };
    assert.equal(afterCommit.w, t0);
    assert.equal(afterCommit.e, null, 'the pin is released once the digest is sent');
    const late = seed('second-window', t0 + 10 * 60_000);
    const pin2 = pinDigestWindow(db, digest.id, t1);
    const second = digestPosts(db, digest.id, Math.max(afterCommit.w, pin2 - DAY), pin2);
    assert.deepEqual(second.map((post) => post.id), [late], 'a post after t0 belongs to run 2 only');
    assert.ok(!second.some((post) => post.id === insideFirst), 'and run 2 never repeats run 1');
    assert.ok(!second.some((post) => post.id === tooOld), 'nothing older than a day is ever selected');
    commitDigestWindow(db, digest.id);

    // Run 3: a last_window_end older than 24 h is clamped to the 24 h lookback.
    db.prepare('UPDATE digests SET last_window_end = ? WHERE id = ?').run(t0 - 48 * HOUR, digest.id);
    const t2 = t0 + 2 * HOUR;
    const fresh = seed('within-lookback', t2 - 23 * HOUR);
    const pin3 = pinDigestWindow(db, digest.id, t2);
    const third = digestPosts(db, digest.id, Math.max(t0 - 48 * HOUR, pin3 - DAY), pin3);
    assert.ok(third.some((post) => post.id === fresh), 'the 24 h clamp wins over a stale last_window_end');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
