import { esc } from './message-plan.ts';

/**
 * ADR-025: source text → the inline RichText of a post's expandable quote. Social captions are plain
 * text with markdown-ish habits, so inline styles come from the markdown set Telegram renders, and
 * every block marker is flattened to its inline meaning — a quote takes inline RichText only, and
 * one block child (a heading, a list, a `<pre>`) silently costs the client's collapse control.
 * Every link is built here, never detected by Telegram (`skip_entity_detection`).
 * shortcut: emphasis does not nest and markers inside a link label print literally — upgrade when a
 * real source needs nested styling.
 */
const FENCE = /^```(\w*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const QUOTE = /^((?:>\s?)+)(.*)$/;
const UL = /^(\s*)[-*•]\s+(.*)$/;

const URL_RE = /https?:\/\/[^\s<>"']+/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE = /(?<![\w+])\+[1-9]\d{6,14}(?!\w)/g;
const EMOJI = /!\[([^\]]*)\]\((tg:\/\/emoji\?id=\d{1,32})\)/g;
const TIME = /!\[([^\]]*)\]\((tg:\/\/time\?[^)\s]+)\)/g;
const LINK = /\[([^\]]+)\]\(([^)\s]+)\)/g;

/**
 * The whole post as one `<blockquote expandable>`: the client shows its own collapsed height and one
 * tap reveals the rest, with no bot state and nothing left outside the fold. Line breaks stay
 * `<br/>` because Telegram collapses a raw newline, and every value is escaped by `inline`.
 */
export function expandableQuote(text: string): string {
  // A post with no words (media only) gets no quote at all, rather than an empty one.
  const body = text.replace(/\r\n?/g, '\n').trim();
  if (body === '') return '';
  const lines = body.split('\n').map(inlineLine);
  // A blank line separates paragraphs, but a run of them must not open a growing gap, and a fence
  // line dropped at either edge must not leave an empty first or last line.
  const html = lines.join('<br/>').replace(/(?:<br\/>){3,}/g, '<br/><br/>').replace(/^(?:<br\/>)+|(?:<br\/>)+$/g, '');
  return `<blockquote expandable>${html}</blockquote>`;
}

/** One source line as inline RichText: block markers flattened, values escaped, links kept. */
function inlineLine(line: string): string {
  // A spaces-only line is a paragraph gap, not a line of invisible spaces.
  if (line.trim() === '') return '';
  const heading = HEADING.exec(line);
  if (heading) return `<b>${inline(heading[2] ?? '')}</b>`;
  // The fence itself would print as ```; the code inside stays plain text.
  if (FENCE.test(line)) return '';
  return inline(line.replace(QUOTE, '$2').replace(UL, '$1• $2'));
}

/** Inline styles and links; everything that is not a recognised token is escaped text. */
function inline(raw: string): string {
  const stash: string[] = [];
  const keep = (html: string): string => `\u0000${stash.push(html) - 1}\u0000`;
  let s = raw.replace(/`([^`\n]+)`/g, (_, code: string) => keep(`<code>${esc(code)}</code>`));
  s = s.replace(EMOJI, (whole, alt: string, url: string) => {
    const id = /id=(\d{1,32})/.exec(url)?.[1];
    return id ? keep(`<tg-emoji emoji-id="${id}">${esc(alt)}</tg-emoji>`) : whole;
  });
  s = s.replace(TIME, (whole, label: string, url: string) => {
    const unix = /unix=(\d{1,12})/.exec(url)?.[1];
    const format = /format=([wrdDtT]+)/.exec(url)?.[1] ?? '';
    return unix && /^(r|w?[dD]?[tT]?)$/.test(format) ? keep(`<tg-time unix="${unix}" format="${format}">${esc(label)}</tg-time>`) : whole;
  });
  s = s.replace(LINK, (whole, label: string, url: string) => {
    const href = safeHref(url);
    return href ? keep(`<a href="${attr(href)}">${esc(label)}</a>`) : whole;
  });
  s = s.replace(URL_RE, (url: string) => {
    const clean = url.replace(/[.,!?;:)\]]+$/, '');
    const tail = url.slice(clean.length);
    return keep(`<a href="${attr(clean)}">${esc(clean)}</a>`) + tail;
  });
  s = s.replace(EMAIL, (mail: string) => keep(`<a href="mailto:${attr(mail)}">${esc(mail)}</a>`));
  s = s.replace(PHONE, (phone: string) => keep(`<a href="tel:${phone.replace(/[^\d+]/g, '')}">${esc(phone)}</a>`));
  s = esc(s)
    .replace(/\*\*(\S(?:[\s\S]*?\S)?)\*\*/g, '<b>$1</b>')
    .replace(/__(\S(?:[\s\S]*?\S)?)__/g, '<b>$1</b>')
    .replace(/(^|[^*])\*(\S(?:[^*]*?\S)?)\*(?!\*)/g, '$1<i>$2</i>')
    .replace(/(^|[^_\w])_(\S(?:[^_]*?\S)?)_(?!_)/g, '$1<i>$2</i>')
    .replace(/\+\+(\S(?:[^+]*?\S)?)\+\+/g, '<u>$1</u>')
    .replace(/~~(\S(?:[^~]*?\S)?)~~/g, '<s>$1</s>')
    .replace(/\|\|(\S(?:[^|]*?\S)?)\|\|/g, '<tg-spoiler>$1</tg-spoiler>')
    .replace(/==(\S(?:[^=]*?\S)?)==/g, '<mark>$1</mark>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, index: string) => stash[Number(index)] ?? '');
}

/** Only the link schemes Telegram renders as links; everything else stays plain text. */
function safeHref(value: string): string | null {
  try {
    const url = new URL(value);
    if (!/^(https?|mailto|tel):$/.test(url.protocol)) return null;
    if (url.protocol === 'mailto:' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.slice(7))) return null;
    if (url.protocol === 'tel:' && !/^\+?[\d ().-]{6,20}$/.test(value.slice(4))) return null;
    return url.href;
  } catch {
    return null;
  }
}

/** Attribute-safe escape: `esc` covers `& < >`, the quote is what closes an href. */
const attr = (value: string): string => esc(value).replace(/"/g, '&quot;');
