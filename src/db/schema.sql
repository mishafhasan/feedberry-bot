-- FeedBerry schema, version 1 (ARCHITECTURE §6). No credential table: ADR-017.
-- Timestamps are epoch milliseconds. Schema version lives in PRAGMA user_version.

CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY,
  tg_user_id  INTEGER NOT NULL UNIQUE,
  tz          TEXT NOT NULL DEFAULT 'UTC',
  locale      TEXT,
  created_at  INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',  -- pending|allowed|blocked; only 'allowed' opens the bot
  default_keywords TEXT                           -- ADR-020: comma list for every source without its own
);

CREATE TABLE IF NOT EXISTS chats (
  id                INTEGER PRIMARY KEY,
  owner_user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tg_chat_id        INTEGER NOT NULL,
  type              TEXT NOT NULL,               -- private|group|supergroup|channel
  title             TEXT,
  message_thread_id INTEGER,                     -- forum topic target
  can_post          INTEGER NOT NULL DEFAULT 0,
  verified_at       INTEGER,
  rights_json       TEXT,
  UNIQUE (tg_chat_id, message_thread_id)
);

-- SQLite treats NULLs as distinct in a UNIQUE constraint, so the row-per-topic promise
-- needs an expression index; without it a private chat could be stored many times.
CREATE UNIQUE INDEX IF NOT EXISTS chats_target ON chats (tg_chat_id, COALESCE(message_thread_id, 0));

CREATE TABLE IF NOT EXISTS sources (
  id                   INTEGER PRIMARY KEY,
  platform             TEXT NOT NULL,
  canonical_url        TEXT NOT NULL UNIQUE,
  external_id          TEXT,
  feed_url             TEXT,
  strategy             TEXT NOT NULL,
  interval_minutes     INTEGER,
  title                TEXT,
  avatar_url           TEXT,
  enabled              INTEGER NOT NULL DEFAULT 1,
  last_check_at        INTEGER,
  last_ok_at           INTEGER,
  last_error_code      TEXT,
  last_error_at        INTEGER,
  consecutive_failures INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id           INTEGER PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_id    INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  chat_id      INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  deliver      INTEGER NOT NULL DEFAULT 1,
  next_slot_at INTEGER,
  created_at   INTEGER NOT NULL,
  -- video,short,post for a YouTube channel; NULL means every kind (rows from before the picker).
  content_types TEXT,
  -- ADR-020: comma-separated keywords/tags; NULL falls back to users.default_keywords.
  keywords TEXT,
  UNIQUE (source_id, chat_id)
);

CREATE TABLE IF NOT EXISTS posts (
  id            INTEGER PRIMARY KEY,
  source_id     INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  guid          TEXT NOT NULL,
  url           TEXT,
  published_at  INTEGER,
  kind          TEXT,
  payload_json  TEXT,
  first_seen_at INTEGER NOT NULL,
  UNIQUE (source_id, guid)
);

CREATE TABLE IF NOT EXISTS deliveries (
  id         INTEGER PRIMARY KEY,
  -- NULL for Download mode (ADR-013): a single post link has no `posts` row.
  post_id    INTEGER REFERENCES posts(id) ON DELETE CASCADE,
  chat_id    INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  status     TEXT NOT NULL,                      -- pending|sent|failed|skipped
  parts      INTEGER,
  message_ids TEXT,
  attempts   INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  at         INTEGER NOT NULL,
  UNIQUE (post_id, chat_id)
);

CREATE TABLE IF NOT EXISTS jobs (
  id         INTEGER PRIMARY KEY,
  kind       TEXT NOT NULL,                      -- fetch_source|deliver_post|manual_check|cleanup
  target_id  INTEGER NOT NULL,
  priority   INTEGER NOT NULL,
  run_after  INTEGER NOT NULL,
  state      TEXT NOT NULL,                      -- queued|running|done|failed
  attempts   INTEGER NOT NULL DEFAULT 0,
  locked_at  INTEGER,
  last_error TEXT
);

-- One active job per target; done/failed rows accumulate freely.
CREATE UNIQUE INDEX IF NOT EXISTS jobs_one_active ON jobs (kind, target_id)
  WHERE state IN ('queued', 'running');

CREATE INDEX IF NOT EXISTS jobs_runnable ON jobs (state, run_after);
CREATE INDEX IF NOT EXISTS subscriptions_due ON subscriptions (next_slot_at);
CREATE INDEX IF NOT EXISTS posts_source ON posts (source_id, published_at);

CREATE TABLE IF NOT EXISTS events (
  id        INTEGER PRIMARY KEY,
  at        INTEGER NOT NULL,
  level     TEXT NOT NULL,
  code      TEXT NOT NULL,
  source_id INTEGER,
  chat_id   INTEGER,
  detail    TEXT
);

CREATE INDEX IF NOT EXISTS events_at ON events (at);
