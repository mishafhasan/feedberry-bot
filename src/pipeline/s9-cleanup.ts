import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Db } from '../db/index.ts';

/** Stage 9: every job gets one directory, deleted on success and on every error path (§5.1). */
export function workDirFor(key: string): string {
  return join(tmpdir(), 'feedberry-media', key);
}

export async function cleanupWorkDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

export interface RetentionResult {
  posts: number;
  events: number;
}

/** §13.1 retention: posts live MAX_SOURCE_AGE_DAYS, events 30 days. Runs as a daily job. */
export function runRetention(db: Db, maxAgeDays: number, now = Date.now()): RetentionResult {
  const days = (count: number): number => count * 24 * 60 * 60 * 1000;
  // deliveries cascade from posts, so a pruned post takes its delivery rows with it.
  const posts = Number(db.prepare('DELETE FROM posts WHERE first_seen_at < ?').run(now - days(maxAgeDays)).changes);
  const events = Number(db.prepare('DELETE FROM events WHERE at < ?').run(now - days(30)).changes);
  return { posts, events };
}
