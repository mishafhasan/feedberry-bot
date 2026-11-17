import type { Db } from '../index.ts';
import type { PostRow } from './posts.ts';
import type { SourceCard } from './subscriptions.ts';

/** ADR-029: one digest per destination chat, its source choices and the per-post summary cache. */
export interface DigestRow {
  id: number;
  user_id: number;
  chat_id: number;
  lang: string;
  /** 0-23, wall clock in the owner's timezone. */
  hour: number;
  enabled: number;
  next_run_at: number | null;
  /** Pinned by a run in progress, so a retry selects the same posts. */
  window_end: number | null;
  /** Where the previous window stopped; the next one starts here. */
  last_window_end: number | null;
}

export interface DueDigestRow {
  id: number;
  hour: number;
  next_run_at: number | null;
  tz: string;
}

/** The row behind one chat's settings screen; created on first open, off until the user turns it on. */
export function ensureDigest(db: Db, userId: number, chatId: number): DigestRow {
  db.prepare('INSERT INTO digests (user_id, chat_id) VALUES (?, ?) ON CONFLICT(chat_id) DO NOTHING').run(userId, chatId);
  return db.prepare('SELECT * FROM digests WHERE chat_id = ?').get(chatId) as unknown as DigestRow;
}

export function getDigest(db: Db, id: number): DigestRow | undefined {
  return db.prepare('SELECT * FROM digests WHERE id = ?').get(id) as unknown as DigestRow | undefined;
}

/** The menu reads the state of the private chat's digest without creating one. */
export function digestForChat(db: Db, userId: number, chatId: number): DigestRow | undefined {
  return db.prepare('SELECT * FROM digests WHERE user_id = ? AND chat_id = ?').get(userId, chatId) as unknown as DigestRow | undefined;
}

/** Every `dg:*` handler authorises by ownership of the digest, never by the callback alone. */
export function ownDigest(db: Db, userId: number, id: number): DigestRow | undefined {
  return db.prepare('SELECT * FROM digests WHERE id = ? AND user_id = ?').get(id, userId) as unknown as DigestRow | undefined;
}

export function setDigestLang(db: Db, id: number, lang: string): void {
  db.prepare('UPDATE digests SET lang = ? WHERE id = ?').run(lang, id);
}

/** The caller owns the slot math: enabling or a new hour takes effect at once. */
export function setDigestHour(db: Db, id: number, hour: number, nextRunAt: number | null): void {
  db.prepare('UPDATE digests SET hour = ?, next_run_at = ? WHERE id = ?').run(hour, nextRunAt, id);
}

export function setDigestEnabled(db: Db, id: number, enabled: boolean, nextRunAt: number | null): void {
  // A toggle is the user intervening: any pin left by a dead or in-flight run stops applying.
  db.prepare('UPDATE digests SET enabled = ?, next_run_at = ?, window_end = NULL WHERE id = ?').run(enabled ? 1 : 0, nextRunAt, id);
}

/** The distinct sources a digest covers; one source followed from two chats still counts once. */
export function digestSourceIds(db: Db, id: number): number[] {
  const rows = db
    .prepare('SELECT DISTINCT sub.source_id FROM digest_sources ds JOIN subscriptions sub ON sub.id = ds.subscription_id WHERE ds.digest_id = ? ORDER BY sub.source_id')
    .all(id) as Array<{ source_id: number }>;
  return rows.map((row) => row.source_id);
}

export function digestSubscriptionIds(db: Db, id: number): number[] {
  const rows = db.prepare('SELECT subscription_id FROM digest_sources WHERE digest_id = ? ORDER BY subscription_id').all(id) as Array<{ subscription_id: number }>;
  return rows.map((row) => row.subscription_id);
}

export function digestSourceCount(db: Db, id: number): number {
  return (db.prepare('SELECT COUNT(DISTINCT sub.source_id) AS n FROM digest_sources ds JOIN subscriptions sub ON sub.id = ds.subscription_id WHERE ds.digest_id = ?').get(id) as { n: number }).n;
}

/**
 * The digest's own RSS subscriptions, one page at a time. `selected` marks the rows the digest covers,
 * so the screen needs no second query per card.
 */
export function digestSourceCards(db: Db, userId: number, digestId: number, limit: number, offset: number): { rows: Array<SourceCard & { selected: number }>; total: number } {
  const total = (db.prepare("SELECT COUNT(*) AS n FROM subscriptions sub JOIN sources s ON s.id = sub.source_id WHERE sub.user_id = ? AND s.platform = 'rss'").get(userId) as { n: number }).n;
  const rows = db
    .prepare(
      `SELECT sub.id AS subscription_id, s.id AS source_id, s.platform, s.canonical_url, s.title, s.avatar_url, s.enabled,
              s.last_check_at, s.last_ok_at, s.last_error_code, s.consecutive_failures, s.interval_minutes, sub.content_types, sub.keywords,
              (SELECT COUNT(*) FROM digest_sources ds WHERE ds.digest_id = ? AND ds.subscription_id = sub.id) AS selected
       FROM subscriptions sub JOIN sources s ON s.id = sub.source_id
       WHERE sub.user_id = ? AND s.platform = 'rss'
       ORDER BY sub.id DESC LIMIT ? OFFSET ?`,
    )
    .all(digestId, userId, limit, offset) as unknown as Array<SourceCard & { selected: number }>;
  return { rows, total };
}

/** The page a subscription sits on, so a toggle repaints the screen the user was reading. */
export function digestSourceIndex(db: Db, userId: number, subscriptionId: number): number | null {
  const rows = db
    .prepare("SELECT sub.id FROM subscriptions sub JOIN sources s ON s.id = sub.source_id WHERE sub.user_id = ? AND s.platform = 'rss' ORDER BY sub.id DESC")
    .all(userId) as Array<{ id: number }>;
  const index = rows.findIndex((row) => row.id === subscriptionId);
  return index < 0 ? null : index;
}

/**
 * Both halves of the security boundary in one place: the digest is the caller's, and the subscription
 * is one of the caller's own RSS rows. `null` means refused, and nothing is written.
 */
export function toggleDigestSource(db: Db, userId: number, digestId: number, subscriptionId: number): 'added' | 'removed' | null {
  if (ownDigest(db, userId, digestId) === undefined) return null;
  const owned = db
    .prepare("SELECT 1 AS ok FROM subscriptions sub JOIN sources s ON s.id = sub.source_id WHERE sub.id = ? AND sub.user_id = ? AND s.platform = 'rss'")
    .get(subscriptionId, userId);
  if (owned === undefined) return null;

  const removed = db.prepare('DELETE FROM digest_sources WHERE digest_id = ? AND subscription_id = ?').run(digestId, subscriptionId);
  if (Number(removed.changes) > 0) return 'removed';
  db.prepare('INSERT INTO digest_sources (digest_id, subscription_id) VALUES (?, ?)').run(digestId, subscriptionId);
  return 'added';
}

/**
 * The window query. Windows tile: `from` is the previous window's end (or 24 h back), `to` is the
 * pinned end, so no post appears twice and none is older than a day (ADR-029).
 */
export function digestPosts(db: Db, digestId: number, from: number, to: number): PostRow[] {
  return db
    .prepare(
      `SELECT p.* FROM posts p
       WHERE p.first_seen_at >= ? AND p.first_seen_at < ?
         AND EXISTS (
           SELECT 1 FROM digest_sources ds JOIN subscriptions sub ON sub.id = ds.subscription_id
           WHERE ds.digest_id = ? AND sub.source_id = p.source_id)
       ORDER BY p.first_seen_at DESC, p.id DESC`,
    )
    .all(from, to, digestId) as unknown as PostRow[];
}

/** Pins the window once per run; a retry reads the pinned value, so it selects the same posts. */
export function pinDigestWindow(db: Db, id: number, at: number): number {
  db.prepare('UPDATE digests SET window_end = ? WHERE id = ? AND window_end IS NULL').run(at, id);
  const row = db.prepare('SELECT window_end FROM digests WHERE id = ?').get(id) as { window_end: number | null } | undefined;
  return row?.window_end ?? at;
}

/**
 * A pin older than a day can only come from a run that died: dropping it makes the next run check its
 * sources again, instead of serving a day-old window with no fresh posts.
 */
export function dropStaleWindow(db: Db, id: number, now: number): void {
  db.prepare('UPDATE digests SET window_end = NULL WHERE id = ? AND window_end IS NOT NULL AND window_end < ?').run(id, now - 24 * 60 * 60 * 1000);
}

/** One statement, after the last part is sent: the next window starts where this one ended. */
export function commitDigestWindow(db: Db, id: number, windowEnd: number): void {
  // The value is passed in, not re-read: a toggle during the run clears the column, and the tile
  // must still end where this run's window ended.
  db.prepare('UPDATE digests SET last_window_end = ?, window_end = NULL WHERE id = ?').run(windowEnd, id);
}

export interface SummaryRow {
  post_id: number;
  lang: string;
  json: string;
  telegraph_url: string | null;
  at: number;
}

export function getSummary(db: Db, postId: number, lang: string): SummaryRow | undefined {
  return db.prepare('SELECT * FROM post_summaries WHERE post_id = ? AND lang = ?').get(postId, lang) as unknown as SummaryRow | undefined;
}

export function putSummary(db: Db, postId: number, lang: string, json: string, telegraphUrl: string | null, now: number): void {
  db.prepare(
    `INSERT INTO post_summaries (post_id, lang, json, telegraph_url, at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(post_id, lang) DO UPDATE SET json = excluded.json, telegraph_url = excluded.telegraph_url, at = excluded.at`,
  ).run(postId, lang, json, telegraphUrl, now);
}

/** The owner's timezone: the digest's slot and its date line are wall clock there (ADR-029). */
export function digestTimezone(db: Db, id: number): string {
  const row = db.prepare('SELECT u.tz AS tz FROM digests d JOIN users u ON u.id = d.user_id WHERE d.id = ?').get(id) as { tz: string } | undefined;
  return row?.tz ?? 'UTC';
}

/** Enabled digests whose slot has arrived; the tick advances each slot before enqueueing (§4.2). */
export function dueDigests(db: Db, now: number): DueDigestRow[] {
  return db
    .prepare(
      `SELECT d.id, d.hour, d.next_run_at, u.tz FROM digests d JOIN users u ON u.id = d.user_id
       WHERE d.enabled = 1 AND (d.next_run_at IS NULL OR d.next_run_at <= ?)
       ORDER BY d.id`,
    )
    .all(now) as unknown as DueDigestRow[];
}

export function advanceDigest(db: Db, id: number, at: number): void {
  db.prepare('UPDATE digests SET next_run_at = ? WHERE id = ?').run(at, id);
}
