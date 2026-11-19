/**
 * The Settings hub replaced the main-menu Help button, and the timezone picker is the only writer of
 * `users.tz`. These are the parts a reader can get wrong without any other test noticing.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { InlineKeyboard } from 'grammy';
import { s1Keyboard, settingsKeyboard, timezoneKeyboard, TIMEZONES } from '../../src/bot/keyboards.ts';
import { settingsView, timezoneView } from '../../src/bot/screens/static-screens.ts';

const rowsOf = (keyboard: InlineKeyboard): string[][] =>
  keyboard.inline_keyboard.map((row) => row.map((button) => ('callback_data' in button ? button.callback_data : '')));

const callbacksOf = (keyboard: InlineKeyboard): string[] => rowsOf(keyboard).flat();

const labelsOf = (keyboard: InlineKeyboard): string[] => keyboard.inline_keyboard.flatMap((row) => row.map((button) => button.text));

test('settings: the main menu offers Settings where Help used to sit, without growing', () => {
  // The digest button shares the last row, so it adds a button but never a row.
  for (const [digest, buttons] of [[false, 7], [true, 8]] as const) {
    const rows = rowsOf(s1Keyboard('en', digest));
    assert.ok(rows.flat().includes('menu:settings'), 'Settings took the Help slot');
    assert.ok(!rows.flat().includes('menu:help'), 'no standalone Help left on S1');
    assert.equal(rows.flat().length, buttons, `buttons (digest: ${digest})`);
    assert.equal(rows.length, 4, `rows (digest: ${digest})`);
  }
});

test('settings: the hub reaches Help, About and the timezone picker', () => {
  assert.deepEqual(callbacksOf(settingsKeyboard('en')), ['set:help', 'set:about', 'set:tz', 'nav:home']);
});

test('settings: the picker marks the current zone, has no blank row, and returns to the hub', () => {
  const keyboard = timezoneKeyboard('Asia/Colombo', 'en');
  assert.equal(callbacksOf(keyboard)[0], 'tz:Asia/Colombo', 'Sri Lanka is the first choice');

  const marked = labelsOf(keyboard).filter((label) => label.startsWith('✅'));
  assert.equal(marked.length, 1, 'exactly one zone is marked');
  assert.match(marked[0] ?? '', /Sri Lanka/);

  assert.ok(rowsOf(keyboard).every((row) => row.length > 0), 'a trailing row break would leave a blank row');
  assert.deepEqual(rowsOf(keyboard).at(-1), ['menu:settings']);
});

test('settings: an off-list zone is shown as the current one rather than silently unmarked', () => {
  const keyboard = timezoneKeyboard('Europe/Kyiv', 'en');
  assert.equal(labelsOf(keyboard).filter((label) => label.startsWith('✅')).length, 0);
  assert.match(timezoneView('Europe/Kyiv').text, /Europe\/Kyiv/, 'the lead still names the stored zone');
});

test('settings: every offered zone is real, unique, and fits a callback payload', () => {
  const seen = new Set<string>();
  for (const entry of TIMEZONES) {
    // A typo here is not cosmetic: Intl throws inside the scheduler tick, for every user, every tick.
    assert.doesNotThrow(() => new Intl.DateTimeFormat('en', { timeZone: entry.zone }), entry.zone);
    assert.ok(!seen.has(entry.zone), `duplicate zone ${entry.zone}`);
    seen.add(entry.zone);
    assert.ok(Buffer.byteLength(`tz:${entry.zone}`) <= 64, `callback payload too long: ${entry.zone}`);
  }
  assert.equal(TIMEZONES[0]?.zone, 'Asia/Colombo', 'the reported zone comes first');
});

test('settings: the hub and the picker both name the zone the user is on', () => {
  assert.match(settingsView('Asia/Colombo').text, /🌍 Timezone: Asia\/Colombo/);
  assert.match(timezoneView('Asia/Colombo').text, /Asia\/Colombo/);
});
