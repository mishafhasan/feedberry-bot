import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type Db = DatabaseSync;

/** Bump when schema.sql changes; the version lives in PRAGMA user_version (ADR-009). */
export const SCHEMA_VERSION = 1;

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
  if (schemaVersion(db) >= SCHEMA_VERSION) return;
  db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

export function schemaVersion(db: Db): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  return row.user_version;
}
