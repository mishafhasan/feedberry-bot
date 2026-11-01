import assert from 'node:assert/strict';
import { test } from 'node:test';
import { supportedSitesText } from '../../src/bot/texts.ts';

const rowsOf = (lang: 'en' | 'ru'): string[] => supportedSitesText(lang).split('\n\n')[1]?.split('\n') ?? [];

test('S12: every row opens with its platform logo and keeps the description', () => {
  const rows = rowsOf('en');

  assert.equal(rows.length, 11, 'one row per platform in the §10 matrix');
  assert.ok(
    rows[0]?.startsWith('<tg-emoji emoji-id="6282825765729870159">📡</tg-emoji> Websites & blogs'),
    'the website row has its own logo now',
  );
  assert.equal(rows.filter((row) => row.startsWith('<tg-emoji emoji-id="')).length, 11, 'every row uses a custom emoji');
  assert.ok(
    rows[1]?.startsWith('<tg-emoji emoji-id="6282526363559666134">📸</tg-emoji> Instagram — profiles and posts'),
    'the dictionary emoji is replaced, not doubled',
  );
});

test('S12: the logos come from the platform order, not from the translated text', () => {
  const idsOf = (lang: 'en' | 'ru'): Array<string | undefined> =>
    rowsOf(lang).map((row) => /emoji-id="(\d+)"/.exec(row)?.[1]);

  assert.deepEqual(idsOf('ru'), idsOf('en'));
});
