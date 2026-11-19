/**
 * The X handler's live path is the syndication payload (the GraphQL route 404s for every id).
 * These cases pin what it must read out of that payload: the quoted post's media, the clip's own
 * poster, and a rendition ranked by its shorter side. Nothing here touches the network.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import twitter from '../../cobalt-engine/src/platforms/twitter.js';

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
/** The GraphQL route is stale: a 404 with no body, which the handler swallows before syndication. */
const gone = () => new Response('', { status: 404 });

const PHOTO = 'https://pbs.twimg.com/media/HXbahyLXQAAcSVO.jpg';
const THUMB = 'https://pbs.twimg.com/amplify_video_thumb/2123086034342924289/img/ptuQHGf-5f3f77gI.jpg';

const clip = (variants: string[]) => ({
  type: 'video',
  media_url_https: THUMB,
  // A bigger rendition is a higher bitrate, as X states it; the fixture lists them smallest first.
  video_info: { variants: variants.map((url, index) => ({ content_type: 'video/mp4', url, bitrate: 1000 + index })) },
});

/** One syndication answer, with GraphQL dead first as it is in production. */
function syndicate(payload: unknown): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('/guest/activate.json')) return json({ guest_token: 'guest' });
    if (url.includes('api.x.com/graphql')) return gone();
    if (url.includes('cdn.syndication.twimg.com')) return json(payload);
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
}

/** The handler's argument list: the vendor module declares every key required. */
const call = (id: string, quality?: string) => twitter({ id, index: -1, toGif: false, dispatcher: undefined, alwaysProxy: false, subtitleLang: undefined, quality });

const answer = (payload: unknown, quality?: string, id = '42') => {
  syndicate(payload);
  return call(id, quality) as Promise<{
    urls?: string;
    cover?: string;
    picker?: Array<{ type: string; url: string; thumb?: string }>;
    filename?: string;
    error?: string;
  }>;
};

const PORTRAIT = [
  'https://video.twimg.com/amplify_video/1/vid/avc1/320x568/a.mp4',
  'https://video.twimg.com/amplify_video/1/vid/avc1/480x852/b.mp4',
  'https://video.twimg.com/amplify_video/1/vid/avc1/720x1280/c.mp4',
  'https://video.twimg.com/amplify_video/1/vid/avc1/1080x1920/d.mp4',
];

test('syndication: a clip that lives only in the quoted post is extracted, with its own poster', async () => {
  const media = await answer({ text: 'look at this', quoted_tweet: { mediaDetails: [clip(['https://video.twimg.com/amplify_video/1/vid/avc1/1776x1080/a.mp4'])] } });

  assert.equal(media.error, undefined);
  assert.match(media.urls ?? '', /1776x1080/, 'the quoted clip is the media');
  assert.equal(media.filename, 'twitter_42.mp4');
  assert.equal(media.cover, THUMB, 'a clip past the ceiling shows the post\'s own picture (ADR-027)');
});

test('syndication: a focal photo keeps the quoted clip beside it', async () => {
  const media = await answer({
    mediaDetails: [{ type: 'photo', media_url_https: PHOTO }],
    quoted_tweet: { mediaDetails: [clip(['https://video.twimg.com/amplify_video/1/vid/avc1/480x270/a.mp4'])] },
  });

  assert.equal(media.picker?.length, 2, 'the post shows both');
  assert.deepEqual(media.picker?.map((item) => item.type), ['photo', 'video'], 'the focal media comes first');
  assert.ok(media.picker?.every((item) => typeof item.thumb === 'string'), 'every item carries its poster');
});

test('syndication: a post with no media anywhere is an empty answer, never a throw', async () => {
  const media = await answer({ text: 'just words' });

  assert.equal(media.error, 'fetch.empty');
});

test('renditions: a 9:16 clip answers the 1080 rung with 1080x1920', async () => {
  const media = await answer({ quoted_tweet: { mediaDetails: [clip(PORTRAIT)] } }, '1080');

  assert.match(media.urls ?? '', /1080x1920/, 'the shorter side is the quality class');
});

test('renditions: the 720 rung of a 9:16 clip answers 720x1280', async () => {
  const media = await answer({ quoted_tweet: { mediaDetails: [clip(PORTRAIT)] } }, '720');

  assert.match(media.urls ?? '', /720x1280/);
  assert.doesNotMatch(media.urls ?? '', /320x568/);
});

test('renditions: a landscape clip is unchanged by the shorter-side rule', async () => {
  const media = await answer({ mediaDetails: [clip(['https://video.twimg.com/amplify_video/1/vid/avc1/444x270/a.mp4', 'https://video.twimg.com/amplify_video/1/vid/avc1/1184x720/b.mp4', 'https://video.twimg.com/amplify_video/1/vid/avc1/1776x1080/c.mp4'])] }, '720');

  assert.match(media.urls ?? '', /1184x720/);
});

/** The GraphQL envelope the authenticated route answers with, one focal entry. */
const thread = (result: unknown) => ({
  data: {
    threaded_conversation_with_injections_v2: {
      instructions: [{ type: 'TimelineAddEntries', entries: [{ entryId: 'tweet-42', content: { itemContent: { tweet_results: { result } } } }] }],
    },
  },
});

test('graphql: a signed-in read keeps the quoted clip beside the focal photo', async () => {
  const quoted = { __typename: 'Tweet', legacy: { extended_entities: { media: [clip(['https://video.twimg.com/amplify_video/1/vid/avc1/480x270/a.mp4'])] } } };
  const tweet = {
    __typename: 'Tweet',
    legacy: { extended_entities: { media: [{ type: 'photo', media_url_https: PHOTO }] } },
    quoted_status_result: { result: quoted },
  };
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('/guest/activate.json')) return json({ guest_token: 'guest' });
    if (url.includes('api.x.com/graphql')) return json(thread(tweet));
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;

  const media = await call('42') as { picker?: Array<{ type: string }> };

  assert.deepEqual(media.picker?.map((item) => item.type), ['photo', 'video'], 'a signed-in request reaches the graphql route, so it must read the quote too');
});

test('a merged item with no playable variant is dropped, not fatal', async () => {
  const media = await answer({
    mediaDetails: [
      { type: 'photo', media_url_https: PHOTO },
      { type: 'video', media_url_https: THUMB },
    ],
  });

  assert.equal(media.picker?.length, 1, 'the photo survives, the unusable item is gone');
  assert.equal(media.picker?.[0]?.type, 'photo');
});
