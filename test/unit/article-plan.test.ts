/**
 * ADR-029: delivery's Instant View page is cached on the post (`posts.telegraph_url`) so the digest
 * reuses it instead of asking Telegra.ph — and its flood control — a second time.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planArticle } from '../../src/pipeline/article-plan.ts';
import type { Http } from '../../src/platform/http.ts';

const article = (title: string, words: number): string => `<html><head><title>${title}</title></head><body><article><h1>${title}</h1><p>${'word '.repeat(words)}</p></article></body></html>`;
const httpWith = (body: string): Http => async (url) => ({ status: 200, url, contentType: 'text/html', body });

test('planArticle hands the published page to the caller for caching', async () => {
  const saved: string[] = [];
  const plan = await planArticle(
    { http: httpWith(article('Offline story', 120)), telegraph: { createPage: async () => 'https://telegra.ph/Offline-story' }, onPage: (url) => saved.push(url) },
    { url: 'https://blog.test/offline', title: 'Offline story', publishedAt: null, sourceTitle: 'Blog', platform: 'rss' },
  );
  assert.ok(plan);
  assert.deepEqual(saved, ['https://telegra.ph/Offline-story']);
});

test('planArticle dates the article in the reader’s zone, 12-hour', async () => {
  // The header string is built inside planArticle, so this is where a caller's zone can be dropped.
  const plan = await planArticle(
    { http: httpWith(article('Zoned story', 120)), telegraph: { createPage: async () => 'https://telegra.ph/Zoned-story' } },
    { url: 'https://blog.test/zoned', title: 'Zoned story', publishedAt: Date.UTC(2026, 10, 24, 9, 0), sourceTitle: 'Blog', platform: 'rss', tz: 'Asia/Colombo' },
  );

  assert.ok(plan && plan.kind === 'text', 'an article delivers as its text plan');
  assert.match(plan.kind === 'text' ? plan.text : '', /⏱️ Time: Nov 24 02:30 PM/, '09:00Z reads 02:30 PM in Colombo');
});

test('planArticle caches nothing when the page is too thin to publish', async () => {
  const saved: string[] = [];
  const plan = await planArticle(
    { http: httpWith(article('Stub', 2)), telegraph: { createPage: async () => 'https://telegra.ph/x' }, onPage: (url) => saved.push(url) },
    { url: 'https://blog.test/stub', title: 'Stub', publishedAt: null, sourceTitle: 'Blog', platform: 'rss' },
  );
  assert.equal(plan?.kind, 'link_only');
  assert.deepEqual(saved, []);
});

test('planArticle reads the Instant View copy first and never republishes it', async () => {
  const seen: string[] = [];
  let published = 0;
  const http: Http = async (url) => {
    seen.push(url);
    return { status: 200, url, contentType: 'text/html', body: article('IV copy', 120) };
  };
  const plan = await planArticle(
    { http, telegraph: { createPage: async () => (published++, 'https://telegra.ph/new') } },
    { url: 'https://blog.test/post', title: 'Post', publishedAt: null, sourceTitle: 'Blog', platform: 'rss', telegraphUrl: 'https://telegra.ph/Post' },
  );
  assert.ok(plan);
  assert.deepEqual(seen, ['https://telegra.ph/Post'], 'the static copy is the only page fetched');
  assert.equal(published, 0, 'a cached page is reused, not written again');
});

test('planArticle falls back to the post when its Instant View page is dead', async () => {
  const seen: string[] = [];
  const http: Http = async (url) => {
    seen.push(url);
    if (url.startsWith('https://telegra.ph/')) throw new Error('404');
    return { status: 200, url, contentType: 'text/html', body: article('Post page', 120) };
  };
  const plan = await planArticle(
    { http, telegraph: { createPage: async () => 'https://telegra.ph/fresh' } },
    { url: 'https://blog.test/post', title: 'Post', publishedAt: null, sourceTitle: 'Blog', platform: 'rss', telegraphUrl: 'https://telegra.ph/Dead' },
  );
  assert.ok(plan);
  assert.deepEqual(seen, ['https://telegra.ph/Dead', 'https://blog.test/post'], 'the post is the fallback source');
});
