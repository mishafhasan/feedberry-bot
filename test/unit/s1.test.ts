import assert from 'node:assert/strict';
import { test } from 'node:test';
import { s1Text } from '../../src/bot/texts.ts';

const body = s1Text({ userId: 853964716, sourceCount: 8, limit: 250, trialEnabled: false });

test('S1: every section is separated by one blank line, not by paragraph spacing', () => {
  assert.ok(body.startsWith('<p><b>FeedBerry</b>'), 'the message is one paragraph');
  assert.match(body, /Telegram\.<br\/><br\/>🆔 Your ID: 853964716/, 'title → account block');
  assert.match(body, /Sources: 8 \/ 250<br\/><br\/><b>Features<\/b>:/, 'account block → features');
  assert.match(body, /\(Coming Soon\)<br\/><br\/><b>How to use<\/b>:/, 'features → how to use');
  assert.doesNotMatch(body, /<br\/><br\/><br\/>/, 'never two blank lines');
});

test('S1: the trial line rides inside the account block, and markers stay bold', () => {
  const trial = s1Text({ userId: 1, sourceCount: 0, limit: 250, trialEnabled: true });
  assert.match(trial, /Plan: Free<br\/>🕐 Trial ends: —<br\/>📊 Sources: 0 \/ 250<br\/><br\/><b>Features<\/b>:/, 'the trial line does not split the section');
  assert.match(trial, /<b>Features<\/b>:/, 'the bold markers are converted');
});
