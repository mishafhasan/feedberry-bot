import { Coded, E } from '../errors.ts';
import { HTML_LIMIT, type Http } from '../http.ts';
import { handleFeedStatus } from './native.ts';

/**
 * Threads renders the whole thread into the permalink document, but only for a request that does
 * not look like a top-level navigation: `accept: text/html` plus the three Sec-Fetch headers.
 * Verified 2026-11-02: without `accept` the same URL answers 557 KB of app shell with no post data.
 */
const THREADS_HEADERS: Record<string, string> = {
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-origin',
};

export interface ThreadMedia {
  url: string;
  type: 'photo' | 'video';
}

/** One post of the author's own chain, already flattened out of the SSR payload. */
export interface ThreadPost {
  pk: string;
  code: string;
  url: string;
  author: string | null;
  text: string;
  /** Epoch ms; Threads sends seconds. */
  publishedAt: number | null;
  media: ThreadMedia[];
}

export interface ThreadDoc {
  /** The account that owns the thread, for the "add as source" button. */
  author: string | null;
  /** Root first, then every sub-post: `text_post_app_info.reply_level` order, never `taken_at`. */
  posts: ThreadPost[];
}

/** Stage 2 for one Threads permalink: root + sub-posts from a single logged-out GET. */
export async function fetchThreadsThread(http: Http, url: string): Promise<ThreadDoc> {
  const target = permalink(url);
  const res = await http(target, { maxBytes: HTML_LIMIT, headers: THREADS_HEADERS });
  handleFeedStatus(res.status);

  const code = shortcodeOf(res.url) ?? shortcodeOf(target);
  const doc = code === null ? null : parseOrNull(res.body, code);
  // A 200 that carries the shell is the failure mode of the anti-bot rules, not an empty thread.
  if (doc === null) throw new Coded(E.NO_FEED, 'threads permalink carried the app shell, not the post');
  return doc;
}

/** A payload that no longer matches is the same case as the shell: fall back, never crash a download. */
function parseOrNull(html: string, code: string): ThreadDoc | null {
  try {
    return parseThreadDocument(html, code);
  } catch {
    return null;
  }
}

/**
 * Reads the ordered thread out of the page's `<script type="application/json" data-sjs>` blobs.
 * Pure, so the fixtures drive it without the network.
 */
export function parseThreadDocument(html: string, shortcode: string): ThreadDoc | null {
  const blobs = jsonBlobs(html);
  if (blobs.length === 0) return null;

  const found = collect(blobs);
  // The shortcode comes from the URL the user gave us; the preloaders are only a fallback for a
  // document that carries the post as a partial copy.
  const focalPk = found.byCode.get(shortcode.toLowerCase()) ?? found.focalIds.find((pk) => found.byPk.has(pk));
  if (focalPk === undefined) return null;
  const author = found.byPk.get(focalPk)?.user?.username ?? null;

  const seen = new Set<string>();
  const posts: ThreadPost[] = [];
  for (const pk of [...found.ancestors, focalPk, ...found.descendants]) {
    if (seen.has(pk)) continue;
    // A thread is one author's chain: never merge another account's `self_thread` the page embeds.
    if (author !== null && pk !== focalPk && (found.byPk.get(pk)?.user?.username ?? null) !== author) continue;
    seen.add(pk);
    const node = found.byPk.get(pk);
    const post = node === undefined ? null : postOf(node);
    if (post !== null) posts.push(post);
  }
  if (posts.length === 0) return null;

  return { author: posts[0]?.author ?? null, posts };
}

interface Found {
  /** One copy per post: text, timestamp and media do not always arrive together. */
  byPk: Map<string, RawNode>;
  byCode: Map<string, string>;
  /** `text_post_app_info.containing_thread`: the ancestors, root first. */
  ancestors: string[];
  /** `text_post_app_info.self_thread`: the author's own continuations, in reply order. */
  descendants: string[];
  /** `expectedPreloaders[].variables.postID`: the post the document was requested for. */
  focalIds: string[];
}

function collect(blobs: unknown[]): Found {
  const found: Found = { byPk: new Map(), byCode: new Map(), ancestors: [], descendants: [], focalIds: [] };
  const levels = { ancestors: new Map<string, number>(), descendants: new Map<string, number>() };

  const addEdge = (side: 'ancestors' | 'descendants', nodes: RawNode[]): void => {
    for (const [index, node] of nodes.entries()) {
      const pk = String(node.pk ?? '');
      if (pk === '') continue;
      if (!levels[side].has(pk)) levels[side].set(pk, replyLevel(node) * 1000 + index);
      if (side === 'ancestors' && !found.ancestors.includes(pk)) found.ancestors.push(pk);
      if (side === 'descendants' && !found.descendants.includes(pk)) found.descendants.push(pk);
    }
  };

  const visit = (value: unknown, depth: number): void => {
    if (value === null || typeof value !== 'object' || depth > 128) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    const node = value as RawNode & { variables?: { postID?: unknown } };
    if ((typeof node.pk === 'string' || typeof node.pk === 'number') && typeof node.code === 'string') {
      const pk = String(node.pk);
      const best = found.byPk.get(pk);
      if (best === undefined || richness(node) > richness(best)) found.byPk.set(pk, node);
      if (!found.byCode.has(node.code.toLowerCase())) found.byCode.set(node.code.toLowerCase(), pk);
    }
    if (typeof node.variables?.postID === 'string') found.focalIds.push(node.variables.postID);
    addEdge('ancestors', edgesOf(node.text_post_app_info?.containing_thread));
    addEdge('descendants', edgesOf(node.text_post_app_info?.self_thread));
    for (const child of Object.values(node)) if (child !== null && typeof child === 'object') visit(child, depth + 1);
  };

  for (const blob of blobs) visit(blob, 0);

  const order = (list: string[], side: 'ancestors' | 'descendants'): string[] =>
    [...list].sort((left, right) => (levels[side].get(left) ?? 0) - (levels[side].get(right) ?? 0));
  return { ...found, ancestors: order(found.ancestors, 'ancestors'), descendants: order(found.descendants, 'descendants') };
}

/** threads.com 301s to www, and a cross-host redirect would drop the Sec-Fetch headers. */
function permalink(url: string): string {
  const parsed = new URL(url);
  parsed.protocol = 'https:';
  parsed.hostname = 'www.threads.com';
  return parsed.toString();
}

/** `…/@user/post/<code>`, or the short form `…/t/<code>`. */
function shortcodeOf(url: string): string | null {
  let path: string[];
  try {
    path = new URL(url).pathname.split('/').filter(Boolean);
  } catch {
    return null;
  }
  if (path[0] === 't') return path[1] ?? null;
  const at = path.indexOf('post');
  return at >= 0 ? (path[at + 1] ?? null) : null;
}

function jsonBlobs(html: string): unknown[] {
  const out: unknown[] = [];
  for (const match of html.matchAll(/<script type="application\/json"[^>]*data-sjs[^>]*>([\s\S]*?)<\/script>/g)) {
    try {
      out.push(JSON.parse(match[1] ?? ''));
    } catch {
      // One malformed blob must not cost the whole page.
    }
  }
  return out;
}

/** Ancestors above the opened post, and its own continuations below it. */
function edgesOf(container: { posts?: { edges?: Array<{ node?: RawNode }> } } | null | undefined): RawNode[] {
  const edges = container?.posts?.edges;
  if (!Array.isArray(edges)) return [];
  return edges
    .map((edge) => edge?.node)
    .filter((node): node is RawNode => typeof node === 'object' && node !== null)
    .map((node, index) => ({ node, index, level: replyLevel(node) }))
    .sort((left, right) => left.level - right.level || left.index - right.index)
    .map((entry) => entry.node);
}

const replyLevel = (node: RawNode): number =>
  typeof node.text_post_app_info?.reply_level === 'number' ? node.text_post_app_info.reply_level : Number.MAX_SAFE_INTEGER;

/** Picks the copy of a post that carries its text and timestamp, not the stub with only a pk. */
function richness(node: RawNode): number {
  const text = textOf(node);
  return text.length + (typeof node.taken_at === 'number' ? 1 : 0) + (mediaOf(node).length > 0 ? 1 : 0);
}

function postOf(node: RawNode): ThreadPost | null {
  if (typeof node.code !== 'string') return null;
  const author = node.user?.username ?? null;
  return {
    pk: String(node.pk),
    code: node.code,
    url: author === null ? '' : `https://www.threads.com/@${author}/post/${node.code}`,
    author,
    text: textOf(node),
    publishedAt: typeof node.taken_at === 'number' ? node.taken_at * 1000 : null,
    media: mediaOf(node),
  };
}

/**
 * Sub-posts keep their words under `snippet_attachment_info` and a null `caption`; reading `caption`
 * alone ships an empty post (3,779 characters lost on the reference thread).
 */
function textOf(node: RawNode): string {
  const info = node.text_post_app_info ?? {};
  const caption = typeof node.caption?.text === 'string' ? node.caption.text.trim() : '';
  return textOfFragments(info.snippet_attachment_info?.text_fragments?.fragments) || textOfFragments(info.text_fragments?.fragments) || caption;
}

function textOfFragments(fragments: Array<{ plaintext?: string }> | undefined): string {
  if (!Array.isArray(fragments) || fragments.length === 0) return '';
  return fragments.map((fragment) => (typeof fragment?.plaintext === 'string' ? fragment.plaintext : '')).join('').trim();
}

function mediaOf(node: RawNode): ThreadMedia[] {
  const carousel = node.carousel_media;
  if (Array.isArray(carousel) && carousel.length > 0) {
    return carousel.filter((item): item is RawNode => typeof item === 'object' && item !== null).flatMap(mediaOf);
  }
  const video = node.video_versions?.[0]?.url;
  if (typeof video === 'string' && video !== '') return [{ url: video, type: 'video' }];
  // Unsigned candidate arrays are ordered best first: [0] is the original.
  const image = node.image_versions2?.candidates?.[0]?.url;
  if (typeof image === 'string' && image !== '') return [{ url: image, type: 'photo' }];
  return [];
}

interface RawNode {
  pk?: string | number;
  code?: string;
  taken_at?: number;
  caption?: { text?: string | null } | null;
  carousel_media?: RawNode[] | null;
  video_versions?: Array<{ url?: string }> | null;
  image_versions2?: { candidates?: Array<{ url?: string }> } | null;
  user?: { username?: string | null } | null;
  text_post_app_info?: {
    reply_level?: number | null;
    text_fragments?: { fragments?: Array<{ plaintext?: string }> } | null;
    snippet_attachment_info?: { text_fragments?: { fragments?: Array<{ plaintext?: string }> } } | null;
    self_thread?: { posts?: { edges?: Array<{ node?: RawNode }> } } | null;
    containing_thread?: { posts?: { edges?: Array<{ node?: RawNode }> } } | null;
  } | null;
}
