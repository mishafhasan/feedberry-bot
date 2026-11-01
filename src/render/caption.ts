import { esc } from './plan.ts';

/**
 * §8.2 part 1: cut on a word boundary, never inside an HTML tag, and number every part only when
 * the text really was split (a single part never carries `(1/1)`).
 */
const SUFFIX_RESERVE = 8;

export function splitMessage(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];

  const budget = limit - SUFFIX_RESERVE;
  const parts: string[] = [];
  let rest = text;

  while (rest.length > budget) {
    const cut = cutIndex(rest, budget);
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length > 0) parts.push(rest);

  const total = parts.length;
  return parts.map((part, index) => `${part} (${index + 1}/${total})`);
}

/** The head of a caption that fits `limit`, markup intact; the caller adds the ellipsis. */
export function cutCaption(html: string, limit: number): string {
  if (html.length <= limit) return html;
  let cut = cutIndex(html, limit);
  let head = closed(html.slice(0, cut).trimEnd());
  // The tags a cut leaves open cost characters, so the cut moves left until the result fits.
  while (head.length > limit && cut > 0) {
    cut = cutIndex(html, cut - 1);
    head = closed(html.slice(0, cut).trimEnd());
  }
  return head;
}

const closed = (html: string): string => `${html}${closeOpenTags(html)}`;

/** Download Mode puts a whole caption inside one `<a>`, so a cut can end mid-element. */
function closeOpenTags(html: string): string {
  const open: string[] = [];
  for (const match of html.matchAll(/<\s*(\/?)([a-z0-9]+)\b[^>]*>/gi)) {
    const tag = (match[2] ?? '').toLowerCase();
    const at = open.lastIndexOf(tag);
    if (match[1]) {
      if (at >= 0) open.splice(at, 1);
    } else open.push(tag);
  }
  return open.reverse().map((tag) => `</${tag}>`).join('');
}

/** A cut lands on a word boundary and never inside an HTML tag. */
function cutIndex(text: string, limit: number): number {
  let cut = text.lastIndexOf(' ', limit);
  if (cut <= 0) cut = limit;
  const open = openTagIndex(text.slice(0, cut));
  return open > 0 ? open : cut;
}

/** Position of an unclosed `<` inside the slice, or -1 when the cut lands outside a tag. */
function openTagIndex(slice: string): number {
  const open = slice.lastIndexOf('<');
  return open > slice.lastIndexOf('>') ? open : -1;
}

/**
 * Every delivered post opens with where it came from and when the site published it, so a
 * forwarded post is traceable without opening it.
 */
export function postHeader(params: { sourceTitle: string | null; url: string | null; publishedAt: number | null; tz?: string }): string {
  const name = esc(params.sourceTitle ?? 'Source');
  const title = params.url ? `<a href="${esc(params.url)}">${name}</a>` : name;
  const when = params.publishedAt === null ? null : mmddhhmm(params.publishedAt, params.tz);
  return [`🌐 ${title}`, when === null ? null : `⏱️ Time: ${when}`].filter((line) => line !== null).join('\n');
}

/** `MM/DD HH:MM` in the given timezone (UTC until a user timezone is stored). */
export function mmddhhmm(ms: number, tz = 'UTC'): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(ms);
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? '--';
  return `${get('month')}/${get('day')} ${get('hour')}:${get('minute')}`;
}
