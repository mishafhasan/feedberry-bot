import type { DigestLang } from './summarise.ts';

/** How many times a mixed answer is asked again before it ships as it is (ADR-033). */
export const LANGUAGE_REASKS = 2;

/** The prompt sentence the check below enforces. */
export function languageRule(lang: DigestLang): string {
  return lang === 'ta'
    ? 'Write in simple, everyday spoken Tamil, in Tamil script (தமிழ் எழுத்து): every Tamil word in Tamil letters, never romanised. Use English letters only for names, brands, products and technical terms.'
    : 'Write in simple, everyday English, in English letters only: no Tamil and no other script.';
}

/** Appended to a re-ask, so the model knows what it broke rather than being asked again unchanged. */
export const LANGUAGE_RETRY = 'Your previous answer broke that language rule. Rewrite it so every sentence follows it.';

const TAMIL = /[\u0B80-\u0BFF]/g;
const LATIN = /[A-Za-z]/g;

/**
 * ADR-033: the trust boundary's language check. Tanglish — Tamil written in Latin letters — has no
 * Tamil script at all and scores zero here, which is the failure that reached the chat. A Tamil
 * summary with English brand names still sits far above the floor (~0.55), and a false positive costs
 * one re-ask, never the summary.
 */
export function offLanguage(lang: DigestLang, texts: Array<string | null | undefined>): boolean {
  const text = texts.filter((value): value is string => typeof value === 'string').join(' ');
  const tamil = text.match(TAMIL)?.length ?? 0;
  const letters = tamil + (text.match(LATIN)?.length ?? 0);
  if (letters === 0) return false;
  return lang === 'en' ? tamil > 0 : tamil / letters < 0.2;
}
