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
