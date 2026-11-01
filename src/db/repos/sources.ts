import type { Db } from '../index.ts';

export interface SourceRow {
  id: number;
  platform: string;
  canonical_url: string;
  external_id: string | null;
  feed_url: string | null;
  strategy: string;
  interval_minutes: number | null;
  title: string | null;
  avatar_url: string | null;
  enabled: number;
  last_check_at: number | null;
  last_ok_at: number | null;
  last_error_code: string | null;
  last_error_at: number | null;
  consecutive_failures: number;
}

export interface SourceInput {
  platform: string;
  canonicalUrl: string;
  externalId: string;
  feedUrl: string | null;
  strategy: string;
  title: string | null;
  avatarUrl: string | null;
  intervalMinutes?: number | null;
}

/** `canonical_url` is unique: adding the same profile twice reuses the row. */
export function upsertSource(db: Db, input: SourceInput): SourceRow {
  return db
    .prepare(
      `INSERT INTO sources (platform, canonical_url, external_id, feed_url, strategy, interval_minutes, title, avatar_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(canonical_url) DO UPDATE SET
         external_id = excluded.external_id,
         feed_url = excluded.feed_url,
         strategy = excluded.strategy,
         title = COALESCE(excluded.title, sources.title),
         avatar_url = COALESCE(excluded.avatar_url, sources.avatar_url)
       RETURNING *`,
    )
    .get(
      input.platform,
      input.canonicalUrl,
      input.externalId,
      input.feedUrl,
      input.strategy,
      input.intervalMinutes ?? null,
      input.title,
      input.avatarUrl,
    ) as unknown as SourceRow;
}

export function findSourceByUrl(db: Db, canonicalUrl: string): SourceRow | undefined {
  return db.prepare('SELECT * FROM sources WHERE canonical_url = ?').get(canonicalUrl) as unknown as SourceRow | undefined;
}

export function getSource(db: Db, id: number): SourceRow | undefined {
  return db.prepare('SELECT * FROM sources WHERE id = ?').get(id) as unknown as SourceRow | undefined;
}

/** S8: on/off only touches `sources.enabled`; nothing is deleted. */
export function setSourceEnabled(db: Db, id: number, enabled: boolean): void {
  db.prepare('UPDATE sources SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
}

/** S16: `null` restores the 08:00/20:00 default; the scheduler reads this on every slot. */
export function setSourceInterval(db: Db, id: number, minutes: number | null): void {
  db.prepare('UPDATE sources SET interval_minutes = ? WHERE id = ?').run(minutes, id);
}

/** A source survives while anyone else is subscribed to it (§7.2 delete rules). */
export function deleteSourceIfOrphan(db: Db, id: number): boolean {
  const orphans = db.prepare('DELETE FROM sources WHERE id = ? AND NOT EXISTS (SELECT 1 FROM subscriptions WHERE source_id = ?)').run(id, id);
  return Number(orphans.changes) > 0;
}
