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

test('parseConfig hands the Instagram session to the extractor, trimmed, without making X addable', () => {
  const cfg = parseConfig({ ...base, INSTAGRAM_COOKIE: ' sessionid=a; ds_user_id=1 ' });
  assert.equal(cfg.instagramCookie, 'sessionid=a; ds_user_id=1');
  assert.equal(cfg.xProfiles, false, 'an Instagram session says nothing about X profile sources');
  assert.equal(parseConfig(base).instagramCookie, undefined, 'absent: the extractor runs without a session');
});

test('parseConfig gives each digest role a model ladder', () => {
  const cfg = parseConfig({ ...base, GEMINI_API_KEY: 'k' });
  assert.ok(cfg.digest);
  assert.equal(cfg.digest?.textModel, 'gemini-3.8-flash');
  assert.equal(cfg.digest?.ttsModel, 'gemini-3.8-flash-tts');
  assert.deepEqual(cfg.digest?.textFallbacks, ['gemini-3.6-flash', 'gemini-4-hydrogen', 'gemini-3-flash-preview', 'gemini-3.1-pro-preview', 'gemini-3.5-flash-lite']);
  assert.deepEqual(cfg.digest?.ttsFallbacks, ['gemini-3.8-flash-lite-tts', 'gemini-3.1-flash-tts-preview', 'gemini-2.5-flash-preview-tts']);
  assert.equal(cfg.digest?.maxPosts, 20, 'the digest summarises at most 20 posts');
  assert.equal(parseConfig({ ...base, GEMINI_API_KEY: 'k', DIGEST_MAX_POSTS: '2' }).digest?.maxPosts, 2, 'a local run caps the summaries at two');

  const custom = parseConfig({ ...base, GEMINI_API_KEY: 'k', GEMINI_TEXT_FALLBACKS: ' a , b ,', GEMINI_TTS_FALLBACKS: 'c' });
  assert.deepEqual(custom.digest?.textFallbacks, ['a', 'b'], 'a comma list is trimmed');
  assert.deepEqual(custom.digest?.ttsFallbacks, ['c'], 'the env list replaces the default tail');
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
