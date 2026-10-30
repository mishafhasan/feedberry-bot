import { s3Text } from '../texts.ts';

/** S3 has no keyboard: it is the bot's "working" line and is deleted when S4 or an error lands. */
export function s3View(canonicalUrl: string): { text: string } {
  return { text: s3Text(canonicalUrl) };
}
