import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseFacebookPost, postResult } from '../../cobalt-engine/src/platforms/facebook.js';

const PFBID = 'pfbid0Kjy9DPFqearmV5mnfBU5gcsBnsckCeZ34w9DQKFP67ShWcFW131SwvzwPQzpWBcql';
const POST_ID = '1668138432022246';
const CANONICAL = `https://www.facebook.com/Thinakaran.lk/posts/pfbid02P7LzTXiSx6VbqpqsjuadBNg9gvNAYcfQ28YfpTEk5hgE7wtYbt7NdnfJy2yDa96nl`;

/** A permalink document: `og:url` names the post, each `data-sjs` blob is one JSON node. */
const page = (postId: string | null, ...blobs: unknown[]): string =>
  `<html><head>${postId === null ? '' : `<meta property="og:url" content="https://www.facebook.com/Thinakaran.lk/posts/slug/${postId}/"/>`}</head>` +
  `<body>${blobs.map((blob) => `<script type="application/json" data-sjs>${JSON.stringify(blob)}</script>`).join('')}</body></html>`;

const photo = (uri: string) => ({ __typename: 'Photo', __isMedia: 'Photo', image: { uri }, viewer_image: { uri } });

/** One copy of a story node: the same post arrives split across several, and only one has each field. */
const storyCopy = (overrides: Record<string, unknown> = {}) => ({
  __typename: 'Story',
  post_id: POST_ID,
  permalink_url: CANONICAL,
  message: null,
  actors: [{ __typename: 'User', name: 'Thinakaran', profile_picture: { uri: 'https://scontent.xx.fbcdn.net/avatar.jpg' } }],
  attachments: [],
  ...overrides,
});

const album = (...urls: string[]) => [{
  media: { __typename: 'Photo', __isNode: 'Photo', id: '1' },
  styles: {
    attachment: {
      all_subattachments: { nodes: urls.map((uri) => ({ media: photo(uri) })) },
      // A link preview's picture is not a post photo.
      story_attachment_link_renderer: { attachment: { web_link: { image: { uri: 'https://example.test/preview.jpg' } } } },
    },
  },
}];

/** A document with no post in it is a test failure, not a null dereference. */
const parsed = (html: string) => {
  const post = parseFacebookPost(html);
  assert.ok(post, 'the document carries a post');
  return post;
};

/** postResult's shape follows the media count, so a test reads the fields of the branch it built. */
const shipped = (post: ReturnType<typeof parseFacebookPost>) => {
  const result = postResult(post, PFBID);
  assert.equal(result.error, undefined, `the post shipped its media (saw ${result.error})`);
  return result as Record<string, any>;
};

test('Facebook post: words, permalink and photos arrive in separate nodes and all survive', () => {
  const urls = [
    'https://scontent-sin6-1.xx.fbcdn.net/v/t39.99422-6/one.jpg?stp=dst-jpg_tt6&cstp=mx1179x786&oh=sig-one',
    'https://scontent-sin11-2.xx.fbcdn.net/v/t39.99422-6/two.jpg?stp=dst-jpg_tt6&oh=sig-two',
    'https://scontent-sin6-1.xx.fbcdn.net/v/t39.99422-6/three.jpg?oh=sig-three',
  ];
  const long = 'A long post about a hospital opening. '.repeat(40).trim();
  const html = page(POST_ID,
    // The focal node states the permalink and the album; its words are in another node.
    storyCopy({ message: null, attachments: album(...urls) }),
    storyCopy({ permalink_url: undefined, attachments: undefined, message: { __typename: 'TextWithEntities', text: long } }),
  );

  const post = parsed(html);
  assert.equal(post.text, long, 'the whole post, not the truncated og:description');
  assert.equal(post.permalink, CANONICAL);
  assert.deepEqual(post.media, urls.map((url) => ({ type: 'photo', url })), 'every photo, verbatim: the size params are signed');

  const result = shipped(post);
  assert.equal(result.picker?.length, 3, 'several items are a picker, not a photo');
  assert.deepEqual(result.fileMetadata, { title: long, artist: 'Thinakaran' });
});

test('Facebook post: the document its own og:url names wins over a post it merely recommends', () => {
  const focal = 'https://scontent-sin6-1.xx.fbcdn.net/v/t39.99422-6/focal.jpg?oh=sig';
  const suggested = 'https://scontent-sin6-1.xx.fbcdn.net/v/t39.99422-6/suggested.jpg?oh=sig';
  const html = page(POST_ID,
    storyCopy({ post_id: '999', permalink_url: 'https://www.facebook.com/Thinakaran.lk/posts/pfbid0OTHER', attachments: album(suggested) }),
    storyCopy({ attachments: album(focal) }),
  );

  const post = parsed(html);
  assert.deepEqual(post.media, [{ type: 'photo', url: focal }], 'the recommended post is never the answer');
});

test('Facebook post: one photo is a photo, not a picker', () => {
  const uri = 'https://scontent-sin6-1.xx.fbcdn.net/v/t39.99422-6/single.jpg?stp=dst-jpg_tt6&oh=sig';
  const html = page(POST_ID, storyCopy({ attachments: [{ styles: { attachment: { media: photo(uri) } } }] }));

  const result = shipped(parsed(html));
  assert.equal(result.isPhoto, true);
  assert.equal(result.urls, uri);
  assert.match(result.filename, /^facebook_pfbid.*\.jpg$/);
});

test('Facebook post: a clip is its HD file and the words travel with it', () => {
  const hd = 'https://video-sin6-1.xx.fbcdn.net/v/t39.24130-6/clip_hd.mp4?oh=sig-hd';
  const html = page(POST_ID, storyCopy({
    message: { __typename: 'TextWithEntities', text: 'The full speech' },
    attachments: [{
      styles: {
        attachment: {
          media: {
            __typename: 'Video',
            videoDeliveryLegacyFields: { browser_native_hd_url: hd, browser_native_sd_url: 'https://video-sin6-1.xx.fbcdn.net/clip_sd.mp4?oh=sig-sd' },
          },
        },
      },
    }],
  }));

  const post = parsed(html);
  assert.deepEqual(post.media, [{ type: 'video', url: hd }], 'the HD rung wins');

  const result = shipped(post);
  assert.equal(result.urls, hd);
  assert.match(result.filename, /\.mp4$/);
  assert.equal(result.fileMetadata.title, 'The full speech');
});

test('Facebook post: a text-only post has no media to hand over', () => {
  const post = parsed(page(POST_ID, storyCopy()));
  assert.deepEqual(post.media, []);
  assert.deepEqual(postResult(post, PFBID), { error: 'fetch.empty' });
});

test('Facebook post: a document without post data is null, never an empty post', () => {
  assert.equal(parseFacebookPost('<html><head><meta property="og:url" content="https://www.facebook.com/login/"/></head></html>'), null);
  assert.ok(parseFacebookPost(page(null, storyCopy({ attachments: album('https://cdn.test/a.jpg?oh=sig') }))), 'a document without og:url still yields its one story');
});
