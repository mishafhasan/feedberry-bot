import type { DigestItem, DigestLang } from './summarise.ts';
import type { Gemini } from './gemini.ts';

/**
 * The spoken script of the digest (ADR-029): the radio-host read of the items, in digest order.
 * It is written from the summaries, never from the articles, so the audio and the message agree.
 */
export interface ScriptInput {
  lang: DigestLang;
  date: string;
  items: Array<Pick<DigestItem, 'headline' | 'description' | 'points' | 'sourceTitle'>>;
}

/** A ten-minute ceiling; 80 words open it and each story gets 45. */
export function scriptWordBudget(items: number): number {
  return Math.min(80 + 45 * items, 1400);
}

export function scriptPrompt(input: ScriptInput): string {
  const language =
    input.lang === 'ta'
      ? 'Write in simple, everyday spoken Tamil. Keep names, brands, products and technical terms in English.'
      : 'Write in simple, everyday spoken English.';
  const stories = input.items
    .map((item, index) => {
      const points = item.points.length === 0 ? '' : `\n${item.points.map((point) => `- ${point}`).join('\n')}`;
      return `${index + 1}. ${item.headline} (${item.sourceTitle ?? 'a blog'})\n${item.description}${points}`;
    })
    .join('\n\n');

  return [
    'You write the spoken script of a daily news digest, to be read aloud by a text-to-speech voice.',
    language,
    `Length: at most ${scriptWordBudget(input.items.length)} words.`,
    `Open with one sentence that names the date (${input.date}) and how many stories follow.`,
    'Then one short paragraph per story, in this order. Move from one to the next with words like "First", "Next", "Finally"; never numbers or lists.',
    'For each story use its headline and at most four sentences built from its description and key points. Do not invent facts.',
    'Close with one short sign-off sentence that names FeedBerry.',
    'Plain spoken text only: no markdown, no URLs, no emoji, no bullet points, no stage directions.',
    '',
    'Stories:',
    stories,
  ].join('\n');
}

export async function writeScript(gemini: Gemini, input: ScriptInput, signal: AbortSignal): Promise<string> {
  const script = (await gemini.text(scriptPrompt(input), signal)).replace(/\r\n?/g, '\n').trim();
  if (script === '') throw new Error('gemini wrote an empty script');
  return script;
}
