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

test('planArticle caches nothing when the page is too thin to publish', async () => {
  const saved: string[] = [];
  const plan = await planArticle(
    { http: httpWith(article('Stub', 2)), telegraph: { createPage: async () => 'https://telegra.ph/x' }, onPage: (url) => saved.push(url) },
    { url: 'https://blog.test/stub', title: 'Stub', publishedAt: null, sourceTitle: 'Blog', platform: 'rss' },
  );
  assert.equal(plan?.kind, 'link_only');
  assert.deepEqual(saved, []);
});
