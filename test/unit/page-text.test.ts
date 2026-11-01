import assert from 'node:assert/strict';
import { test } from 'node:test';
import { metaDescription } from '../../src/platform/page-text.ts';

test('page text: og:description wins over the Twitter card and the plain description', () => {
  const html = `
    <meta name="description" content="plain">
    <meta name="twitter:description" content="card">
    <meta property="og:description" content="The post&#39;s own words">
  `;
  assert.equal(metaDescription(html), "The post's own words");
});

test('page text: attribute order does not matter', () => {
  assert.equal(metaDescription('<meta content="Hello world" property="og:description"/>'), 'Hello world');
  assert.equal(metaDescription("<meta content='Hola mundo' name='twitter:description'>"), 'Hola mundo');
});

test('page text: the Twitter card answers when og is missing', () => {
  assert.equal(metaDescription('<meta name="twitter:description" content="Short post text">'), 'Short post text');
});

test('page text: a bare link and a platform banner are not the post', () => {
  assert.equal(metaDescription('<meta property="og:description" content="https://x.com/a/status/1">'), null);
  assert.equal(metaDescription('<meta property="og:description" content="The latest tweets from @a">'), null);
});

test('page text: a page without meta tags yields null', () => {
  assert.equal(metaDescription('<html><body><p>text</p></body></html>'), null);
});
