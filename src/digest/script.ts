import type { DigestItem, DigestLang } from './summarise.ts';
import type { Gemini } from './gemini.ts';
import { LANGUAGE_REASKS, LANGUAGE_RETRY, languageRule, offLanguage } from './lang.ts';
import { log } from '../obs/log.ts';

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

export function scriptPrompt(input: ScriptInput, retry = false): string {
  const stories = input.items
    .map((item, index) => {
      const points = item.points.length === 0 ? '' : `\n${item.points.map((point) => `- ${point}`).join('\n')}`;
      return `${index + 1}. ${item.headline} (${item.sourceTitle ?? 'a blog'})\n${item.description}${points}`;
    })
    .join('\n\n');

  return [
    'You write the spoken script of a daily news digest, to be read aloud by a text-to-speech voice.',
    languageRule(input.lang),
    ...(retry ? [LANGUAGE_RETRY] : []),
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

/** A mixed script is asked again at most twice and then read as it is: a silent digest is worse. */
export async function writeScript(gemini: Gemini, input: ScriptInput, signal: AbortSignal): Promise<string> {
  let mixed = '';
  for (let reasks = 0; reasks <= LANGUAGE_REASKS; reasks++) {
    let script: string;
    try {
      script = (await gemini.text(scriptPrompt(input, reasks > 0), signal)).replace(/\r\n?/g, '\n').trim();
      if (script === '') throw new Error('gemini wrote an empty script');
    } catch (err) {
      // The re-ask must never cost the audio: a script already in hand is a voice, silence is not.
      if (mixed !== '') return mixed;
      throw err;
    }
    if (!offLanguage(input.lang, [script])) return script;
    mixed = script;
    log('warn', 'digest_script_language_mixed', { lang: input.lang, reasks });
  }
  return mixed;
}
