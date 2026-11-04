/**
 * The thread parser against real captures of Threads permalinks. No network.
 * Counts and text lengths are the ones the recon asserted; the ordering is `reply_level`, never time.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { parseThreadDocument } from '../../src/platform/feed/threads.ts';

const evidence = (name: string): string => readFileSync(fileURLToPath(new URL(`../fixtures/threads/${name}`, import.meta.url)), 'utf8');

test('threads: T1 root carries the sub-post, in reply_level order, with the sub-post text', () => {
  const doc = parseThreadDocument(evidence('06-t1-root-ssr-run1.html'), 'DcsVM6HlDOv');
  assert.ok(doc, 'the post is in the document');
  assert.equal(doc.author, 'prompt.__hub');
  // A header prints the name the account uses, not its handle.
  assert.equal(doc.name, 'PROMPT HUB');
  assert.deepEqual(doc.posts.map((post) => post.code), ['DcsVM6HlDOv', 'DcsVM13FDS9'], 'root first, then its sub-post');
  assert.equal(doc.posts[0]?.text.length, 455, 'root text comes from text_fragments');
  // The sub-post has a null caption: its words live under snippet_attachment_info only.
  assert.equal(doc.posts[1]?.text.length, 3779);
  assert.match(doc.posts[1]?.text ?? '', /^Photorealistic|^.{0,40}$/);
  assert.equal(doc.posts[0]?.media.length, 1, 'one photo');
  assert.equal(doc.posts[0]?.media[0]?.type, 'photo');
  assert.equal(doc.posts[1]?.media.length, 0, 'the sub-post is text only');
  assert.equal(doc.posts[0]?.publishedAt, 1788153935 * 1000, 'taken_at is seconds, the pipeline is ms');
  // The root is one second LATER than its sub-post: sorting by time would invert the thread.
  assert.ok((doc.posts[0]?.publishedAt ?? 0) > (doc.posts[1]?.publishedAt ?? 0));
});

test('threads: every sampled thread is found whole', () => {
  const cases: Array<[string, string, number]> = [
    ['12-t2-text-only-ssr.html', 'DeE3qSZGgU3', 3],
    ['13-t3-media-ssr.html', 'DeC5Ie7Ec4X', 3],
    ['27-t4-long-ssr.html', 'Dd86aU5Ea2-', 4],
  ];
  for (const [file, code, count] of cases) {
    const doc = parseThreadDocument(evidence(file), code);
    assert.ok(doc, `${file} parses`);
    assert.equal(doc.posts.length, count, `${file} carries ${count} posts`);
    assert.equal(doc.posts[0]?.code, code, `${file} starts at the root`);
    assert.ok(doc.posts.every((post) => post.text !== ''), `${file} keeps every post's words`);
  }
});

test('threads: opening a sub-post link still yields the root first', () => {
  const doc = parseThreadDocument(evidence('20-t1-subpost-ssr.html'), 'DcsVM13FDS9');
  assert.ok(doc);
  assert.deepEqual(doc.posts.map((post) => post.code), ['DcsVM6HlDOv', 'DcsVM13FDS9']);
  assert.equal(doc.author, 'prompt.__hub');
});

test('threads: the app shell is a null document, never an empty thread', () => {
  assert.equal(parseThreadDocument(evidence('01-root-post-html.html'), 'DcsVM6HlDOv'), null);
  assert.equal(parseThreadDocument('<html><body>nope</body></html>', 'DcsVM6HlDOv'), null);
});

test('threads: a carousel post keeps every item, videos included', () => {
  const html = `<script type="application/json" data-sjs>${JSON.stringify({
    data: {
      media: {
        pk: '1',
        code: 'ABC',
        taken_at: 1_700_000_000,
        user: { username: 'someone' },
        text_post_app_info: { text_fragments: { fragments: [{ plaintext: 'hello' }] }, reply_level: 0 },
        carousel_media: [
          { image_versions2: { candidates: [{ url: 'https://cdn.test/1.jpg' }] } },
          { video_versions: [{ url: 'https://cdn.test/2.mp4' }] },
        ],
      },
    },
  })}</script>`;
  const doc = parseThreadDocument(html, 'ABC');
  assert.ok(doc);
  assert.deepEqual(doc.posts[0]?.media, [
    { url: 'https://cdn.test/1.jpg', type: 'photo' },
    { url: 'https://cdn.test/2.mp4', type: 'video' },
  ]);
});

test('threads: a malformed edge list degrades, it does not throw', () => {
  const html = `<script type="application/json" data-sjs>${JSON.stringify({
    data: {
      media: {
        pk: '1',
        code: 'ABC',
        taken_at: 1_700_000_000,
        user: { username: 'someone' },
        text_post_app_info: { text_fragments: { fragments: [null, { plaintext: 'kept' }] }, reply_level: 0, self_thread: { posts: { edges: [null, 7, { node: null }] } } },
        caption: { text: 42 },
      },
    },
  })}</script>`;
  const doc = parseThreadDocument(html, 'ABC');
  assert.ok(doc, 'the post itself still parses');
  assert.deepEqual(doc.posts.map((post) => post.text), ['kept']);
});

test('threads: another account\'s thread embedded in the page is not merged in', () => {
  const post = (pk: string, code: string, user: string, level: number) => ({
    pk,
    code,
    taken_at: 1_700_000_000 + level,
    user: { username: user },
    text_post_app_info: { reply_level: level, text_fragments: { fragments: [{ plaintext: `${user} ${level}` }] } },
  });
  const mine = post('1', 'MINE1', 'author', 0);
  const mySub = post('2', 'MINE2', 'author', 1);
  const alien = post('3', 'ALIEN1', 'someone-else', 0);
  const alienSub = post('4', 'ALIEN2', 'someone-else', 1);
  const html = `<script type="application/json" data-sjs>${JSON.stringify({
    page: {
      media: { ...mine, text_post_app_info: { ...mine.text_post_app_info, self_thread: { posts: { edges: [{ node: mySub }] } } } },
      related: { ...alien, text_post_app_info: { ...alien.text_post_app_info, self_thread: { posts: { edges: [{ node: alienSub }] } } } },
    },
  })}</script>`;
  const doc = parseThreadDocument(html, 'MINE1');
  assert.ok(doc);
  assert.deepEqual(doc.posts.map((post) => post.code), ['MINE1', 'MINE2'], 'only the requested author\'s chain');
});
