/**
 * ADR-033's language boundary: Tamil means Tamil script with English brands, never Tanglish; English
 * means English with no Tamil at all.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { offLanguage } from '../../src/digest/lang.ts';

test('offLanguage: a Tamil headline with English brands passes, Tanglish does not', () => {
  assert.equal(offLanguage('ta', ['Dreamteam $53M நிதி திரட்டியது: AI-native CRM சந்தையில் புதிய போட்டி']), false, 'the shape ADR-029 already shipped');
  assert.equal(offLanguage('ta', ['புதிய GPU திட்டம்', 'இது ஒரு திட்டம்.']), false);
  assert.equal(offLanguage('ta', ['Puthiya GPU thittam arimugam', 'Ithu oru thittam.']), true, 'Tanglish has no Tamil script at all');
  assert.equal(offLanguage('ta', ['OpenAI launches a new model']), true, 'an English summary is not a Tamil one');
});

test('offLanguage: an English summary carrying Tamil script is rejected', () => {
  assert.equal(offLanguage('en', ['OpenAI நிறுவனம் launched a new model']), true);
  assert.equal(offLanguage('en', ['OpenAI launched a new model, the company said.']), false);
  assert.equal(offLanguage('en', ['']), false, 'nothing to judge');
  assert.equal(offLanguage('en', [null, undefined]), false);
});
