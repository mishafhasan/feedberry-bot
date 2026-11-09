import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseConfig } from '../../src/config.ts';
import { redact } from '../../src/obs/log.ts';

const base = { BOT_TOKEN: '123456:fake', ADMIN_CHAT_ID: '42', RSSHUB_BASE: 'http://rsshub:1200/' };

test('parseConfig fails fast without a token', () => {
  assert.throws(() => parseConfig({ ADMIN_CHAT_ID: '1', RSSHUB_BASE: 'http://rsshub' }), /BOT_TOKEN is missing/);
});

test('parseConfig applies the §6 defaults', () => {
  const cfg = parseConfig(base);
  assert.equal(cfg.limits.maxSourcesPerUser, 250);
  assert.equal(cfg.limits.maxChatsPerUser, 20);
  assert.equal(cfg.limits.backfillCount, 5);
  assert.equal(cfg.limits.workerConcurrency, 2);
  assert.equal(cfg.trialEnabled, false, 'OQ-7: no trial line by default');
  assert.equal(cfg.telegramBeta, false, 'OQ-3: Telegram beta off by default');
});

test('parseConfig enables X profile sources only with a Twitter token', () => {
  assert.equal(parseConfig(base).xProfiles, false, 'no token: X profiles stay refused');
  assert.equal(parseConfig(base).twitterAuthToken, undefined);
  const cfg = parseConfig({ ...base, TWITTER_AUTH_TOKEN: ' abc ' });
  assert.equal(cfg.xProfiles, true);
  assert.equal(cfg.twitterAuthToken, 'abc', 'the extractor gets the bare cookie value');
});

test('parseConfig normalizes the RSSHub base and rejects garbage limits', () => {
  assert.equal(parseConfig(base).rsshubBase, 'http://rsshub:1200');
  assert.throws(() => parseConfig({ ...base, MAX_SOURCES_PER_USER: 'many' }), /MAX_SOURCES_PER_USER/);
  assert.throws(() => parseConfig({ ...base, ADMIN_CHAT_ID: '' }), /ADMIN_CHAT_ID is missing/);
});

test('redact strips bot tokens, cookie headers and the RSSHub key', () => {
  const line = JSON.stringify({
    url: 'https://api.telegram.org/bot123456789:AAHfakeTokenForTestsOnly_1234567890abc/getMe',
    header: 'Cookie: sid=abc123',
    upstream: 'http://rsshub:1200/x?access_key=supersecret',
  });
  const out = redact(line);
  assert.doesNotMatch(out, /AAHfakeToken/);
  assert.doesNotMatch(out, /sid=abc123/);
  assert.doesNotMatch(out, /supersecret/);
});
