import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { log } from '../obs/log.ts';
import { isCoded } from '../platform/errors.ts';
import { inputTooLong, type Gemini } from './gemini.ts';

const run = promisify(execFile);

/**
 * Measured (ADR-033): 3 929 Tamil characters came back as 260 s of PCM in 31 s, while 9 169 failed at
 * the transport level after 61 s. 5 000 keeps the call well inside both, and halves the request count.
 */
export const AUDIO_CHUNK_CHARS = 5_000;
/** The size ADR-029 shipped with, kept as the one retry a failed chunk gets. */
export const AUDIO_RETRY_CHARS = 2_500;
/** +10% keeps a long script inside a shorter file; atempo time-stretches without shifting pitch. */
export const SPEECH_RATE = 1.1;
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
    [
      '-y',
      '-f', 's16le',
      '-ar', String(SAMPLE_RATE),
      '-ac', '1',
      '-i', pcmPath,
      '-filter:a', `atempo=${SPEECH_RATE}`,
      '-c:a', 'libmp3lame',
      '-b:a', '64k',
      '-metadata', `title=${title}`,
      '-metadata', 'artist=FeedBerry',
      file,
    ],
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
 * Script → one MP3 with its title in the file's own tags. A failed chunk is retried at half its size —
 * a transport failure on a long response is commoner than a broken voice — and any failure still
 * returns null: the digest ships without a player (ADR-029, ADR-033).
 */
export async function audioOverview(gemini: Gemini, script: string, dir: string, title: string, signal: AbortSignal, encode: AudioEncoder = ffmpegEncode): Promise<AudioOverview | null> {
  let calls = 0;
  const speak = async (text: string): Promise<Buffer> => {
    calls++;
    try {
      return await gemini.speak(text, signal);
    } catch (err) {
      // A 429 already walked the ladder; only a payload the voice could not swallow is worth splitting.
      if (signal.aborted || text.length <= AUDIO_RETRY_CHARS || (isCoded(err) && !inputTooLong(err))) throw err;
      log('warn', 'digest_audio_split', { chars: text.length, calls });
      const out: Buffer[] = [];
      for (const half of chunkScript(text, AUDIO_RETRY_CHARS)) out.push(await speak(half));
      return Buffer.concat(out);
    }
  };

  try {
    const pieces: Buffer[] = [];
    for (const chunk of chunkScript(script)) pieces.push(await speak(chunk));
    const pcm = Buffer.concat(pieces);
    if (pcm.length === 0) throw new Error('no audio bytes');

    const file = join(dir, 'overview.mp3');
    await encode(pcm, file, title);
    return { file, seconds: secondsOf(pcm.length) / SPEECH_RATE };
  } catch (err) {
    log('warn', 'digest_audio_failed', { cause: err instanceof Error ? err.message : String(err), chars: script.length, calls });
    return null;
  }
}
