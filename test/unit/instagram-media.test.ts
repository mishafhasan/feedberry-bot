/**
 * Instagram answers a post only to a signed-in session, and only on its web API. These cases pin the
 * rung that reaches it, the predicate that used to end the chain early, and the two surfaces that must
 * not be asked when a session exists. Nothing here touches the network.
 *
 * The no-cookie case is declared first: the cookie pool is process-wide, so a later case would leak into it.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setCookies } from '../../cobalt-engine/src/cookie-store.js';
import instagram from '../../cobalt-engine/src/platforms/instagram.js';

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const html = (body: string) => new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });

const ID = 'Df4_7w4gBZC';
const MEDIA_ID = '4033254650177132098_58712495227';
const PHOTO = 'https://scontent.cdninstagram.com/photo.jpg';
const COVER = 'https://scontent.cdninstagram.com/cover.jpg';
const SMALL = 'https://scontent.cdninstagram.com/small.mp4';
const BIG = 'https://scontent.cdninstagram.com/big.mp4';

/** What the embed and the page answer now: no payload, no markers, no session. */
const DEAD_EMBED = '"init",[],[{"contextJSON":null}]],';
const DEAD_PAGE = '<html><head></head><body>Instagram</body></html>';

interface Call {
  url: string;
  cookie: string;
}

/** One stubbed Instagram, recording every request the handler makes. */
function stub(routes: { web?: () => Response }): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const cookie = (init?.headers as Record<string, unknown> | undefined)?.cookie;
    calls.push({ url, cookie: cookie === undefined ? '' : String(cookie) });

    if (url.includes('/api/v1/oembed/')) return json({ media_id: MEDIA_ID });
    if (url.includes('i.instagram.com/api/v1/media/')) return json({ message: 'login_required', status: 'fail' });
    if (url.includes('www.instagram.com/api/v1/media/')) return routes.web?.() ?? new Response('', { status: 429 });
    if (url.includes('/embed/captioned/')) return html(DEAD_EMBED);
    if (url.includes('/graphql/query')) return json({});
    if (url.includes('/ajax/bulk-route-definitions/')) return html('{}');
    if (url.includes('www.instagram.com/p/')) return html(DEAD_PAGE);
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  return calls;
}

const resolves = async (routes: { web?: () => Response } = {}) => {
  const calls = stub(routes);
  const result = await instagram({ postId: ID }) as { urls?: string; cover?: string; isPhoto?: boolean; error?: string };
  return { result, calls };
};

const webCalls = (calls: Call[]): Call[] => calls.filter((call) => call.url.includes('www.instagram.com/api/v1/media/'));

test('the gql envelope no longer ends the chain: the error context is asked instead', async () => {
  const { result, calls } = await resolves();

  assert.equal(result.error, 'fetch.empty');
  assert.ok(calls.some((call) => call.url.includes('/ajax/bulk-route-definitions/')), 'a `{ gql_data: undefined }` answer must not count as data');
  assert.deepEqual(webCalls(calls), [], 'the web API answers 429 without a session, so it is never asked');
});

test('a session reaches the web API in two requests and returns the photo', async () => {
  setCookies({ instagram: ['sessionid=abc; ds_user_id=1'] });
  const { result, calls } = await resolves({ web: () => json({ status: 'ok', items: [{ image_versions2: { candidates: [{ url: PHOTO }] } }] }) });

  assert.equal(result.isPhoto, true);
  assert.equal(result.urls, PHOTO);
  assert.equal(calls.length, 2, 'oembed names the id, the web API names the media');
  assert.deepEqual(calls.map((call) => call.url.split('?')[0]), [
    `https://i.instagram.com/api/v1/oembed/`,
    `https://www.instagram.com/api/v1/media/${MEDIA_ID}/info/`,
  ]);
  assert.match(webCalls(calls)[0]?.cookie ?? '', /sessionid=abc/, 'the session travels with the winning request');
});

test('a reel states its video and the frame it shows instead', async () => {
  setCookies({ instagram: ['sessionid=abc; ds_user_id=1'] });
  const { result } = await resolves({
    web: () => json({
      status: 'ok',
      items: [{
        image_versions2: { candidates: [{ url: COVER }] },
        video_versions: [{ url: SMALL, width: 640, height: 360 }, { url: BIG, width: 1080, height: 1920 }],
      }],
    }),
  });

  assert.equal(result.urls, BIG, 'the largest rendition plays');
  assert.equal(result.cover, COVER, 'a clip past the ceiling shows the post\'s own frame (ADR-027)');
});

test('a challenged session is a credential problem, not a wall, and costs no further request', async () => {
  setCookies({ instagram: ['sessionid=stale; ds_user_id=1'] });
  const { result, calls } = await resolves({ web: () => json({ message: 'challenge_required', status: 'fail' }) });

  assert.equal(result.error, 'content.post.private');
  assert.equal(calls.length, 2, 'the dead surfaces were never asked');
});
