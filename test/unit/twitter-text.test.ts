import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tweetText } from '../../cobalt-engine/src/platforms/twitter.js';

/** The GraphQL envelope the extractor navigates; only the fields `tweetText` reads. */
const graphql = (result: unknown) => ({
  data: {
    threaded_conversation_with_injections_v2: {
      instructions: [
        { type: 'TimelineClearCache' },
        {
          type: 'TimelineAddEntries',
          entries: [
            { entryId: 'cursor-top', content: { itemContent: { tweet_results: { result: { __typename: 'Tweet', legacy: { full_text: 'Other entry' } } } } } },
            { entryId: 'tweet-42', content: { itemContent: { tweet_results: { result } } } },
          ],
        },
      ],
    },
  },
});

test('tweet text: legacy.full_text answers when there is no long-form note', () => {
  const thread = graphql({ __typename: 'Tweet', legacy: { full_text: 'Hello from the post &amp; more' } });
  assert.equal(tweetText(thread, '42'), 'Hello from the post & more');
});

test('tweet text: a long-form note overrides the 280-character cut', () => {
  const thread = graphql({
    __typename: 'Tweet',
    legacy: { full_text: 'Short preview…' },
    note_tweet: { note_tweet_results: { result: { text: 'The whole long post, in full.' } } },
  });
  assert.equal(tweetText(thread, '42'), 'The whole long post, in full.');
});

test('tweet text: a visibility wrapper is unwrapped', () => {
  const thread = graphql({ __typename: 'TweetWithVisibilityResults', tweet: { legacy: { full_text: 'Wrapped text' } } });
  assert.equal(tweetText(thread, '42'), 'Wrapped text');
});

test('tweet text: the entry named tweet-<id> is read, not the first one', () => {
  const entry = (entryId: string, text: string) => ({
    entryId,
    content: { itemContent: { tweet_results: { result: { __typename: 'Tweet', legacy: { full_text: text } } } } },
  });
  const thread = {
    data: {
      threaded_conversation_with_injections_v2: {
        instructions: [{ type: 'TimelineAddEntries', entries: [entry('cursor-top', 'Other entry'), entry('tweet-42', 'Focal text')] }],
      },
    },
  };
  assert.equal(tweetText(thread, '42'), 'Focal text');
});

test('tweet text: a trailing t.co link is dropped, a link-only post keeps it', () => {
  const withText = graphql({ __typename: 'Tweet', legacy: { full_text: 'Hello there https://t.co/abc123' } });
  assert.equal(tweetText(withText, '42'), 'Hello there');

  const only = graphql({ __typename: 'Tweet', legacy: { full_text: 'https://t.co/abc123' } });
  assert.equal(tweetText(only, '42'), 'https://t.co/abc123', 'the post would be empty otherwise');
});

test('tweet text: a thread without the tweet yields an empty string', () => {
  assert.equal(tweetText({ data: {} }, '42'), '');
  assert.equal(tweetText(undefined, '42'), '');
});
