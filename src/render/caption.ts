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
    let cut = rest.lastIndexOf(' ', budget);
    if (cut <= 0) cut = budget;
    const open = openTagIndex(rest.slice(0, cut));
    if (open > 0) cut = open;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length > 0) parts.push(rest);

  const total = parts.length;
  return parts.map((part, index) => `${part} (${index + 1}/${total})`);
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
