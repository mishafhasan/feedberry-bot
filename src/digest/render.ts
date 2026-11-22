import { t } from '../bot/i18n/index.ts';
import { postHeader } from '../render/caption.ts';
import { esc, type MessagePlan } from '../render/message-plan.ts';
import type { DigestItem, DigestLang } from './summarise.ts';

/**
 * ADR-029: the digest message, pure. Facts and items in, one rich plan per part out; no I/O, no db,
 * no Telegram. The budgets sit under the Bot API's 50 media / 32 768 chars / 500 blocks.
 */
export const MAX_PART_MEDIA = 49;
/**
 * Measured (ADR-033): 33 000 characters answers RICH_MESSAGE_TEXT_TOO_LONG, 24 000 Tamil characters
 * (64 kB of UTF-8) pass, so the cap counts visible text and this budget counts the same thing.
 */
export const MAX_PART_CHARS = 30_000;
export const MAX_PART_BLOCKS = 480;
/** Worst-case header and footer: reserved so a part can never be composed past the hard limits. */
const HEADER_CHARS = 400;
const HEADER_BLOCKS = 6;
const FOOTER_CHARS = 300;
const FOOTER_BLOCKS = 2;
/** One "Also today" chunk: small enough that the greedy packer can always place it whole. */
const EXTRA_PIECE_LINES = 50;
const EXTRA_PIECE_CHARS = 8_000;

export interface RenderAudio {
  file: string;
  seconds: number;
}

export interface RenderInput {
  lang: DigestLang;
  /** Already formatted in the owner's zone; the renderer only prints it. */
  date: string;
  tz: string;
  sourceCount: number;
  /** Newest first, as the window query returns them. */
  items: DigestItem[];
  /** Posts past the cost cap: numbered headline links, no summary. */
  extra: Array<{ headline: string; url: string | null }>;
  /** Total posts in the window, including `extra`; printed in the header and the footer. */
  postCount: number;
  audio: RenderAudio | null;
}

interface Piece {
  html: string;
  /** Visible characters, the unit of the API's 32 768 cap; markup does not count. */
  chars: number;
  media: Array<{ id: string; file: string; kind: 'photo' | 'audio' }>;
  blocks: number;
}

export function renderDigest(input: RenderInput): MessagePlan[] {
  if (input.items.length === 0) {
    const html = `${headerOf(input, 1, 1)}<p>${esc(t(input.lang, 'digest.empty'))}</p>`;
    return [{ kind: 'rich', html, media: [] }];
  }

  const pieces = input.items.map((item, index) => itemPiece(input, item, index + 1));
  pieces.push(...extraPieces(input, input.items.length + 1));

  const groups = pack(pieces);
  const total = groups.length;

  return groups.map((group, index) => {
    const part = index + 1;
    const last = part === total;
    const items = group.map((piece) => piece.html).join('');
    // The footer closes the digest, after the "Also today" list when there is one.
    const tail = last ? `<footer><b><i>${esc(t(input.lang, 'digest.footer'))}</i></b></footer>` : '';
    const media = group.flatMap((piece) => piece.media);
    // The player is Part 1's, and it takes the slot item images never use: 50 in total.
    if (part === 1 && input.audio !== null) media.push({ id: 'overview', file: input.audio.file, kind: 'audio' });
    return { kind: 'rich', html: `${headerOf(input, part, total)}${items}${tail}`, media };
  });
}

/** The header of one part: heading, date line, the player (Part 1, stories present), then a rule. */
function headerOf(input: RenderInput, part: number, total: number): string {
  const heading = part === 1 ? t(input.lang, 'digest.heading') : `${t(input.lang, 'digest.heading')} · ${t(input.lang, 'digest.part', { n: part, total })}`;
  const date = esc(t(input.lang, 'digest.dateLine', { date: input.date, posts: input.postCount, sources: input.sourceCount }));
  const audio =
    part !== 1 || input.items.length === 0
      ? ''
      : input.audio === null
        ? `<p><i>${esc(t(input.lang, 'digest.audioUnavailable'))}</i></p>`
        : `<audio src="tg://audio?id=overview"></audio><p><i>${esc(t(input.lang, 'digest.audioLine', { min: Math.max(1, Math.round(input.audio.seconds / 60)) }))}</i></p>`;
  return `<h2>${esc(heading)}</h2><p>${date}</p>${audio}<hr/>`;
}

function itemPiece(input: RenderInput, item: DigestItem, number: number): Piece {
  const media: Piece['media'] = [];
  const images = item.images.slice(0, 3).map((file, index) => {
    const id = `i${number}m${index}`;
    media.push({ id, file, kind: 'photo' });
    return `<img src="tg://photo?id=${id}"/>`;
  });

  const original = input.lang === 'ta' && item.originalTitle !== null && item.originalTitle !== item.headline ? `<p><i>${esc(item.originalTitle)}</i></p>` : '';
  const header = postHeader({ sourceTitle: item.sourceTitle, url: item.url, publishedAt: item.publishedAt, platform: 'rss', tz: input.tz, rich: true });
  const slideshow = images.length === 0 ? '' : images.length === 1 ? (images[0] ?? '') : `<tg-slideshow>${images.join('')}</tg-slideshow>`;
  const points =
    item.points.length === 0
      ? ''
      : `<p><b>${esc(t(input.lang, 'digest.points'))}</b></p><ul>${item.points.map((point) => `<li>${esc(point)}</li>`).join('')}</ul>`;
  const link = item.link === null ? '' : `<p><a href="${esc(item.link)}">${esc(t(input.lang, 'digest.readFull'))}</a></p>`;

  // Headline first, then the source/time line the rest of the bot prints, then the story.
  const html = `<h3>${number}. ${esc(item.headline)}</h3>${original}${header}${slideshow}<p>${esc(item.description)}</p>${points}${link}<hr/>`;
  const blocks =
    1 + // heading
    (original === '' ? 0 : 1) +
    1 + // source heading
    (item.publishedAt === null ? 0 : 1) +
    (images.length === 0 ? 0 : images.length === 1 ? 1 : images.length + 1) +
    1 + // description
    (item.points.length === 0 ? 0 : item.points.length + 2) +
    (link === '' ? 0 : 1) +
    1; // rule

  return { html, media, chars: visibleChars(html), blocks };
}

/**
 * "Also today": the posts past the cost cap, as numbered headline links. The list is the only piece
 * whose size the clamps do not bound, so it is emitted in chunks a part can always hold (ADR-033).
 * Numbering runs across the chunks; only the first carries the heading.
 */
function extraPieces(input: RenderInput, first: number): Piece[] {
  if (input.extra.length === 0) return [];
  const heading = `<p><b>${esc(t(input.lang, 'digest.alsoToday'))}</b></p>`;
  const pieces: Piece[] = [];
  let lines: string[] = [];
  let chars = 0;

  const close = (): void => {
    if (lines.length === 0) return;
    const lead = pieces.length === 0 ? heading : '';
    const html = `${lead}<ul>${lines.join('')}</ul>`;
    pieces.push({ html, media: [], chars: visibleChars(html), blocks: lines.length + (lead === '' ? 1 : 2) });
    lines = [];
    chars = 0;
  };

  for (const [index, entry] of input.extra.entries()) {
    const label = `${first + index}. ${esc(entry.headline)}`;
    const line = entry.url === null ? `<li>${label}</li>` : `<li><a href="${esc(entry.url)}">${label}</a></li>`;
    if (lines.length > 0 && (lines.length >= EXTRA_PIECE_LINES || chars + line.length > EXTRA_PIECE_CHARS)) close();
    lines.push(line);
    chars += line.length;
  }
  close();
  return pieces;
}

/** The visible characters of one piece: entities are the three `esc` writes, tags are noise. */
export function visibleChars(html: string): number {
  return html.replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').length;
}

/** Greedy split in digest order: a part closes before an item would break a budget. */
function pack(pieces: Piece[]): Piece[][] {
  const groups: Piece[][] = [];
  let current: Piece[] = [];
  let chars = 0;
  let blocks = 0;
  let media = 0;

  for (const piece of pieces) {
    const over =
      current.length > 0 &&
      (chars + piece.chars + HEADER_CHARS + FOOTER_CHARS > MAX_PART_CHARS ||
        blocks + piece.blocks + HEADER_BLOCKS + FOOTER_BLOCKS > MAX_PART_BLOCKS ||
        media + piece.media.length > MAX_PART_MEDIA);
    if (over) {
      groups.push(current);
      current = [];
      chars = 0;
      blocks = 0;
      media = 0;
    }
    current.push(piece);
    chars += piece.chars;
    blocks += piece.blocks;
    media += piece.media.length;
  }
  groups.push(current);
  return groups;
}
