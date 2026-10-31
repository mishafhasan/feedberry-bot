import assert from 'node:assert/strict';
import { test } from 'node:test';
import { supportedSitesText } from '../../src/bot/texts.ts';

const rowsOf = (lang: 'en' | 'ru'): string[] => supportedSitesText(lang).split('\n\n')[1]?.split('\n') ?? [];

test('S12: every row opens with its platform logo and keeps the description', () => {
  const rows = rowsOf('en');

  assert.equal(rows.length, 11, 'one row per platform in the §10 matrix');
  assert.ok(rows[0]?.startsWith('📡 Websites & blogs'), 'RSS has no logo in the pack, so it keeps the emoji');
  assert.equal(rows.filter((row) => row.startsWith('<tg-emoji emoji-id="')).length, 10, 'the other ten use custom emoji');
  assert.ok(
    rows[1]?.startsWith('<tg-emoji emoji-id="5355097780228470775">📸</tg-emoji> Instagram — profiles and posts'),
    'the dictionary emoji is replaced, not doubled',
  );
});

test('S12: the logos come from the platform order, not from the translated text', () => {
  assert.equal(rowsOf('ru').filter((row) => row.startsWith('<tg-emoji emoji-id="')).length, 10);
});
