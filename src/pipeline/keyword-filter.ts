/**
 * Keyword filter (ADR-020): a subscription hears only the posts its list names.
 * Substring, case-insensitive, any-of. No tokenising and no stemming on purpose — "ai" also matches
 * "said", which is the known cost of a filter that can run on a 4 000-character body in microseconds.
 */
export interface FilterText {
  title: string;
  summary: string | null;
  /** `<category>` tags; only the feed dialects that carry them fill this in. */
  categories?: string[] | null;
}

/** `AI, Telegram ,,` → `['AI', 'Telegram']`. The spelling the user typed is kept for the screen. */
export function parseKeywords(raw: string | null | undefined): string[] {
  const seen = new Map<string, string>();
  for (const part of (raw ?? '').split(',')) {
    const word = part.trim();
    if (word !== '') seen.set(word.toLowerCase(), seen.get(word.toLowerCase()) ?? word);
  }
  return [...seen.values()];
}

/** The stored form; an empty list is NULL, which is what makes the user default apply. */
export function formatKeywords(keywords: string[]): string | null {
  return keywords.length === 0 ? null : keywords.join(',');
}

/** A row's own list wins; NULL falls back to the user's default (ADR-020). */
export function effectiveKeywords(own: string | null, fallback: string | null): string[] {
  const keywords = parseKeywords(own);
  return keywords.length > 0 ? keywords : parseKeywords(fallback);
}

/** Any keyword found in the title, the body or a tag lets the post through. */
export function passesFilter(item: FilterText, keywords: string[]): boolean {
  const words = keywords.map((keyword) => keyword.trim().toLowerCase()).filter((keyword) => keyword !== '');
  // A list of blanks is no list: it must not silently mute a source.
  if (words.length === 0) return true;
  const haystack = [item.title, item.summary ?? '', ...(item.categories ?? [])].join('\n').toLowerCase();
  return words.some((keyword) => haystack.includes(keyword));
}
