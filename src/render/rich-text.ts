import { esc } from './message-plan.ts';

/**
 * ADR-023: source text → Telegram rich HTML. Social captions are plain text with markdown-ish
 * habits, so blocks come from line prefixes and inline styles from the markdown set Telegram
 * renders; anything unrecognised stays escaped text. Every link is built here, never detected
 * by Telegram (`skip_entity_detection`).
 * shortcut: emphasis does not nest and markers inside a link label print literally — upgrade
 * when a real source needs nested styling.
 */
const FENCE = /^```(\w*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const QUOTE = /^((?:>\s?)+)(.*)$/;
const UL = /^(\s*)[-*•]\s+(.*)$/;
const OL = /^(\s*)\d{1,3}[.)]\s+(.*)$/;

const URL_RE = /https?:\/\/[^\s<>"']+/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE = /(?<![\w+])\+[1-9]\d{6,14}(?!\w)/g;
const EMOJI = /!\[([^\]]*)\]\((tg:\/\/emoji\?id=\d{1,32})\)/g;
const TIME = /!\[([^\]]*)\]\((tg:\/\/time\?[^)\s]+)\)/g;
const LINK = /\[([^\]]+)\]\(([^)\s]+)\)/g;

export function richBody(text: string): string {
  // Source text can arrive with CRLF (feeds, page meta); a stray \r would print inside the line.
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let prose: string[] = [];
  const flush = (): void => {
    // A blank line ends a paragraph: each one becomes its own <p>, blanks never print.
    const paragraphs: string[][] = [];
    let current: string[] = [];
    for (const line of prose) {
      if (line.trim() === '') {
        if (current.length > 0) paragraphs.push(current);
        current = [];
      } else current.push(line);
    }
    if (current.length > 0) paragraphs.push(current);
    for (const lines of paragraphs) out.push(`<p>${lines.map((line) => inline(line)).join('<br/>')}</p>`);
    prose = [];
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const code: string[] = [];
      i++;
      while (i < lines.length && lines[i] !== '```') {
        code.push(lines[i] ?? '');
        i++;
      }
      i++;
      const body = esc(code.join('\n'));
      out.push(fence[1] ? `<pre><code class="language-${fence[1]}">${body}</code></pre>` : `<pre>${body}</pre>`);
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      const size = heading[1]?.length ?? 1;
      out.push(`<h${size}>${inline(heading[2] ?? '')}</h${size}>`);
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      flush();
      const run: Array<{ depth: number; text: string }> = [];
      while (i < lines.length) {
        const match = QUOTE.exec(lines[i] ?? '');
        if (!match) break;
        run.push({ depth: (match[1] ?? '').replace(/\s/g, '').length, text: match[2] ?? '' });
        i++;
      }
      out.push(quote(run));
      continue;
    }
    if (UL.test(line) || OL.test(line)) {
      flush();
      const items: ListItem[] = [];
      while (i < lines.length) {
        const raw = lines[i] ?? '';
        const ul = UL.exec(raw);
        const ol = OL.exec(raw);
        const match = ul ?? ol;
        if (!match) break;
        items.push({ indent: (match[1] ?? '').replace(/\t/g, '  ').length, tag: ul ? 'ul' : 'ol', text: match[2] ?? '' });
        i++;
      }
      let cursor = 0;
      while (cursor < items.length) {
        const [html, next] = renderList(items, cursor);
        out.push(html);
        cursor = next;
      }
      continue;
    }
    prose.push(line);
    i++;
  }
  flush();
  return out.join('');
}

interface ListItem {
  indent: number;
  tag: 'ul' | 'ol';
  text: string;
}

/** One list block; deeper indents nest inside the item above, a tag change starts a sibling list. */
function renderList(items: ListItem[], start: number): [string, number] {
  const first = items[start];
  if (!first) return ['', start];
  const { indent, tag } = first;
  let html = `<${tag}>`;
  let i = start;
  while (i < items.length && items[i]?.indent === indent && items[i]?.tag === tag) {
    html += `<li>${inline(items[i]?.text ?? '')}`;
    i++;
    while (i < items.length && (items[i]?.indent ?? 0) > indent) {
      const [nested, next] = renderList(items, i);
      html += nested;
      i = next;
    }
    html += '</li>';
  }
  return [`${html}</${tag}>`, i];
}

/** Single and nested blockquotes: a deeper `>` run becomes a blockquote inside the current one. */
function quote(run: Array<{ depth: number; text: string }>): string {
  let i = 0;
  const walk = (depth: number): string => {
    const parts: string[] = [];
    while (i < run.length && (run[i]?.depth ?? 0) >= depth) {
      const item = run[i];
      if (!item) break;
      if (item.depth > depth) {
        parts.push(`<blockquote>${walk(item.depth)}</blockquote>`);
        continue;
      }
      parts.push(inline(item.text));
      i++;
    }
    return parts.join('<br/>');
  };
  return `<blockquote>${walk(1)}</blockquote>`;
}

/** The "Show more" preview: the first four paragraphs, about 500 characters. */
export const PREVIEW_PARAGRAPHS = 4;
export const PREVIEW_CHARS = 500;

/**
 * The preview for a long post: whole paragraphs only, so a cut never lands mid-sentence.
 * It keeps at least one paragraph and the one that crosses the budget; a title followed by one
 * huge body paragraph therefore shows both (the body counts as the post's first paragraph).
 */
export function truncateParagraphs(text: string, maxParagraphs = PREVIEW_PARAGRAPHS, maxChars = PREVIEW_CHARS): string {
  const paragraphs = text.split(/\n{2,}/).filter((paragraph) => paragraph.trim() !== '');
  const kept: string[] = [];
  let chars = 0;
  for (const paragraph of paragraphs) {
    if (kept.length >= maxParagraphs) break;
    kept.push(paragraph);
    chars += paragraph.length;
    if (chars >= maxChars) break;
  }
  return kept.join('\n\n');
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