import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TelegraphPage } from '../../src/article/telegraph.ts';
import type { PostRow } from '../../src/db/repos/posts.ts';
import { pageOfPost, withReadMore, type ReadMoreCtx } from '../../src/pipeline/read-more.ts';
import { renderPost } from '../../src/pipeline/render-post.ts';
import { cutCaption } from '../../src/render/caption.ts';
import type { MediaFile, MessagePlan } from '../../src/render/message-plan.ts';

const BIG = 'https://video.twimg.com/amplify_video/2120186300917542912/vid/avc1/848x464/M_Hex2T7T_vKTl70.mp4?tag=29';
const LINK = `🎬 <a href="${BIG}">Video 1</a>`;

const photo = { path: 'work/media-photo', kind: 'photo' as const, size: 1024 };
const LONG = 'word '.repeat(600).trim();

const post = (summary: string, media: Array<{ url: string; type: string }> = []): PostRow => ({
  id: 7,
  source_id: 1,
  guid: 'g',
  url: 'https://blog.example.test/post',
  published_at: null,
  kind: 'photo',
  payload_json: JSON.stringify({ title: 'A post', summary, media }),
  first_seen_at: 0,
});

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

const ctx = (telegraph?: ReadMoreCtx['telegraph']): ReadMoreCtx => ({ telegraph, sourceTitle: 'My Blog' });
const captionOf = (plan: MessagePlan): string => ('caption' in plan ? plan.caption : '');

test('Read more: a caption that already fits is returned untouched and publishes nothing', async () => {
  const row = post('A short body.');
  const plan = renderPost(row, 'photo', [photo], { platform: 'rss', sourceTitle: 'My Blog' });
  const { client, pages } = recorder();

  const out = await withReadMore(plan, pageOfPost(row), ctx(client), new Map());

  assert.equal(out, plan, 'the same plan object comes back');
  assert.equal(pages.length, 0, 'no page is published for a caption under the cap');
});

test('Read more: an over-long caption keeps the media, ends in an Instant View link and stays inside 1024', async () => {
  const row = post(`${LONG}\n\nThe end.`, [
    { url: 'https://cdn.test/a.jpg', type: 'photo' },
    { url: 'https://cdn.test/clip.mp4', type: 'video' },
    { url: 'not a url', type: 'photo' },
  ]);
  const plan = renderPost(row, 'photo', [photo], { platform: 'rss', sourceTitle: 'My Blog' });
  const { client, pages } = recorder();

  const out = await withReadMore(plan, pageOfPost(row), ctx(client), new Map());
  const caption = captionOf(out);

  assert.ok(caption.length <= 1024, `caption is ${caption.length} characters`);
  assert.match(caption, /^🌐 <a href="https:\/\/blog\.example\.test\/post">My Blog<\/a> \| RSS/, 'the header and its platform survive the cut');
  assert.ok(caption.includes('...\n\n'), 'the cut text ends in three dots, then a blank line');
  assert.match(caption, /<a href="https:\/\/telegra\.ph\/page-1">👉🏻 Read more<\/a>$/, 'the phrase itself is the link');
  assert.doesNotMatch(caption, /\(1\//, 'nothing is split into numbered parts anymore');

  assert.equal(pages.length, 1);
  // publishArticle stores the Telegraph node array as JSON.
  assert.match(pages[0]?.content ?? '', /"children":\["word word /, 'the page carries the whole text');
  assert.match(pages[0]?.content ?? '', /"children":\["The end\."\]/, 'a blank line in the caption is a paragraph on the page');
  assert.match(pages[0]?.content ?? '', /cdn\.test\/a\.jpg/, 'and the post photo');
  assert.doesNotMatch(pages[0]?.content ?? '', /clip\.mp4|not a url/, 'video and junk URLs stay out');
});

test('Read more: a Telegraph failure leaves today’s plan alone', async () => {
  const row = post(LONG);
  const plan = renderPost(row, 'photo', [photo], { platform: 'rss', sourceTitle: 'My Blog' });
  const broken = {
    async createPage(): Promise<string> {
      throw new Error('E_TELEGRAPH');
    },
  };

  assert.equal(await withReadMore(plan, pageOfPost(row), ctx(broken), new Map()), plan);
  assert.equal(await withReadMore(plan, pageOfPost(row), ctx(), new Map()), plan, 'no client, no change');
});

test('Read more: one post publishes one page, failures included', async () => {
  const row = post(LONG);
  const plan = renderPost(row, 'photo', [photo], { platform: 'rss', sourceTitle: 'My Blog' });
  const pages = new Map<number, string | null>();
  const { client, pages: recorded } = recorder();

  await withReadMore(plan, pageOfPost(row), ctx(client), pages);
  await withReadMore(plan, pageOfPost(row), ctx(client), pages);
  assert.equal(recorded.length, 1, 'the second chat reuses the first page');

  let attempts = 0;
  const broken = {
    async createPage(): Promise<string> {
      attempts++;
      throw new Error('E_TELEGRAPH');
    },
  };
  const failed = new Map<number, string | null>();
  await withReadMore(plan, pageOfPost(row), ctx(broken), failed);
  await withReadMore(plan, pageOfPost(row), ctx(broken), failed);
  assert.equal(attempts, 1, 'a failed publish is not retried per chat');
});

test('Read more: a cut inside a link still closes the tag', () => {
  const caption = `🌐 <a href="https://instagram.com/p/C1">${'word '.repeat(200)}</a>`;
  const cut = cutCaption(caption, 300);

  assert.ok(cut.endsWith('</a>'), 'the anchor is closed before the ellipsis');
  assert.ok(cut.length <= 300, `the closed tag is paid for: cut lands at ${cut.length}`);
});

test('Read more: the 🎬 links outlive the cut that drops the rest of the tail', async () => {
  const row = post(LONG);
  const files: MediaFile[] = [
    { path: 'a.jpg', kind: 'photo', size: 1024 },
    { path: 'b.jpg', kind: 'photo', size: 1024 },
    { path: 'v.mp4', kind: 'video', size: 51 * 1024 * 1024, url: BIG },
  ];
  const plan = renderPost(row, 'album', files, { platform: 'rss', sourceTitle: 'My Blog' });
  const { client, pages } = recorder();

  const out = await withReadMore(plan, pageOfPost(row), ctx(client), new Map());
  const caption = captionOf(out);

  assert.ok(caption.length <= 1024, `caption is ${caption.length} characters`);
  assert.ok(caption.includes(LINK), 'the only way to reach the clip survives the cut');
  assert.match(caption, /🎬 <a href="https:\/\/video\.twimg\.com\S+">Video 1<\/a>\n\n<a href="https:\/\/telegra\.ph\/page-1">👉🏻 Read more<\/a>$/);
  assert.equal(pages.length, 1);
});

test('Read more: a flattened numbered list becomes one Instant View paragraph per item', async () => {
  const items = Array.from({ length: 30 }, (_, i) => `${i + 1}. http://site-${i + 1}.test — thing number ${i + 1}`);
  const flat = `50 websites that feel like the internet’s hidden toolbox ${items.join(' ')}`;
  // The Telegraph page is the RSS/blog path now (ADR-023); the list rule still applies there.
  const row = post(flat);
  const plan = renderPost(row, 'photo', [photo], { platform: 'rss', sourceTitle: 'My Blog' });
  const { client, pages } = recorder();

  const out = await withReadMore(plan, pageOfPost(row), ctx(client), new Map());

  assert.ok('caption' in out && out.caption.includes('Read more'), 'the caption trades its tail for the page');
  assert.equal(pages.length, 1);
  assert.match(pages[0]?.content ?? '', /"children":\["1\. http:\/\/site-1\.test/, 'item 1 is its own paragraph');
  assert.match(pages[0]?.content ?? '', /"children":\["2\. http:\/\/site-2\.test/, 'and so does item 2');
});

test('Read more: a rich post never enters the Telegraph path (ADR-023)', async () => {
  const row = post(LONG);
  const plan = renderPost(row, 'photo', [photo], { platform: 'instagram', sourceTitle: 'Evolving AI' });
  const { client, pages } = recorder();

  const out = await withReadMore(plan, pageOfPost(row), ctx(client), new Map());

  assert.equal(out, plan, 'the rich plan comes back untouched');
  assert.ok(plan.kind === 'rich' || plan.kind === 'rich_more', 'never a caption plan');
  assert.equal(pages.length, 0, 'no Instant View page for a rich post');
});

test('Read more: an album keeps its items and gets the same caption tail', async () => {
  const row = post(LONG);
  const plan = renderPost(row, 'album', [photo, photo], { platform: 'rss', sourceTitle: 'My Blog' });
  const { client, pages } = recorder();

  const out = await withReadMore(plan, pageOfPost(row), ctx(client), new Map());

  assert.equal(out.kind, 'album');
  assert.equal(out.kind === 'album' ? out.items.length : 0, 2, 'both photos still ship');
  assert.match(captionOf(out), /👉🏻 Read more<\/a>$/);
  assert.equal(pages.length, 1);
});
