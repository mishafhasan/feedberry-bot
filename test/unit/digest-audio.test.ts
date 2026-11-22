/**
 * ADR-029's audio: the chunker never exceeds the TTS input budget and never cuts inside a word, the
 * duration is derived from the PCM, and a failure costs the player only.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { hasFFmpeg } from 'cobalt-engine';
import { AUDIO_CHUNK_CHARS, audioOverview, chunkScript, ffmpegEncode, secondsOf, SPEECH_RATE } from '../../src/digest/audio.ts';
import type { Gemini } from '../../src/digest/gemini.ts';
import { Coded, E } from '../../src/platform/errors.ts';

const words = (text: string): string[] => text.split(/\s+/).filter((word) => word !== '');

const geminiWith = (speak: (text: string) => Promise<Buffer>, spoken: string[] = []): Gemini => ({
  async json() {
    throw new Error('no json in an audio test');
  },
  async text() {
    throw new Error('no text in an audio test');
  },
  speak: (text) => {
    spoken.push(text);
    return speak(text);
  },
});

test('chunkScript: every chunk fits the model and no word is cut', () => {
  const sentence = 'This is a story about a small robot that learned to cook for its friends.';
  const text = Array.from({ length: 120 }, () => sentence).join(' ');
  const chunks = chunkScript(text);

  assert.ok(chunks.length >= 2, 'a 9 k-character script needs two calls');
  for (const chunk of chunks) {
    assert.ok(chunk.length <= AUDIO_CHUNK_CHARS, `chunk of ${chunk.length} chars`);
    assert.equal(chunk, chunk.trim());
  }
  assert.deepEqual(chunks.flatMap(words), words(text), 'the voice reads every word exactly once');
});

test('chunkScript: short paragraphs stay together, a Tamil script splits the same way', () => {
  assert.deepEqual(chunkScript('One.\n\nTwo.'), ['One.\n\nTwo.']);

  const tamil = 'இது ஒரு சிறிய கதை, இது ஒரு பெரிய உலகம். '.repeat(300);
  const chunks = chunkScript(tamil);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.ok(chunk.length <= AUDIO_CHUNK_CHARS);
  assert.deepEqual(chunks.flatMap(words), words(tamil));
});

test('chunkScript: one long sentence without a full stop is cut on spaces', () => {
  const text = Array.from({ length: 1_600 }, () => 'word').join(' ');
  const chunks = chunkScript(text);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.ok(chunk.length <= AUDIO_CHUNK_CHARS);
  assert.deepEqual(chunks.flatMap(words), words(text));
});

test('secondsOf: 24 kHz, 16-bit, mono', () => {
  assert.equal(secondsOf(24_000 * 2 * 90), 90);
  assert.equal(secondsOf(0), 0);
});

test('audioOverview: chunks are spoken in order and the duration comes from the PCM', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-digest-audio-'));
  const spoken: string[] = [];
  try {
    const gemini = geminiWith(async () => Buffer.alloc(24_000 * 2), spoken);
    const script = Array.from({ length: 60 }, () => 'A short sentence about the news of the day.').join(' ');
    const overview = await audioOverview(gemini, script, dir, 'FeedBerry Daily Digest · test', new AbortController().signal, (pcm, file) => writeFile(file, pcm));

    assert.ok(overview);
    assert.equal(spoken.length, chunkScript(script).length, 'one call per chunk');
    assert.ok(Math.abs((overview?.seconds ?? 0) - spoken.length / SPEECH_RATE) < 1e-9, 'one second of PCM per chunk, played 10% faster');
    assert.ok(statSync(overview?.file ?? '').size > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('audioOverview: a failed voice returns null instead of throwing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-digest-audio-'));
  try {
    const gemini = geminiWith(async () => {
      throw new Error('TTS down');
    });
    const overview = await audioOverview(gemini, 'A script.', dir, 'title', new AbortController().signal, (pcm, file) => writeFile(file, pcm));
    assert.equal(overview, null);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('audioOverview: a payload the voice rejects is retried at half its size', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-digest-audio-'));
  const spoken: string[] = [];
  try {
    const gemini = geminiWith(async (text) => {
      if (text.length > 3_000) throw new Coded(E.FEED_DOWN, 'gemini 400: input too long');
      return Buffer.alloc(24_000 * 2);
    }, spoken);
    const script = Array.from({ length: 190 }, () => 'A short sentence about the news of the day.').join(' ');
    const overview = await audioOverview(gemini, script, dir, 'title', new AbortController().signal, (pcm, file) => writeFile(file, pcm));

    assert.ok(overview);
    assert.ok(spoken.length > chunkScript(script).length, 'the refused chunk was split, not dropped');
    assert.deepEqual(spoken.filter((text) => text.length <= 3_000).flatMap(words), words(script), 'every word is still spoken, in order');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('audioOverview: a rate-limited voice is not re-sent at half its size', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-digest-audio-'));
  const spoken: string[] = [];
  try {
    const gemini = geminiWith(async () => {
      throw new Coded(E.RATE_LIMIT, 'gemini 429: quota');
    }, spoken);
    const overview = await audioOverview(gemini, 'A long script about the day. '.repeat(600), dir, 'title', new AbortController().signal, (pcm, file) => writeFile(file, pcm));

    assert.equal(overview, null);
    assert.equal(spoken.length, 1, 'one call, never a doubled ladder walk');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('ffmpegEncode: a real one-second MP3, when the host has ffmpeg', { skip: !hasFFmpeg() }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'feedberry-digest-audio-'));
  try {
    const file = join(dir, 'overview.mp3');
    await ffmpegEncode(Buffer.alloc(24_000 * 2), file, 'FeedBerry Daily Digest · test');
    assert.ok(statSync(file).size > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
