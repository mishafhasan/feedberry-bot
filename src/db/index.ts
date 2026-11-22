import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type Db = DatabaseSync;

/** Bump when schema.sql changes; the version lives in PRAGMA user_version (ADR-009). */
export const SCHEMA_VERSION = 8;

/** v1 → v2: Download mode stores deliveries with post_id = NULL (ADR-013). */
const MIGRATION_V2 = `
  CREATE TABLE deliveries_v2 (
    id INTEGER PRIMARY KEY,
    post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,
    chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    parts INTEGER,
    message_ids TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    error_code TEXT,
    at INTEGER NOT NULL,
    UNIQUE (post_id, chat_id)
  );
  INSERT INTO deliveries_v2 SELECT * FROM deliveries;
  DROP TABLE deliveries;
  ALTER TABLE deliveries_v2 RENAME TO deliveries;
`;

/**
 * v2 → v3: a closed allowlist. Existing rows become 'pending' on purpose: a v2 bot accepted
 * everyone, so granting them silently would keep the old open model. The admin approves each.
 */
const MIGRATION_V3 = `
  ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'pending';
`;

/**
 * v3 → v4: a subscription chooses what a YouTube channel sends (video, short, post). A NULL keeps
 * every kind, which is what every existing row already receives.
 */
const MIGRATION_V4 = `
  ALTER TABLE subscriptions ADD COLUMN content_types TEXT;
`;

/**
 * v4 → v5: a subscription hears only the posts its keywords name (ADR-020). Both columns are NULL
 * for every existing row, so nobody's feed changes until the user sets a filter.
 */
const MIGRATION_V5 = `
  ALTER TABLE users ADD COLUMN default_keywords TEXT;
  ALTER TABLE subscriptions ADD COLUMN keywords TEXT;
`;

/**
 * v5 → v6: the daily digest (ADR-029). Nothing existing changes: a v5 file simply gains the three
 * tables, and no user has a digest row until they open the screen.
 */
const MIGRATION_V6 = `
  CREATE TABLE IF NOT EXISTS digests (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    chat_id INTEGER NOT NULL UNIQUE REFERENCES chats(id) ON DELETE CASCADE,
    lang TEXT NOT NULL DEFAULT 'en',
    hour INTEGER NOT NULL DEFAULT 8,
    enabled INTEGER NOT NULL DEFAULT 0,
    next_run_at INTEGER,
    window_end INTEGER,
    last_window_end INTEGER
  );
  CREATE TABLE IF NOT EXISTS digest_sources (
    digest_id INTEGER NOT NULL REFERENCES digests(id) ON DELETE CASCADE,
    subscription_id INTEGER NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
    PRIMARY KEY (digest_id, subscription_id)
  );
  CREATE TABLE IF NOT EXISTS post_summaries (
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    lang TEXT NOT NULL,
    json TEXT NOT NULL,
    telegraph_url TEXT,
    at INTEGER NOT NULL,
    PRIMARY KEY (post_id, lang)
  );
  CREATE INDEX IF NOT EXISTS digests_due ON digests (enabled, next_run_at);
`;

/**
 * v6 → v7: the Instant View page a post already got at delivery time, so the digest reuses it instead
 * of asking Telegra.ph (and its flood control) again (ADR-029).
 */
const MIGRATION_V7 = `
  ALTER TABLE posts ADD COLUMN telegraph_url TEXT;
`;

/**
 * v7 → v8: the Gemini quota ledger (ADR-033). Additive only: a v7 file gains one empty table, and no
 * existing row changes.
 */
const MIGRATION_V8 = `
  CREATE TABLE IF NOT EXISTS gemini_quota (
    model         TEXT PRIMARY KEY,
    day           TEXT NOT NULL,
    day_count     INTEGER NOT NULL DEFAULT 0,
    minute        INTEGER NOT NULL,
    minute_count  INTEGER NOT NULL DEFAULT 0,
    blocked_until INTEGER NOT NULL DEFAULT 0
  );
`;

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  const current = schemaVersion(db);
  if (current >= SCHEMA_VERSION) return;

  // One transaction: a crash between two ALTERs would otherwise leave a half-migrated file that
  // every later boot rejects with "duplicate column name".
  tx(db, () => {
    if (current === 0) {
      db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
    } else {
      if (current <= 1) db.exec(MIGRATION_V2);
      if (current <= 2) db.exec(MIGRATION_V3);
      if (current <= 3) db.exec(MIGRATION_V4);
      if (current <= 4) db.exec(MIGRATION_V5);
      if (current <= 5) db.exec(MIGRATION_V6);
      if (current <= 6) db.exec(MIGRATION_V7);
      if (current <= 7) db.exec(MIGRATION_V8);
    }
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  });
}

export function schemaVersion(db: Db): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  return row.user_version;
}

/** Short write transactions only: the worker never holds one across a network await (ADR-009). */
export function tx<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
