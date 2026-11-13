import assert from 'node:assert/strict';
import { test } from 'node:test';
import { metaDescription, metaImageOf, metaVideoOf, profileNameOf, publishedAtOf } from '../../src/platform/page-text.ts';

test('page text: the poster is the page card image, and only an http(s) address is one', () => {
  assert.equal(metaImageOf('<meta property="og:image" content="https://pbs.twimg.com/poster.jpg">'), 'https://pbs.twimg.com/poster.jpg');
  assert.equal(metaImageOf('<meta property="og:image:secure_url" content="https://i.ytimg.com/vi/x/maxresdefault.jpg">'), 'https://i.ytimg.com/vi/x/maxresdefault.jpg');
  assert.equal(metaImageOf('<meta name="twitter:image" content="https://scontent.cdninstagram.com/p.jpg">'), 'https://scontent.cdninstagram.com/p.jpg');
  assert.equal(metaImageOf('<meta property="og:image" content="data:image/png;base64,AAAA">'), null, 'a data URI is not a poster');
  assert.equal(metaImageOf('<meta property="og:image" content="/relative.jpg">'), null, 'a relative address cannot be fetched by us');
  assert.equal(metaImageOf('<html></html>'), null);
});

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

test('page text: the card video is read for the platforms cobalt cannot reach', () => {
  const html = '<meta property="og:video" content="https://cdn.example.test/clip.mp4?token=1">';
  assert.match(metaVideoOf(html) ?? '', /clip\.mp4/);
  assert.equal(metaVideoOf('<html></html>'), null);
});

test('page text: the og:title names the account in every shape the platforms use', () => {
  const title = (value: string): string => `<meta property="og:title" content="${value}">`;
  // Shapes captured from the live pages of the test link list.
  assert.equal(profileNameOf(title('The World Of Funny (@TheWorldOfFunny) on X')), 'The World Of Funny');
  assert.equal(profileNameOf(title('PROMPT HUB (@prompt.__hub) on Threads')), 'PROMPT HUB');
  assert.equal(profileNameOf(title('Humor Satire Memes (@funnysnarkyjoke.bsky.social)')), 'Humor Satire Memes');
  assert.equal(profileNameOf(title('RITESH GANESH KAMBLE on Instagram: "I phone"')), 'RITESH GANESH KAMBLE');
  assert.equal(profileNameOf(title('22 likes | #meme | Funny Vidz (@klipz96) | Posted Aug 23')), 'Funny Vidz');
});

test('page text: a title that is the post itself names nobody', () => {
  assert.equal(profileNameOf('<meta property="og:title" content="They Call Him King - King Theme (From &quot;King&quot;)">'), null);
  assert.equal(profileNameOf('<meta property="og:title" content="Post by @attonitos-gloria · 2 images">'), null);
  assert.equal(profileNameOf('<html></html>'), null);
});

test('page text: the publish date comes from meta or JSON-LD, never invented', () => {
  assert.equal(publishedAtOf('<meta property="article:published_time" content="2026-05-18T14:48:08.000Z">'), Date.parse('2026-05-18T14:48:08.000Z'));
  assert.equal(publishedAtOf('<meta property="og:updated_time" content="2025-10-29T05:10:23.000Z">'), Date.parse('2025-10-29T05:10:23.000Z'));
  assert.equal(publishedAtOf('<script>{"datePublished":"2026-08-08T20:12:00.680Z"}</script>'), Date.parse('2026-08-08T20:12:00.680Z'));
  assert.equal(publishedAtOf('<script>{"uploadDate":"2025-11-13T04:31:16-08:00"}</script>'), Date.parse('2025-11-13T04:31:16-08:00'));
  // A player state dates the post in epoch seconds; the pipeline works in milliseconds.
  assert.equal(publishedAtOf('<script>{"createTime":"1790802020"}</script>'), 1_790_802_020_000);
  assert.equal(publishedAtOf('<script>{"createTime":1790802020}</script>'), 1_790_802_020_000);
  assert.equal(publishedAtOf('<meta property="article:published_time" content="not a date">'), null);
  assert.equal(publishedAtOf('<html></html>'), null);
});
