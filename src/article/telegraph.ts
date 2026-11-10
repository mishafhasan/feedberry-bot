import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
const API = 'https://api.telegra.ph';
const TIMEOUT_MS = 20_000;

interface TelegraphReply {
  ok?: boolean;
  error?: string;
  result?: { url?: string; access_token?: string };
}

async function callTelegraph(method: string, body: unknown): Promise<TelegraphReply> {
  const res = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return (await res.json().catch(() => ({}))) as TelegraphReply;
}

/**
 * Telegra.ph requires an access token to publish. The operator may supply one in
 * TELEGRAPH_TOKEN; otherwise the bot creates its own account once and keeps the token
 * beside the database, so a restart reuses it instead of minting a new account.
 * shortcut: only the first token is used, multi-token rotation needs a real secrets store.
 */
let cachedToken: string | null = null;

function tokenFile(): string | null {
  const dbPath = process.env.DB_PATH;
  if (!dbPath || dbPath === ':memory:') return null;
  return join(dirname(dbPath), 'telegraph-token.txt');
}

async function createAccount(): Promise<string> {
  const reply = await callTelegraph('createAccount', { short_name: 'feedberry', author_name: 'FeedBerry' });
  const token = reply.result?.access_token;
  if (!reply.ok || !token) throw new Coded(E.TELEGRAPH, reply.error ?? 'createAccount failed');
  log('info', 'telegraph_account', { created: true });
  return token;
}

async function accessToken(fresh = false): Promise<string> {
  const fromEnv = (process.env.TELEGRAPH_TOKEN ?? '').trim();
  if (fromEnv) return fromEnv;
  if (cachedToken && !fresh) return cachedToken;

  const file = fresh ? null : tokenFile();
  if (file) {
    try {
      const stored = readFileSync(file, 'utf8').trim();
      if (stored) {
        cachedToken = stored;
        return stored;
      }
    } catch {
      // no file yet: fall through and create the account
    }
  }

  cachedToken = await createAccount();
  if (file) {
    try {
      writeFileSync(file, cachedToken, 'utf8');
    } catch (err) {
      // A read-only volume must not cost the user the article.
      log('warn', 'telegraph_token_save_failed', { cause: err instanceof Error ? err.message : String(err) });
    }
  }
  return cachedToken;
}

export const telegraphClient: TelegraphClient = {
  async createPage(page) {
    const body = (token: string) => ({
      access_token: token,
      title: page.title.slice(0, MAX_TITLE),
      author_name: page.authorName.slice(0, MAX_AUTHOR),
      content: page.content,
      return_content: false,
    });

    let reply = await callTelegraph('createPage', body(await accessToken()));
    // A revoked or stale stored token is recoverable: mint one new account and retry once.
    if (reply.error === 'ACCESS_TOKEN_INVALID') {
      log('warn', 'telegraph_token_stale', {});
      reply = await callTelegraph('createPage', body(await accessToken(true)));
    }
    const url = reply.result?.url;
    if (!reply.ok || !url) throw new Coded(E.TELEGRAPH, reply.error ?? 'createPage failed');
    return url;
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
  return blocksOf(dom.window.document.body);
}

/** Telegra.ph has two heading levels: h1-h3 share the larger one, h4-h6 the smaller. */
const HEADINGS: Record<string, 'h3' | 'h4'> = { h1: 'h3', h2: 'h3', h3: 'h3', h4: 'h4', h5: 'h4', h6: 'h4' };

const INLINE: Record<string, string> = { b: 'b', strong: 'b', i: 'i', em: 'i', u: 'u', s: 's', del: 's', code: 'code' };

/** Source formatting puts whitespace between blocks; it is not part of the words. */
const BLOCKS = new Set(['p', 'div', 'section', 'article', 'header', 'footer', 'main', 'nav', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'blockquote', 'aside', 'pre', 'figure', 'table']);

/** The article body and every list item: the blocks Telegra.ph stores at the top of a page. */
function blocksOf(element: Element): unknown[] {
  const out: unknown[] = [];
  for (const child of element.childNodes) out.push(...blockOf(child));
  return out;
}

/** One source node in block position; a paragraph holding a picture yields several blocks. */
function blockOf(node: Node): unknown[] {
  if (node.nodeType === 3) {
    const text = (node as Text).data.replace(/\s+/g, ' ').trim();
    return text === '' ? [] : [{ tag: 'p', children: [text] }];
  }
  if (node.nodeType !== 1) return [];

  const element = node as Element;
  const tag = element.tagName.toLowerCase();
  const heading = HEADINGS[tag];
  if (heading) {
    const media: unknown[] = [];
    const children = trimmed(inlineOf(element, media));
    return [...(children.length > 0 ? [{ tag: heading, children }] : []), ...media];
  }

  switch (tag) {
    case 'p':
      return paragraphsOf(element);
    case 'ul':
    case 'ol':
      return listOf(element);
    case 'blockquote':
    case 'aside':
      return quoteOf(element, tag);
    case 'pre':
      return preOf(element);
    case 'figure':
      return figureOf(element);
    case 'img': {
      const image = imageNode(element);
      return image === null ? [] : [image];
    }
    case 'table':
      return tableOf(element);
    case 'iframe':
    case 'video': {
      const embed = embedNode(element);
      return embed === null ? [] : [embed];
    }
    case 'hr':
      return [{ tag: 'hr' }];
    case 'br':
      return []; // a break between blocks is layout, not content
    default:
      // div, section, article, dl… are containers: their children take their place.
      return blocksOf(element);
  }
}

/** A picture inside a paragraph becomes its own figure: IV's paragraph holds inline text only. */
function paragraphsOf(paragraph: Element): unknown[] {
  const out: unknown[] = [];
  let run: ChildNode[] = [];
  const flush = (): void => {
    const media: unknown[] = [];
    const children = trimmed(inlineNodes(run, media));
    if (children.length > 0) out.push({ tag: 'p', children });
    out.push(...media);
    run = [];
  };
  for (const child of paragraph.childNodes) {
    const media = mediaNode(child);
    if (media === null) {
      run.push(child);
      continue;
    }
    flush();
    out.push(media);
  }
  flush();
  return out;
}

/** A picture, video or embed: Telegra.ph has a block for it, and IV has no inline form. */
function mediaNode(node: Node): unknown | null {
  if (node.nodeType !== 1) return null;
  const element = node as Element;
  const tag = element.tagName.toLowerCase();
  if (tag === 'img') return imageNode(element);
  if (tag === 'iframe' || tag === 'video') return embedNode(element);
  if (tag !== 'a' || element.textContent.trim() !== '') return null;
  const image = element.querySelector('img');
  return image === null ? null : imageNode(image);
}

function imageNode(image: Element): unknown | null {
  const src = image.getAttribute('src');
  return src ? { tag: 'figure', children: [{ tag: 'img', attrs: { src } }] } : null;
}

function embedNode(element: Element): unknown | null {
  const src = element.getAttribute('src');
  return src ? { tag: element.tagName.toLowerCase(), attrs: { src } } : null;
}

function listOf(list: Element): unknown[] {
  const nodes: unknown[] = [];
  for (const item of Array.from(list.children)) {
    if (item.tagName.toLowerCase() !== 'li') continue;
    const children = itemChildren(item);
    if (children.length > 0) nodes.push({ tag: 'li', children });
  }
  return nodes.length > 0 ? [{ tag: list.tagName.toLowerCase(), children: nodes }] : [];
}

/** A list item holds text, links, nested lists and the odd picture — never a paragraph. */
function itemChildren(item: Element): unknown[] {
  const children: unknown[] = [];
  let run: ChildNode[] = [];
  const flush = (): void => {
    const media: unknown[] = [];
    const nodes = trimmed(inlineNodes(run, media));
    children.push(...nodes, ...media);
    run = [];
  };
  for (const child of item.childNodes) {
    const tag = child.nodeType === 1 ? (child as Element).tagName.toLowerCase() : '';
    if (tag === 'ul' || tag === 'ol') {
      flush();
      children.push(...listOf(child as Element));
      continue;
    }
    const media = mediaNode(child);
    if (media !== null) {
      flush();
      children.push(media);
      continue;
    }
    run.push(child);
  }
  flush();
  return children;
}

/** IV's blockquote and pullquote hold rich text: paragraphs inside them join with a line break. */
function quoteOf(element: Element, tag: string): unknown[] {
  const media: unknown[] = [];
  const children = trimmed(inlineOf(element, media));
  const out: unknown[] = children.length > 0 ? [{ tag, children }] : [];
  // A quote cannot hold a picture, but the picture must not vanish because of it.
  out.push(...media);
  return out;
}

/** Code keeps its own whitespace; a paragraph's collapse rule would flatten every line into one. */
function preOf(pre: Element): unknown[] {
  const lines = rawText(pre)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''));
  while (lines.length > 0 && lines[0] === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.length > 0 ? [{ tag: 'pre', children: [lines.join('\n')] }] : [];
}

/** Inline tags inside a code block contribute their text; `<br>` is the line break it stands for. */
function rawText(element: Element): string {
  let out = '';
  for (const child of element.childNodes) {
    if (child.nodeType === 3) out += (child as Text).data;
    else if (child.nodeType === 1) {
      const inner = child as Element;
      out += inner.tagName.toLowerCase() === 'br' ? '\n' : rawText(inner);
    }
  }
  return out;
}

/** IV's Media block is one picture plus its caption; a caption marked as a bare <p> is promoted. */
function figureOf(figure: Element): unknown[] {
  const sources = Array.from(figure.querySelectorAll('img'))
    .map((image) => image.getAttribute('src'))
    .filter((src): src is string => Boolean(src));
  if (sources.length === 0) return blocksOf(figure);

  const caption = figure.querySelector('figcaption');
  const media: unknown[] = [];
  const captionNodes =
    caption === null
      ? inlineNodes(Array.from(figure.childNodes).filter((child) => mediaNode(child) === null), media)
      : inlineNodes(caption.childNodes, media);
  const text = trimmed(captionNodes);

  // One figure per picture keeps a gallery whole; the caption belongs to its last frame.
  const figures = sources.map((src, index) => {
    const children: unknown[] = [{ tag: 'img', attrs: { src } }];
    if (index === sources.length - 1 && text.length > 0) children.push({ tag: 'figcaption', children: text });
    return { tag: 'figure', children };
  });
  return [...figures, ...media];
}

/** Telegra.ph has no table node: each row becomes a paragraph, its cells joined with a bar. */
function tableOf(table: Element): unknown[] {
  const out: unknown[] = [];
  const caption = Array.from(table.children).find((child) => child.tagName.toLowerCase() === 'caption');
  if (caption !== undefined) {
    const text = trimmed(inlineOf(caption));
    if (text.length > 0) out.push({ tag: 'p', children: [{ tag: 'b', children: text }] });
  }
  // A cell may hold a table of its own; those rows were already flattened into its text.
  const rows = Array.from(table.querySelectorAll('tr')).filter((row) => row.closest('table') === table);
  for (const row of rows) {
    const children: unknown[] = [];
    const media: unknown[] = [];
    for (const cell of Array.from(row.children)) {
      const tag = cell.tagName.toLowerCase();
      if (tag !== 'th' && tag !== 'td') continue;
      const cellMedia: unknown[] = [];
      const content = trimmed(inlineNodes(cell.childNodes, cellMedia));
      // A cell that holds only a picture still owns its column.
      if (content.length === 0 && cellMedia.length === 0) continue;
      if (children.length > 0) children.push(' | ');
      children.push(...(tag === 'th' ? [{ tag: 'b', children: content }] : content));
      media.push(...cellMedia);
    }
    if (children.length > 0) out.push({ tag: 'p', children });
    out.push(...media);
  }
  return out.length > 0 ? out : blocksOf(table);
}

/** Inline content: what Telegra.ph accepts inside a paragraph, a quote, a list item or a caption. */
function inlineOf(element: Element, media: unknown[] = []): unknown[] {
  return inlineNodes(element.childNodes, media);
}

function inlineNodes(nodes: Iterable<ChildNode>, media: unknown[] = []): unknown[] {
  const out: unknown[] = [];
  for (const node of nodes) {
    if (node.nodeType === 3) {
      const text = (node as Text).data.replace(/\s+/g, ' ');
      if (text.trim() === '' && (isBlock(node.previousSibling) || isBlock(node.nextSibling))) continue;
      out.push(text);
      continue;
    }
    if (node.nodeType !== 1) continue;

    const element = node as Element;
    const tag = element.tagName.toLowerCase();
    if (tag === 'br') {
      out.push({ tag: 'br' });
      continue;
    }
    const block = mediaNode(node);
    if (block !== null) {
      media.push(block);
      continue;
    }
    if (tag === 'ul' || tag === 'ol') {
      const lines = listLines(element, media);
      if (lines.length === 0) continue;
      if (out.length > 0) out.push({ tag: 'br' });
      out.push(...lines);
      continue;
    }
    if (tag === 'a') {
      const children = inlineNodes(element.childNodes, media);
      if (children.length === 0) continue;
      const href = element.getAttribute('href');
      if (href === null) out.push(...children);
      else out.push({ tag: 'a', attrs: { href }, children });
      continue;
    }
    const mapped = INLINE[tag];
    if (mapped !== undefined) {
      const children = inlineNodes(element.childNodes, media);
      if (children.length > 0) out.push({ tag: mapped, children });
      continue;
    }
    // A block inside an inline context (a paragraph in a quote or a cell) becomes a line break;
    // span, small, mark and the like are transparent.
    const children = inlineNodes(element.childNodes, media);
    if (children.length === 0) continue;
    if (out.length > 0 && BLOCKS.has(tag)) out.push({ tag: 'br' });
    out.push(...children);
  }
  return out;
}

function isBlock(node: Node | null): boolean {
  return node !== null && node.nodeType === 1 && BLOCKS.has((node as Element).tagName.toLowerCase());
}

/** A list inside a quote or a cell has no list container to live in: its items become lines. */
function listLines(list: Element, media: unknown[]): unknown[] {
  const ordered = list.tagName.toLowerCase() === 'ol';
  const items = Array.from(list.children).filter((child) => child.tagName.toLowerCase() === 'li');
  const out: unknown[] = [];
  for (const [index, item] of items.entries()) {
    const children = trimmed(inlineNodes(item.childNodes, media));
    if (children.length === 0) continue;
    if (out.length > 0) out.push({ tag: 'br' });
    out.push(ordered ? `${index + 1}. ` : '• ');
    out.push(...children);
  }
  return out;
}

/** Drops the line breaks and spaces a block boundary left at either end. */
function trimmed(nodes: unknown[]): unknown[] {
  const blank = (node: unknown): boolean =>
    typeof node === 'string' ? node.trim() === '' : (node as { tag?: string }).tag === 'br';
  let start = 0;
  let end = nodes.length;
  while (start < end && blank(nodes[start])) start++;
  while (end > start && blank(nodes[end - 1])) end--;

  const out = nodes.slice(start, end);
  if (typeof out[0] === 'string') out[0] = out[0].trimStart();
  const last = out.length - 1;
  if (typeof out[last] === 'string') {
    const text = out[last].trimEnd();
    if (text === '') out.pop();
    else out[last] = text;
  }
  return out;
}

