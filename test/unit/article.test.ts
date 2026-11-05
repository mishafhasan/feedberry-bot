import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { extractArticle } from '../../src/article/readability.ts';
import { publishArticle, telegraphNodes, type TelegraphPage } from '../../src/article/telegraph.ts';
import type { Http } from '../../src/platform/http.ts';

const fixture = (name: string): string => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');

const PAGES: Record<string, string> = {
  'https://blog.example.test/wired': fixture('wired.html'),
  'https://blog.example.test/long': fixture('long-70kb.html'),
  'https://blog.example.test/thin': fixture('thin.html'),
};

const http: Http = async (url) => {
  const body = PAGES[url];
  if (body === undefined) throw new Error(`unexpected fetch ${url}`);
  return { status: 200, url, contentType: 'text/html', body };
};

function recorder(): { client: { createPage(page: TelegraphPage): Promise<string> }; pages: TelegraphPage[] } {
  const pages: TelegraphPage[] = [];
  return {
    pages,
    client: {
      async createPage(page) {
        pages.push(page);
        return `https://telegra.ph/page-${pages.length}`;
      },
    },
  };
}

test('M7 article: Readability keeps the body, the site name and only http(s) images survive', async () => {
  const article = await extractArticle(http, 'https://blog.example.test/wired');
  assert.equal(article.title, 'The quiet return of the personal website');
  assert.equal(article.siteName, 'WIRED', 'the page names its own site, so a header need not fall back to the host');
  assert.ok(article.textLength > 400, `readable text is ${article.textLength}`);
  assert.match(article.html, /src="https:\/\/blog\.example\.test\/images\/hero\.jpg"/, 'relative image resolved');
  assert.doesNotMatch(article.html, /sprite/, 'style/sprite paths are dropped');
});

test('M7 article: a thin page is detected, not published', async () => {
  const thin = await extractArticle(http, 'https://blog.example.test/thin');
  assert.ok(thin.textLength < 400, `thin page has ${thin.textLength} chars`);
});

test('M7 article: Telegraph nodes only carry href and src', async () => {
  const article = await extractArticle(http, 'https://blog.example.test/wired');
  const nodes = telegraphNodes(article.html);
  assert.ok(nodes.length > 5);
  const json = JSON.stringify(nodes);
  assert.match(json, /"tag":"p"/);
  assert.doesNotMatch(json, /"class"|"style"/);
});

test('M7 article: a page over 64 KB is chained with "Read Next page"', async () => {
  const article = await extractArticle(http, 'https://blog.example.test/long');
  const { client, pages } = recorder();
  const url = await publishArticle(client, article);

  assert.equal(pages.length, 2, 'the long article needs two pages');
  assert.equal(url, 'https://telegra.ph/page-2', 'the first page is published last');
  assert.match(pages[1]?.content ?? '', /Read Next page/, 'page one links to page two');
  assert.ok((pages[0]?.content.length ?? 0) <= 70_000, 'each page stays inside the cap');
});
