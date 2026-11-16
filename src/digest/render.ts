import { t } from '../bot/i18n/index.ts';
import { postHeader } from '../render/caption.ts';
import { esc, type MessagePlan } from '../render/message-plan.ts';
import type { DigestItem, DigestLang } from './summarise.ts';

/**
 * ADR-029: the digest message, pure. Facts and items in, one rich plan per part out; no I/O, no db,
 * no Telegram. The budgets sit under the Bot API's 50 media / 32 768 chars / 500 blocks.
 */
export const MAX_PART_MEDIA = 49;
export const MAX_PART_CHARS = 30_000;
export const MAX_PART_BLOCKS = 480;
/** Worst-case header and footer: reserved so a part can never be composed past the hard limits. */
const HEADER_CHARS = 400;
const HEADER_BLOCKS = 6;
const FOOTER_CHARS = 300;
const FOOTER_BLOCKS = 2;

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
  media: Array<{ id: string; file: string; kind: 'photo' | 'audio' }>;
  chars: number;
  blocks: number;
}

export function renderDigest(input: RenderInput): MessagePlan[] {
  if (input.items.length === 0) {
    const html = `${headerOf(input, 1, 1)}<p>${esc(t(input.lang, 'digest.empty'))}</p>`;
    return [{ kind: 'rich', html, media: [] }];
  }

  const pieces = input.items.map((item, index) => itemPiece(input, item, index + 1));
  const extra = extraPiece(input, input.items.length + 1);
  if (extra !== null) pieces.push(extra);

  const groups = pack(pieces);
  const total = groups.length;

  return groups.map((group, index) => {
    const part = index + 1;
    const last = part === total;
    const items = group.map((piece) => piece.html).join('');
    // The footer closes the digest, after the "Also today" list when there is one.
    const tail = last ? `<footer>${esc(t(input.lang, 'digest.footer', { posts: input.postCount }))}</footer>` : '';
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

  return { html, media, chars: html.length, blocks };
}

/** "Also today": the posts past the cost cap, as numbered headline links in the last part. */
function extraPiece(input: RenderInput, first: number): Piece | null {
  if (input.extra.length === 0) return null;
  const lines = input.extra.map((entry, index) => {
    const label = `${first + index}. ${esc(entry.headline)}`;
    return entry.url === null ? label : `<a href="${esc(entry.url)}">${label}</a>`;
  });
  const html = `<p><b>${esc(t(input.lang, 'digest.alsoToday'))}</b></p><ul>${lines.map((line) => `<li>${line}</li>`).join('')}</ul>`;
  return { html, media: [], chars: html.length, blocks: input.extra.length + 2 };
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
