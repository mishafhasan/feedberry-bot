import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PostRow } from '../../src/db/repos/posts.ts';
import { parseFeed } from '../../src/platform/feed/native.ts';
import { renderPost } from '../../src/pipeline/s6-render.ts';

const FULL =
  '💻🤖 OpenAI CEO Sam Altman is facing backlash after calling it “terrible” for people to have RAM in their own computers when it could be used in AI data centers instead.\n\nWhat are your thoughts on this? 🤔💬';

const post = (title: string, summary: string): PostRow => ({
  id: 1,
  source_id: 1,
  guid: 'guid',
  url: 'https://www.instagram.com/p/DfJ2075AGx3/',
  published_at: 1_761_835_200_000,
  kind: 'photo',
  payload_json: JSON.stringify({ title, summary, media: [] }),
  first_seen_at: 0,
});

const photo = { path: 'work/media-photo', kind: 'photo' as const, size: 1024 };
const captionOf = (title: string, summary: string): string => {
  const plan = renderPost(post(title, summary), 'photo', [photo], { sourceTitle: 'Evolving AI (@evolving.ai) - Instagram' });
  return plan.kind === 'photo' ? plan.caption : '';
};

test('delivery: a truncated feed title is not printed on top of the full body', () => {
  const truncated = FULL.slice(0, 150) + '…';
  const caption = captionOf(truncated, FULL);

  assert.equal(caption.match(/OpenAI CEO Sam Altman/g)?.length, 1, 'the paragraph appears once');
  assert.ok(caption.endsWith('What are your thoughts on this? 🤔💬'), 'the whole post is still there');
});

test('delivery: an identical title and body collapse to one', () => {
  const caption = captionOf(FULL, FULL);

  assert.equal(caption.match(/OpenAI CEO Sam Altman/g)?.length, 1);
});

test('delivery: a distinct title still shows above the body', () => {
  const caption = captionOf('Altman on RAM', FULL);
  const titleAt = caption.indexOf('Altman on RAM');
  const bodyAt = caption.indexOf('💻🤖 OpenAI CEO');

  assert.ok(titleAt > 0 && bodyAt > titleAt, 'the title sits above the body');
});

test('delivery: a title sitting inside a reblog chain is not printed above it', () => {
  // Tumblr's RSS: the title is the post's own line, the body carries it below the reblogs.
  const title = 'Honestly you should be pretty worried about my coming thousand year reign of darkness.';
  const body = `ironwoman359 :\n\nstjohnstarling :\n\n${title}\n\n@pangur-and-grim this is what Merulo did at the start of ASCNTD, yes?`;
  const caption = captionOf(title, body);

  assert.equal(caption.match(/coming thousand year reign/g)?.length, 1, 'the line appears once');
  assert.ok(caption.includes('ironwoman359'), 'the reblog chain is kept');
});

test('delivery: a title cut with an HTML entity is still the body\'s opening', () => {
  // A double-encoded Tumblr feed ships `&hellip;` where the cut is.
  const caption = captionOf('I went birding today and saw the rarest bird species in&hellip;', 'katelouisepowell :\n\nI went birding today and saw the rarest bird species in the whole world.');

  assert.equal(caption.match(/rarest bird species in/g)?.length, 1, 'the sentence appears once');
  assert.doesNotMatch(caption, /hellip/, 'the entity does not reach the caption');
});

test('delivery: a parsed multi-paragraph post is printed once, with its paragraphs', () => {
  const rss =
    '<rss version="2.0"><channel><title>t</title><item><guid>g2</guid><link>https://www.instagram.com/p/DfJ2075AGx3/</link>' +
    '<title>Altman on RAM. Then the podcast.</title>' +
    '<description><![CDATA[<p>Altman on RAM.</p><p>Then the podcast.</p>]]></description></item></channel></rss>';
  const item = parseFeed(rss, 'https://www.instagram.com/evolving.ai/').items[0];
  assert.ok(item);

  // Same shape stage 2 stores: a flat title, a body that keeps its paragraph breaks.
  const row: PostRow = {
    ...post('', ''),
    url: item.link,
    payload_json: JSON.stringify({ title: item.title, summary: item.summary, media: item.media }),
  };
  const plan = renderPost(row, 'photo', [photo], { sourceTitle: 'Evolving AI' });
  const caption = plan.kind === 'photo' ? plan.caption : '';

  assert.equal(caption.match(/Altman on RAM/g)?.length, 1, 'the title is a copy of the body');
  assert.ok(caption.includes(['Altman on RAM.', 'Then the podcast.'].join('\u000A\u000A')), 'paragraphs survive');
});
