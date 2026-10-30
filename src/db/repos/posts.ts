import type { Db } from '../index.ts';
import type { FeedItem } from '../../platform/feed/native.ts';

export interface PostRow {
  id: number;
  source_id: number;
  guid: string;
  url: string | null;
  published_at: number | null;
  kind: string | null;
  payload_json: string | null;
  first_seen_at: number;
}

/**
 * §5.4: a post is "seen" the moment it is recorded, not when it is delivered. Re-inserting a
 * known guid is a no-op, so a repeated fetch cannot duplicate a post.
 */
export function insertPosts(db: Db, sourceId: number, items: FeedItem[], now = Date.now()): PostRow[] {
  const insert = db.prepare(
    `INSERT INTO posts (source_id, guid, url, published_at, payload_json, first_seen_at)
     VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(source_id, guid) DO NOTHING`,
  );
  const read = db.prepare('SELECT * FROM posts WHERE source_id = ? AND guid = ?');

  const rows: PostRow[] = [];
  for (const item of items) {
    insert.run(sourceId, item.guid, item.link, item.publishedAt, JSON.stringify({ title: item.title, summary: item.summary, media: item.media }), now);
    rows.push(read.get(sourceId, item.guid) as unknown as PostRow);
  }
  return rows;
}

export function postByGuid(db: Db, sourceId: number, guid: string): PostRow | undefined {
  return db.prepare('SELECT * FROM posts WHERE source_id = ? AND guid = ?').get(sourceId, guid) as unknown as PostRow | undefined;
}

export function getPost(db: Db, id: number): PostRow | undefined {
  return db.prepare('SELECT * FROM posts WHERE id = ?').get(id) as unknown as PostRow | undefined;
}

/** Stage 4's input: the guids already recorded for a source. */
export function listGuids(db: Db, sourceId: number): string[] {
  const rows = db.prepare('SELECT guid FROM posts WHERE source_id = ?').all(sourceId) as Array<{ guid: string }>;
  return rows.map((row) => row.guid);
}
