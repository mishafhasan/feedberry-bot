import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contentTypePickerView } from '../../src/bot/screens/content-type-picker.ts';

/** S18 is one rich body: three stateful chips, the honest summary, two actions, and Back below. */
test('S18 picker: the chips carry the state, not a second checklist', () => {
  const view = contentTypePickerView({ handle: '@crocodilecrisis', selected: ['post'] });

  assert.match(view.html, /What should @crocodilecrisis send here\?/);
  assert.match(view.html, /data="ct:t:video">Videos<\/tg-button>/, 'an unselected chip carries no check');
  assert.match(view.html, /style="primary" data="ct:t:post">✓ Posts<\/tg-button>/, 'the selected one has the accent and a check');
  assert.match(view.html, /Sends: Posts/, 'the summary is the contract, spelled once');
  assert.match(view.html, /data="ct:all"/);
  assert.equal(view.html.match(/<tg-button-row/g)?.length, 2, 'three choices and the All preset are two rows, not six buttons');
  // Done closes the screen, so it is the keyboard row directly above Back.
  assert.deepEqual(view.keyboard.inline_keyboard, [
    [{ text: '✅ Done', callback_data: 'ct:done' }],
    [{ text: '← Back', callback_data: 'ct:back' }],
  ]);
});

test('S18 picker: the summary follows the selection, and the handle is escaped', () => {
  assert.match(contentTypePickerView({ handle: 'a&b', selected: ['video', 'short'] }).html, /Sends: Videos, Shorts/);
  assert.match(contentTypePickerView({ handle: 'a&b', selected: ['video', 'short'] }).html, /a&amp;b/, 'a handle is HTML-escaped');
  assert.match(contentTypePickerView({ handle: '@x', selected: ['video', 'short', 'post'] }).html, /Sends: Videos, Shorts, Posts/);
  assert.equal(contentTypePickerView({ handle: '@x', selected: ['short'] }).html.match(/style="primary" data="ct:t:/g)?.length, 1, 'one accent per selection');
});
