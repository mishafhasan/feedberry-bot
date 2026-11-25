/**
 * Plan §5 test 4: an Atom feed reaches S4 with its title and its date, the same way an RSS feed does.
 * The fixture is the captured GitHub entry, served through a page that advertises it as rel=alternate.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createBot } from '../../src/bot/index.ts';
import { parseConfig } from '../../src/config.ts';
import { openDb } from '../../src/db/index.ts';
import { setUserTimezone } from '../../src/db/repos/users.ts';
import type { Http } from '../../src/platform/http.ts';
import { fakeBotApi, startUpdate, textUpdate } from '../fake-api.ts';
import { allowUser } from '../seed.ts';

const TOKEN = '123456:AAHfakeTokenForTestsOnly_1234567890abc';
const USER_ID = 556;
const RSSHUB_BASE = 'http://rsshub.test';
const atom = readFileSync(new URL('../fixtures/atom-github.xml', import.meta.url), 'utf8');

const PAGE = 'https://blog.example.test';
const FEED = 'https://blog.example.test/feed/atom.xml';

const http: Http = async (url) => {
  if (url === PAGE) {
    return { status: 200, url, contentType: 'text/html', body: '<html><head><link rel="alternate" type="application/atom+xml" href="/feed/atom.xml"></head></html>' };
  }
  if (url === FEED) return { status: 200, url, contentType: 'application/atom+xml', body: atom };
  throw new Error(`unexpected fetch ${url}`);
};

test('M20: an Atom feed reaches S4 with its title and date', async () => {
  const api = await fakeBotApi();
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-atom-'));
  const cfg = parseConfig({ BOT_TOKEN: TOKEN, ADMIN_CHAT_ID: '1', RSSHUB_BASE, CALLBACK_INTERVAL_MS: '0', ADD_INTERVAL_MS: '0' });
  const db = openDb(join(dir, 'bot.db'));
  allowUser(db, USER_ID);
  // The preview dates its items in the reader's zone, not the server's (ADR-036): a UTC leak here
  // would print 22:15 UTC, so the exact string is the assertion.
  setUserTimezone(db, USER_ID, 'Asia/Colombo');

  try {
    const bot = createBot({ cfg, db, apiRoot: api.apiRoot, http });
    await bot.init();
    await bot.handleUpdate(startUpdate(1, USER_ID));
    await bot.handleUpdate(textUpdate(2, USER_ID, PAGE));

    const preview = String(api.last('sendMessage')?.body.text ?? '');
    assert.match(preview, /<b>The GitHub Blog<\/b>/, 'the Atom feed title names the source');
    assert.match(preview, /Beyond code generation/, 'the entry title reaches the preview');
    // 2026-11-06T22:15:59Z is 03:45 on the 7th in Colombo (+5:30).
    assert.match(preview, /• \[Nov 7 03:45 AM\]/, 'and its published date in the reader’s zone, like any dated item');
    assert.match(preview, /Where should posts from this source be delivered\?/, 'S4 asks for a destination');
  } finally {
    db.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
