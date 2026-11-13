import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { extractArticle, fixImageUrls } from '../../src/article/readability.ts';
import { publishArticle, telegraphNodes, type TelegraphPage } from '../../src/article/telegraph.ts';
import type { Http } from '../../src/platform/http.ts';

const fixture = (name: string): string => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');

const PAGES: Record<string, string> = {
  'https://blog.example.test/wired': fixture('wired.html'),
  'https://blog.example.test/long': fixture('long-70kb.html'),
  'https://blog.example.test/thin': fixture('thin.html'),
  'https://blog.example.test/bbc': fixture('bbc.html'),
  'https://blog.example.test/medium': fixture('medium.html'),
  'https://blog.example.test/lead-image': fixture('lead-image.html'),
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

test('ADR-027 article: a body Readability left pictureless keeps the page\'s own lead image', async () => {
  const article = await extractArticle(http, 'https://blog.example.test/lead-image');
  const imgs = article.html.match(/<img\b[^>]*>/gi) ?? [];

  assert.equal(imgs.length, 1, 'the lead picture is carried, once');
  assert.match(article.html, /^<figure><img src="https:\/\/ichef\.bbci\.co\.uk\/ace\/branded_news\/1200\/[^"]+"\/><\/figure>/, 'it leads the article, as a figure Instant View accepts');
  assert.ok(article.textLength > 400, 'the words are unchanged');
});

test('M7 article: a picture whose real file lives in srcset keeps the image, never the placeholder', async () => {
  const article = await extractArticle(http, 'https://blog.example.test/bbc');
  const imgs = article.html.match(/<img\b[^>]*>/gi) ?? [];

  assert.equal(imgs.length, 1, 'the grey placeholder is dropped, the real picture is kept');
  assert.match(imgs[0] ?? '', /src="https:\/\/ichef\.bbci\.co\.uk\/news\/1536\/[^"]+"/, 'the widest srcset candidate becomes the source');
  assert.doesNotMatch(article.html, /placeholder|srcset/i, 'no placeholder URL and no srcset survive');
  assert.doesNotMatch(article.html, /<img(?![^>]*\bsrc=)[^>]*>/i, 'no image without a source: Instant View would draw a white box');
});

test('M7 article: an unsanitized srcset with no spaces still yields the widest file', () => {
  const html = fixImageUrls('<img srcset="https://a.test/240/x.png 240w,https://a.test/1536/x.png 1536w">', 'https://blog.example.test/bbc');
  assert.match(html, /src="https:\/\/a\.test\/1536\/x\.png"/, 'a missing space after the comma is not a missing candidate');
});

test('M7 article: image fixing prefers a usable candidate and drops the broken ones', () => {
  const fixed = (html: string): string => fixImageUrls(html, 'https://blog.example.test/bbc');

  assert.match(fixed('<img srcset="https://a.test/spacer.gif 2400w, https://a.test/real.jpg 800w">'), /src="https:\/\/a\.test\/real\.jpg"/, 'a spacer in the largest slot does not delete the picture');
  assert.equal(fixed('<img src="#">'), '', 'a source that resolves to the page itself is not an image');
  assert.equal(fixed('<img src="https://a.test/2026/blank.png">'), '<img src="https://a.test/2026/blank.png">', '“blank” in a filename is an ordinary word');
});

test('M7 article: Telegraph nodes only carry href and src', async () => {
  const article = await extractArticle(http, 'https://blog.example.test/wired');
  const nodes = telegraphNodes(article.html);
  assert.ok(nodes.length > 5);
  const json = JSON.stringify(nodes);
  assert.match(json, /"tag":"p"/);
  assert.doesNotMatch(json, /"class"|"style"/);
});

test('M23 article: a Medium picture keeps the file that lives only on its <source>', async () => {
  const article = await extractArticle(http, 'https://blog.example.test/medium');
  const imgs = article.html.match(/<img\b[^>]*>/gi) ?? [];

  assert.equal(imgs.length, 2, 'Readability drops the srcless <img>, so the cover and the lazy picture survive');
  assert.match(imgs[0] ?? '', /src="https:\/\/miro\.medium\.com\/v2\/resize:fit:1400\/format:webp\/1\*cover\.png"/, 'the widest <source> candidate becomes the source');
  assert.match(article.html, /src="https:\/\/miro\.medium\.com\/v2\/lazy\.png"/, 'a lazy image keeps its data-src file');
  assert.doesNotMatch(article.html, /<source|srcset|data-src/i, 'no wrapper or lazy attribute reaches Instant View');
});

test('M23 article: a CSS background becomes a picture Instant View can fetch', () => {
  const fixed = fixImageUrls('<div style="background-image:url(/hero.png)"><p>A caption</p></div>', 'https://blog.example.test/story');

  assert.match(fixed, /<img src="https:\/\/blog\.example\.test\/hero\.png">/);
  assert.doesNotMatch(fixImageUrls('<div style="background:grey"></div>', 'https://blog.example.test/story'), /<img/);
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
