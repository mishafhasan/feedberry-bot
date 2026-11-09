import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setCookies } from '../../cobalt-engine/src/cookie-store.js';
import twitter from '../../cobalt-engine/src/platforms/twitter.js';

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

/** The GraphQL envelope the extractor navigates, one focal entry. */
const thread = (result: unknown) => ({
  data: {
    threaded_conversation_with_injections_v2: {
      instructions: [
        { type: 'TimelineAddEntries', entries: [{ entryId: 'tweet-42', content: { itemContent: { tweet_results: { result } } } }] },
      ],
    },
  },
});

const tombstone = { __typename: 'TweetTombstone', result: { reason: 'NsfwLoggedOut' } };
const photo = { __typename: 'Tweet', legacy: { extended_entities: { media: [{ type: 'photo', media_url_https: 'https://pbs.twimg.com/media/x.jpg' }] } } };

const cookieNames = (init: RequestInit | undefined): string => {
  const cookie = (init?.headers as Record<string, unknown> | undefined)?.cookie;
  if (typeof cookie === 'string') return cookie.split('; ').map((part) => part.split('=')[0]).join(',');
  return cookie && typeof cookie === 'object' && 'values' in cookie
    ? Object.keys((cookie as { values(): object }).values()).join(',')
    : '';
};

test('a login-gated post is retried signed in, once, and that retry carries the session cookie', async (t) => {
  setCookies({ twitter: ['auth_token=abc'] });

  const realFetch = globalThis.fetch;
  const detailCookieNames: string[] = [];
  let authed = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('/guest/activate.json')) return json({ guest_token: 'guest' });

    const names = cookieNames(init);
    detailCookieNames.push(names);
    // A request without the session gets the wall; X keeps walling once even when signed in.
    if (!names.includes('auth_token')) return json(thread(tombstone));

    authed += 1;
    return json(thread(authed === 1 ? tombstone : photo));
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });

  const media = await twitter({ id: '42', index: -1 });
  assert.equal(media.isPhoto, true, 'the signed-in retry returns the media instead of content.post.age');
  assert.equal(authed, 2, 'the wall is retried exactly once');
  assert.match(detailCookieNames.at(-1) ?? '', /auth_token/, 'the retried request is the authenticated one');
});
