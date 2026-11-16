import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { log } from '../obs/log.ts';
import type { Gemini } from './gemini.ts';

const run = promisify(execFile);

/** The TTS model takes 8 192 input tokens, so the script goes out in pieces (ADR-029). */
export const AUDIO_CHUNK_CHARS = 2_500;
const SAMPLE_RATE = 24_000;
const BYTES_PER_SAMPLE = 2;

export interface AudioOverview {
  file: string;
  seconds: number;
}

/** The MP3 step, injectable like the thumbnailer: tests never depend on a host ffmpeg. */
export type AudioEncoder = (pcm: Buffer, file: string, title: string) => Promise<void>;

/** PCM → 64 kbps MP3 with the digest's title in the file's own tags. */
export const ffmpegEncode: AudioEncoder = async (pcm, file, title) => {
  const pcmPath = `${file}.pcm`;
  await writeFile(pcmPath, pcm);
  await run(
    'ffmpeg',
    ['-y', '-f', 's16le', '-ar', String(SAMPLE_RATE), '-ac', '1', '-i', pcmPath, '-c:a', 'libmp3lame', '-b:a', '64k', '-metadata', `title=${title}`, '-metadata', 'artist=FeedBerry', file],
    { timeout: 60_000 },
  );
};

/** PCM length → seconds: 24 kHz, 16-bit, mono. */
export function secondsOf(pcmBytes: number): number {
  return pcmBytes / (SAMPLE_RATE * BYTES_PER_SAMPLE);
}

/**
 * Paragraph breaks first, then sentences, then words: a chunk never exceeds the limit and never cuts
 * a word in half, so the voice never reads half a word at a chunk edge.
 */
export function chunkScript(text: string, limit = AUDIO_CHUNK_CHARS): string[] {
  const paragraphs = text
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== '');

  const chunks: string[] = [];
  let current = '';
  const add = (piece: string): void => {
    const next = current === '' ? piece : `${current}\n\n${piece}`;
    if (next.length <= limit) {
      current = next;
      return;
    }
    if (current !== '') chunks.push(current);
    current = piece;
  };

  for (const paragraph of paragraphs) {
    for (const piece of splitLong(paragraph, limit)) add(piece);
  }
  if (current !== '') chunks.push(current);
  return chunks;
}

/** A paragraph past the limit is packed sentence by sentence, a sentence word by word. */
function splitLong(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const out: string[] = [];
  let line = '';
  const add = (piece: string): void => {
    const next = line === '' ? piece : `${line} ${piece}`;
    if (next.length <= limit) {
      line = next;
      return;
    }
    if (line !== '') out.push(line);
    line = piece;
  };

  for (const sentence of text.split(/(?<=[.!?…])\s+/)) {
    const words = sentence.length <= limit ? [sentence] : wrapWords(sentence, limit);
    for (const word of words) add(word);
  }
  if (line !== '') out.push(line);
  return out;
}

function wrapWords(sentence: string, limit: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of sentence.split(' ')) {
    const next = line === '' ? word : `${line} ${word}`;
    if (next.length <= limit) {
      line = next;
      continue;
    }
    if (line !== '') out.push(line);
    line = word;
  }
  if (line !== '') out.push(line);
  return out;
}

/**
 * Script → one MP3 with its title in the file's own tags. Any failure returns null: the digest still
 * ships, with the "audio unavailable" line instead of a player (ADR-029).
 */
export async function audioOverview(gemini: Gemini, script: string, dir: string, title: string, signal: AbortSignal, encode: AudioEncoder = ffmpegEncode): Promise<AudioOverview | null> {
  try {
    const pieces: Buffer[] = [];
    for (const chunk of chunkScript(script)) pieces.push(await gemini.speak(chunk, signal));
    const pcm = Buffer.concat(pieces);
    if (pcm.length === 0) throw new Error('no audio bytes');

    const file = join(dir, 'overview.mp3');
    await encode(pcm, file, title);
    return { file, seconds: secondsOf(pcm.length) };
  } catch (err) {
    log('warn', 'digest_audio_failed', { cause: err instanceof Error ? err.message : String(err) });
    return null;
  }
}
