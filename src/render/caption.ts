import type { Platform } from '../platform/registry.ts';
import { platformIcon } from '../platform/icons.ts';
import { esc } from './message-plan.ts';

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
 * TikTok hands its caption back with the line breaks flattened, so a numbered list arrives as
 * "1. … 2. … 3. …" on one line. Put the breaks back when the pattern repeats.
 * The same flattening glues the closing CTA and hashtags to the last item ("… — Temporary email
 * Save this. … 🔖 #ai …"); give those their own lines so the final paragraphs survive.
 * shortcut: the marker alone decides (three or more `n. ` mid-sentence); the CTA list is the
 * common social verbs and only a lowercase→Capital glue splits — a footer worded differently
 * stays on the last item.
 */
export function breakNumberedList(text: string): string {
  const markers = text.match(/(?<=\S) (?=\d{1,3}\. )/g);
  if (markers === null || markers.length < 3) return text;
  const lines = text.replace(/(?<=\S) (?=\d{1,3}\. )/g, '\n').split('\n');
  const last = lines.length - 1;
  if (last >= 0) lines[last] = splitFlattenedTail(lines[last] ?? '');
  return lines.join('\n');
}

// "Temporary email Save this." — the CTA is glued to the last description by a space.
const CTA_TAIL = /(?<=[a-z]) (?=(?:Save|Follow|Like|Share|Comment|Bookmark|Subscribe|Remember|Keep|Tap|Click)\b)/;
// "… later. 🔖 #ai #tools" — a trailing hashtag block (optional emoji marker) gets its own line.
const HASHTAG_TAIL = / (?=(?:[\p{Extended_Pictographic}\uFE0F]+\s*)?(?:#[\p{L}\p{N}_]+\s*)+$)/u;

function splitFlattenedTail(line: string): string {
  // The hashtag block was its own line (blank line before it), so it becomes its own paragraph.
  return line.replace(CTA_TAIL, '\n').replace(HASHTAG_TAIL, '\n\n');
}

/**
 * Every delivered post opens with where it came from and when the site published it, so a
 * forwarded post is traceable without opening it. The platform is what the *source* is, not what
 * its URL spells: a blog on a custom domain is still RSS.
 *
 * The rich layout (ADR-025) returns blocks: the source line is a heading, the time its own line.
 * The classic layout returns `\n`-joined text, which its senders turn into `<br/>`.
 */
export function postHeader(params: { sourceTitle: string | null; url: string | null; publishedAt: number | null; platform: string; tz?: string; rich?: boolean }): string {
  const name = esc(sourceName(params.sourceTitle ?? 'Source', params.platform));
  const title = params.url ? `<a href="${esc(params.url)}">${name}</a>` : name;
  const line = `${title} | ${esc(platformLabel(params.platform))}`;
  const { publishedAt, tz } = params;

  if (params.rich !== true) {
    const when = publishedAt === null ? null : mmddhhmm(publishedAt, tz);
    return [`🌐 ${line}`, when === null ? null : `⏱️ Time: ${when}`].filter((text) => text !== null).join('\n');
  }

  // `<tg-time>` would print the client's own locale format; the layout asks for DD/MM HH:MM, and an
  // absolute stamp has nothing to tick, so the reader's zone decides the string instead.
  const time = publishedAt === null ? '' : `<p>⏱️ <b>Time</b>: ${ddmmhhmm(publishedAt, tz)}</p>`;
  return `<h5>${platformIcon(params.platform)} ${line}</h5>${time}`;
}

/** The display name of a source platform, for every screen that names one: post header, source list. */
export function platformLabel(platform: string): string {
  // The row stores the platform as text; an unknown one prints as it arrived rather than dropping the label.
  // `hasOwn` keeps a value like `constructor` off the prototype chain.
  return Object.hasOwn(PLATFORM_LABEL, platform) ? PLATFORM_LABEL[platform as Platform] : platform;
}

/**
 * A source's own name, without the platform the label already prints. RSSHub titles a channel
 * "… - Instagram", "… on Threads", "… - Profile | Pinterest"; X's route prefixes "Twitter @handle".
 * shortcut: text matching only; an account whose real name ends in its own platform word loses the tail.
 */
export function sourceName(title: string, platform: string): string {
  const label = platformLabel(platform).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const decorated = new RegExp(`\\s*(?:[|·—–-]|\\bon\\b)\\s*(?:Profile\\s*[|·—–-]\\s*)?${label}\\s*$`, 'i');
  const bare = (platform === 'x' ? title.replace(/^Twitter\s+/i, '') : title).replace(decorated, '').trim();
  return bare === '' ? title : bare;
}

/** A platform missing here is a type error, so no source type can ship without its label. */
const PLATFORM_LABEL: Record<Platform, string> = {
  rss: 'RSS',
  instagram: 'Instagram',
  facebook: 'Facebook',
  threads: 'Threads',
  youtube: 'YouTube',
  tiktok: 'TikTok',
  x: 'X',
  tumblr: 'Tumblr',
  pinterest: 'Pinterest',
  bluesky: 'Bluesky',
  telegram: 'Telegram',
  snapchat: 'Snapchat',
};

/** `MM/DD HH:MM` in the given timezone (UTC until a user timezone is stored). */
export function mmddhhmm(ms: number, tz = 'UTC'): string {
  return timeLine(ms, tz, false);
}

/** `DD/MM HH:MM` — the rich header's day-first absolute time in the reader's zone. */
export function ddmmhhmm(ms: number, tz = 'UTC'): string {
  return timeLine(ms, tz, true);
}

function timeLine(ms: number, tz: string, dayFirst: boolean): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(ms);
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? '--';
  const date = dayFirst ? `${get('day')}/${get('month')}` : `${get('month')}/${get('day')}`;
  return `${date} ${get('hour')}:${get('minute')}`;
}
