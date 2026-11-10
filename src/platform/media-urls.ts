/**
 * One ranking rule for every reader that meets a picture in HTML (ADR-021). A page and a feed spell
 * the same picture three ways — `srcset`, a lazy `data-src`, or a CSS background — so both readers
 * pick through the same function instead of growing their own half-rule.
 */

/** The widest *usable* candidate: `srcset` entries first, then `src`, which never outranks them. */
export function imageSource(srcset: string | null | undefined, src: string | null | undefined, baseUrl: string, page?: string): string | null {
  const candidates = [
    // Sites emit `240w,https://…` without a space, so each entry is checked on its own merits.
    ...(srcset ?? '').split(',').map((entry) => {
      const [url = '', descriptor = ''] = entry.trim().split(/\s+/);
      return { url, size: Number.parseFloat(descriptor) || 0 }; // 1536w and 1.5x both rank
    }),
    { url: src ?? '', size: -1 },
  ];

  let best: { url: string; size: number } | null = null;
  for (const candidate of candidates) {
    const usable = usableUrl(candidate.url, baseUrl, page);
    if (usable !== null && (best === null || candidate.size > best.size)) best = { url: usable, size: candidate.size };
  }
  return best?.url ?? null;
}

/** Every `url(…)` of a CSS `background`/`background-image`, in source order. */
export function backgroundImages(style: string | null | undefined): string[] {
  if (!style || !/background/i.test(style)) return [];
  return [...style.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/gi)].map((match) => match[1] ?? '');
}

export function usableUrl(raw: string, baseUrl: string, page?: string): string | null {
  // A fragment or a `data:` URI is not a file; whitespace resolves to the page itself.
  if (raw.trim() === '' || raw.trim().startsWith('#')) return null;
  try {
    const absolute = new URL(raw, baseUrl);
    if (!/^https?:$/.test(absolute.protocol) || /styles/i.test(absolute.pathname) || PLACEHOLDER.test(absolute.pathname)) return null;
    // Whitespace or `#` resolves to the article itself: hotlinking an HTML page is a broken picture.
    const href = absolute.href.replace(/#.*$/, '');
    if (page !== undefined && href === page) return null;
    return href;
  } catch {
    return null;
  }
}

/** Spacer files sites park in a slot before a script swaps the picture in. `blank`/`transparent` are real words, not signals. */
const PLACEHOLDER = /(?:^|\/)(?:grey-)?(?:placeholder|spacer|1x1)[^/]*\.(?:gif|png|jpe?g|webp|svg)$/i;
