/**
 * M21: a pasted feed URL is a source, not a post. Dailymirror serves its section feeds under
 * `/rss/<section>/<id>`, so the feed marker is in the middle of the path, not at the end.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createBot } from '../../src/bot/index.ts';
import { parseConfig } from '../../src/config.ts';
import { openDb } from '../../src/db/index.ts';
import type { Http } from '../../src/platform/http.ts';
import { fakeBotApi, startUpdate, textUpdate } from '../fake-api.ts';
import { allowUser } from '../seed.ts';

const TOKEN = '123456:AAHfakeTokenForTestsOnly_1234567890abc';
const USER_ID = 557;
const RSSHUB_BASE = 'http://rsshub.test';
const FEED_URL = 'https://blog.example.test/rss/breaking_news/108';

const feedXml = `<?xml version="1.0"?><rss version="2.0"><channel><title>Breaking News</title>
  <item><title>Rain in Colombo</title><link>https://blog.example.test/a</link><guid>a</guid><pubDate>Sat, 07 Nov 2026 13:00:00 +0000</pubDate></item>
</channel></rss>`;

/** Only the URL itself answers: no page fetch, no guessing. Anything else is a bug. */
const http: Http = async (url) => {
  if (url === FEED_URL) return { status: 200, url, contentType: 'application/rss+xml', body: feedXml };
  throw new Error(`unexpected fetch ${url}`);
};

test('M21: a feed URL under /rss/ goes straight to the preview', async () => {
  const api = await fakeBotApi();
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-feed-url-'));
  const cfg = parseConfig({ BOT_TOKEN: TOKEN, ADMIN_CHAT_ID: '1', RSSHUB_BASE, CALLBACK_INTERVAL_MS: '0', ADD_INTERVAL_MS: '0' });
  const db = openDb(join(dir, 'bot.db'));
  allowUser(db, USER_ID);

  try {
    const bot = createBot({ cfg, db, apiRoot: api.apiRoot, http });
    await bot.init();
    await bot.handleUpdate(startUpdate(1, USER_ID));
    await bot.handleUpdate(textUpdate(2, USER_ID, FEED_URL));

    const preview = String(api.last('sendMessage')?.body.text ?? '');
    assert.doesNotMatch(preview, /This is a post link/, 'a feed URL is not offered as a download');
    assert.match(preview, /<b>Breaking News<\/b>/, 'the feed is read from the URL that was pasted');
    assert.match(preview, /Rain in Colombo/, 'and its items are previewed');
    assert.match(preview, /Where should posts from this source be delivered\?/, 'S4 asks for a destination');
  } finally {
    db.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
