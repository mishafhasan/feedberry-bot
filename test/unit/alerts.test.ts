import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDb } from '../../src/db/index.ts';
import { upsertSource } from '../../src/db/repos/sources.ts';
import { alerts } from '../../src/obs/alerts.ts';

const notifier = () => {
  const sent: string[] = [];
  return { sent, notify: async (text: string) => void sent.push(text) };
};

test('silent alert fires once per 24 h, not every slot (NULL source_id dedupe)', async () => {
  const db = openDb(':memory:');
  try {
    upsertSource(db, {
      platform: 'rss',
      canonicalUrl: 'https://blog.example.test',
      externalId: 'blog',
      feedUrl: null,
      strategy: 'native_rss',
      title: 'Blog',
      avatarUrl: null,
    });
    const sink = notifier();
    const now = Date.now();

    assert.equal(await alerts.silent(db, sink, now), true);
    assert.equal(await alerts.silent(db, sink, now + 30_000), false, 'the next slot is deduped');
    assert.equal(sink.sent.length, 1);
  } finally {
    db.close();
  }
});

test('queue backlog alert dedupes the same way', async () => {
  const db = openDb(':memory:');
  try {
    const now = Date.now();
    const insert = db.prepare("INSERT INTO jobs (kind, target_id, priority, run_after, state) VALUES ('fetch_source', ?, 1, ?, 'queued')");
    for (let id = 1; id <= 101; id++) insert.run(id, now);
    const sink = notifier();

    assert.equal(await alerts.queueBacklog(db, sink, now), true);
    assert.equal(await alerts.queueBacklog(db, sink, now + 30_000), false);
    assert.equal(sink.sent.length, 1);
  } finally {
    db.close();
  }
});
