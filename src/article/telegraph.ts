import { JSDOM } from 'jsdom';
import { log } from '../obs/log.ts';
import { Coded, E } from '../platform/errors.ts';
import { chunk } from '../render/albums.ts';
import type { Article } from './readability.ts';

export interface TelegraphPage {
  title: string;
  authorName: string;
  content: string;
}

/** The Telegra.ph API (ADR-007). Injected so tests never touch the network. */
export interface TelegraphClient {
  createPage(page: TelegraphPage): Promise<string>;
}

export const MAX_CONTENT_BYTES = 65_000;
const MAX_TITLE = 256;
const MAX_AUTHOR = 128;

export const telegraphClient: TelegraphClient = {
  async createPage(page) {
    const body = {
      title: page.title.slice(0, MAX_TITLE),
      author_name: page.authorName.slice(0, MAX_AUTHOR),
      content: page.content,
      return_content: false,
    };
    const res = await fetch('https://api.telegra.ph/createPage', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: { url?: string }; error?: string };
    if (!res.ok || !json.ok || !json.result?.url) throw new Coded(E.TELEGRAPH, json.error ?? `telegraph replied ${res.status}`);
    return json.result.url;
  },
};

/**
 * R12's page. Over 64 KB the nodes are split and chained with "Read Next page" links, exactly as
 * formatbot1 does — Telegra.ph caps a page's content, not the article.
 */
export async function publishArticle(client: TelegraphClient, article: Article): Promise<string> {
  const nodes = telegraphNodes(article.html);
  const authorName = article.byline ?? new URL(article.url).hostname;
  const payload = (content: string) => ({ title: article.title, authorName, content });
  const bytes = Buffer.byteLength(JSON.stringify(nodes), 'utf8');

  if (bytes <= MAX_CONTENT_BYTES) return client.createPage(payload(JSON.stringify(nodes)));

  const parts = Math.ceil(bytes / MAX_CONTENT_BYTES);
  const groups = chunk(nodes, Math.ceil(nodes.length / parts));
  let next = '';

  for (let index = groups.length - 1; index >= 0; index--) {
    const body: unknown[] = [...(groups[index] ?? [])];
    if (next) {
      body.push({ tag: 'p', children: [{ tag: 'a', attrs: { href: next }, children: ['Read Next page'] }] });
    }
    next = await client.createPage(payload(JSON.stringify(body)));
    log('info', 'telegraph_page', { index, bytes: Buffer.byteLength(JSON.stringify(body), 'utf8') });
  }
  return next;
}

/** Convert sanitized HTML into the node array Telegra.ph accepts. */
export function telegraphNodes(html: string): unknown[] {
  const dom = new JSDOM(`<body>${html}</body>`);
  return childrenOf(dom.window.document.body);
}

const TAG_MAP: Record<string, string> = {
  p: 'p',
  a: 'a',
  b: 'b',
  strong: 'b',
  i: 'i',
  em: 'i',
  u: 'u',
  s: 's',
  del: 's',
  code: 'code',
  pre: 'pre',
  blockquote: 'blockquote',
  h1: 'h3',
  h2: 'h3',
  h3: 'h3',
  h4: 'h4',
  ul: 'ul',
  ol: 'ol',
  li: 'li',
  figure: 'figure',
  figcaption: 'figcaption',
  img: 'img',
  br: 'br',
  hr: 'hr',
  iframe: 'iframe',
};

const ATTRIBUTES: Record<string, string> = { a: 'href', img: 'src', iframe: 'src' };

function childrenOf(element: Element): unknown[] {
  const out: unknown[] = [];
  for (const child of element.childNodes) {
    const node = toNode(child);
    if (Array.isArray(node)) out.push(...node);
    else if (node !== null) out.push(node);
  }
  return out;
}

/** Unmapped tags are unwrapped: their children take their place, nothing is lost. */
function toNode(node: Node): unknown | unknown[] | null {
  if (node.nodeType === 3) {
    const text = (node as Text).data.replace(/\s+/g, ' ');
    return text.trim() ? text : null;
  }
  if (node.nodeType !== 1) return null;

  const element = node as Element;
  const tag = TAG_MAP[element.tagName.toLowerCase()];
  if (!tag) return childrenOf(element);

  const out: Record<string, unknown> = { tag };
  const attribute = ATTRIBUTES[tag];
  if (attribute) {
    const value = element.getAttribute(attribute);
    if (value) out.attrs = { [attribute]: value };
  }
  const children = childrenOf(element);
  if (children.length > 0) out.children = children;
  else if (tag === 'p' || tag === 'li') return null; // an empty paragraph is noise
  return out;
}
