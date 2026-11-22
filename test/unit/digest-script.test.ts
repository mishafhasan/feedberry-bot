/**
 * ADR-033's spoken script: the language re-ask must never cost the audio — a mixed script already in
 * hand is returned when a later call fails.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Gemini } from '../../src/digest/gemini.ts';
import { writeScript, type ScriptInput } from '../../src/digest/script.ts';

const input: ScriptInput = {
  lang: 'ta',
  date: 'Sun, 22 Nov 2026',
  items: [{ headline: 'புதிய திட்டம்', description: 'இது ஒரு திட்டம்.', points: [], sourceTitle: 'Blog' }],
};

const geminiWith = (answers: Array<string | Error>): { gemini: Gemini; calls: () => number } => {
  let calls = 0;
  return {
    calls: () => calls,
    gemini: {
      async json() {
        throw new Error('no json in a script test');
      },
      async speak() {
        throw new Error('no speech in a script test');
      },
      async text() {
        const answer = answers[Math.min(calls++, answers.length - 1)];
        if (answer instanceof Error) throw answer;
        return answer ?? '';
      },
    },
  };
};

test('a mixed script is asked for twice more and then read as it is', async () => {
  const { gemini, calls } = geminiWith(['Puthiya thittam arimugam']);
  assert.equal(await writeScript(gemini, input, new AbortController().signal), 'Puthiya thittam arimugam');
  assert.equal(calls(), 3, 'the script plus two re-asks');
});

test('a failure on the re-ask keeps the script the first call produced', async () => {
  const { gemini, calls } = geminiWith(['Puthiya thittam arimugam', new Error('gemini down')]);
  assert.equal(await writeScript(gemini, input, new AbortController().signal), 'Puthiya thittam arimugam', 'a mixed script beats a silent digest');
  assert.equal(calls(), 2);
});

test('a first call that fails still throws: there is no script to read', async () => {
  const { gemini } = geminiWith([new Error('gemini down')]);
  await assert.rejects(writeScript(gemini, input, new AbortController().signal), /gemini down/);
});
