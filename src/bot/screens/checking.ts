import { s3Text } from '../texts.ts';
import type { Lang } from '../i18n/index.ts';

/** S3 has no keyboard: it is the bot's "working" line and is deleted when S4 or an error lands. */
export function checkingView(canonicalUrl: string, lang: Lang = 'en'): { text: string } {
  return { text: s3Text(canonicalUrl, lang) };
}
