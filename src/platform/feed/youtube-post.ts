import { Coded, E } from '../errors.ts';
import { HTML_LIMIT, type Http } from '../http.ts';
import { handleFeedStatus } from './native.ts';

/**
 * A community post is rendered into its permalink document as `ytInitialData`: no key, no cookie,
 * no JavaScript. Verified 2026-11-02 on /post/UgkxGuBM_v4CJugE7V-Dns33VhSMVB0_UL_F — 200 with
 * `backstagePostRenderer` for the FeedBerry user agent too; a removed post answers 404 and no data.
 * A browser-shaped request is kept anyway, because the page is a Web app's shell as much as a post.
 */
const YOUTUBE_HEADERS: Record<string, string> = {
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
};

export interface YouTubeChannel {
  /** `youtube.com/channel/UC…` is the native-feed route: adding it needs no RSSHub API key. */
  url: string;
  /** The `@handle`, which is what the "add as source" button prints. */
  handle: string;
}

export interface YouTubePostDoc {
  /** The channel title as the post shows it ("Ceylon Focus News"), not the handle. */
  author: string | null;
  channel: YouTubeChannel | null;
  /** The post's words, plus its poll or attached video written out as text. */
  text: string;
  /** Original-size image URLs, in post order. */
  media: string[];
}

/** Stage 2 for one community post: the page carries the post, so one GET is the whole job. */
export async function fetchYouTubePost(http: Http, url: string): Promise<YouTubePostDoc> {
  const id = postIdOf(url);
  if (id === null) throw new Coded(E.LINK_INVALID, 'not a youtube post url');
  // The page is ~880 KB and answered in 9–16 s on a real link, so the 20 s default is too tight.
  const res = await http(`https://www.youtube.com/post/${id}`, { maxBytes: HTML_LIMIT, timeoutMs: 30_000, headers: YOUTUBE_HEADERS });
  handleFeedStatus(res.status);

  const doc = parseYouTubePost(res.body, id);
  // A 200 that carries no post is the anti-bot shell, not an empty post.
  if (doc === null) throw new Coded(E.NO_FEED, 'youtube post page carried no post data');
  return doc;
}

/** Pure, so the fixtures drive it without the network. */
export function parseYouTubePost(html: string, postId: string): YouTubePostDoc | null {
  const data = initialData(html);
  const post = data === null ? null : findPost(data, postId);
  if (post === null) return null;

  const text = [textOf(post.contentText), ...attachmentParts(post.backstageAttachment)].filter((part) => part !== '').join('\n\n');
  return { author: textOf(post.authorText) || null, channel: channelOf(post), text, media: imagesOf(post.backstageAttachment) };
}

/** `…/post/<id>`, the only shape this adapter accepts. */
function postIdOf(url: string): string | null {
  let path: string[];
  try {
    path = new URL(url).pathname.split('/').filter(Boolean);
  } catch {
    return null;
  }
  return path[0] === 'post' ? (path[1] ?? null) : null;
}

const DATA = /(?:var ytInitialData|window\["ytInitialData"\])\s*=\s*(\{[\s\S]*?\});\s*<\/script>/;

function initialData(html: string): unknown | null {
  const match = DATA.exec(html);
  if (match === null) return null;
  try {
    return JSON.parse(match[1] ?? '');
  } catch {
    return null;
  }
}

/** The renderer of the requested post, wherever the page buried it. */
function findPost(value: unknown, postId: string, depth = 0): RawPost | null {
  if (value === null || typeof value !== 'object' || depth > 64) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = findPost(item, postId, depth + 1);
      if (hit !== null) return hit;
    }
    return null;
  }
  const node = value as RawPost;
  if (node.postId === postId && (node.contentText !== undefined || node.backstageAttachment !== undefined)) return node;
  for (const child of Object.values(value)) {
    const hit = findPost(child, postId, depth + 1);
    if (hit !== null) return hit;
  }
  return null;
}

/** A channel names the source a download could be subscribed to, and its native feed. */
function channelOf(post: RawPost): YouTubeChannel | null {
  const endpoint = post.authorEndpoint?.browseEndpoint;
  const id = endpoint?.browseId;
  if (typeof id !== 'string' || !id.startsWith('UC')) return null;
  const base = endpoint?.canonicalBaseUrl;
  const handle = typeof base === 'string' && base.startsWith('/@') ? base.slice(2) : textOf(post.authorText);
  return handle === '' ? null : { url: `https://youtube.com/channel/${id}`, handle };
}

function imagesOf(attachment: RawAttachment | null | undefined): string[] {
  const multi = attachment?.postMultiImageRenderer?.images;
  if (Array.isArray(multi)) {
    return multi.map((image) => largest(image?.backstageImageRenderer?.image)).filter((url): url is string => url !== null);
  }
  const one = largest(attachment?.backstageImageRenderer?.image);
  return one === null ? [] : [one];
}

/** Thumbnails run smallest first; the original is the widest one that still carries a URL. */
function largest(image: RawImage | null | undefined): string | null {
  const thumbs = image?.thumbnails;
  if (!Array.isArray(thumbs)) return null;
  let best: string | null = null;
  let bestArea = -1;
  for (const thumb of thumbs) {
    const url = thumb?.url;
    if (typeof url !== 'string' || url === '') continue;
    const size = area(thumb);
    // `>=` keeps the last of two equally sized entries, which is the one YouTube calls original.
    if (size < bestArea) continue;
    best = url.startsWith('//') ? `https:${url}` : url;
    bestArea = size;
  }
  return best;
}

const area = (thumb: RawThumb): number => (thumb.width ?? 0) * (thumb.height ?? 0);

/**
 * A poll or an attached video has no file of its own, so its facts join the post's words: the
 * video is a link, never a download (it is often longer than anything worth uploading).
 */
function attachmentParts(attachment: RawAttachment | null | undefined): string[] {
  const poll = attachment?.pollRenderer;
  const choices = Array.isArray(poll?.choices) ? poll.choices.map((choice) => textOf(choice?.text)).filter((label) => label !== '') : [];
  if (choices.length > 0) return [`📊 Poll\n${choices.map((label) => `• ${label}`).join('\n')}`];

  const video = attachment?.videoRenderer;
  if (typeof video?.videoId === 'string' && video.videoId !== '') {
    const title = textOf(video.title);
    return [`🎬 ${title === '' ? 'YouTube video' : title}\nhttps://youtu.be/${video.videoId}`];
  }
  return [];
}

/** Post text arrives as runs; a label arrives as one run or as `simpleText`. */
function textOf(value: { runs?: Array<{ text?: unknown }>; simpleText?: unknown } | null | undefined): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value.runs)) {
    return value.runs.map((run) => (typeof run?.text === 'string' ? run.text : '')).join('').trim();
  }
  return typeof value.simpleText === 'string' ? value.simpleText.trim() : '';
}

interface RawThumb {
  url?: string;
  width?: number;
  height?: number;
}

interface RawImage {
  thumbnails?: RawThumb[];
}

type Text = { runs?: Array<{ text?: unknown }>; simpleText?: unknown };

interface RawAttachment {
  backstageImageRenderer?: { image?: RawImage } | null;
  postMultiImageRenderer?: { images?: Array<{ backstageImageRenderer?: { image?: RawImage } }> } | null;
  videoRenderer?: { videoId?: string; title?: Text } | null;
  pollRenderer?: { choices?: Array<{ text?: Text }> } | null;
}

interface RawPost {
  postId?: string;
  authorText?: Text | null;
  authorEndpoint?: { browseEndpoint?: { browseId?: string; canonicalBaseUrl?: string } } | null;
  contentText?: Text | null;
  backstageAttachment?: RawAttachment | null;
}
