import type { DigestConfig } from '../config.ts';
import { log } from '../obs/log.ts';
import { Coded, E } from '../platform/errors.ts';
import { mediaSignal } from '../pipeline/prepare-media.ts';

/** ADR-029: the only door to Gemini. Text and speech share one key; tests inject their own fetch. */
export interface Gemini {
  json<T>(schema: unknown, prompt: string, signal: AbortSignal): Promise<T>;
  text(prompt: string, signal: AbortSignal): Promise<string>;
  /** Raw PCM: s16le, 24 kHz, mono, no container — the chunks concatenate as they are. */
  speak(text: string, signal: AbortSignal): Promise<Buffer>;
}

const API = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const API_REVISION = '2026-05-20';
/** The TTS voice and the style hint the digest always uses (ADR-029); no per-user choice. */
const TTS_VOICE = 'Kore';
const TTS_STYLE = 'warm, clear news presenter, steady pace';
/** One hung call must not eat the job's whole budget. */
const CALL_TIMEOUT_MS = 120_000;

interface InteractionReply {
  steps?: Array<{ type?: string; content?: Array<{ type?: string; text?: string; data?: string }> }>;
  error?: { message?: string };
}

export function geminiClient(cfg: DigestConfig, doFetch: typeof fetch = fetch): Gemini {
  const call = async (body: unknown, signal: AbortSignal): Promise<InteractionReply> => {
    const res = await doFetch(API, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': cfg.apiKey, 'Api-Revision': API_REVISION },
      body: JSON.stringify(body),
      signal: AbortSignal.any([signal, mediaSignal(CALL_TIMEOUT_MS)]),
    });
    const reply = (await res.json().catch(() => ({}))) as InteractionReply;
    if (!res.ok) throw new Coded(res.status === 429 ? E.RATE_LIMIT : E.FEED_DOWN, `gemini ${res.status}: ${reply.error?.message ?? ''}`);
    return reply;
  };

  const textOf = (reply: InteractionReply): string => {
    const parts = (reply.steps ?? []).filter((step) => step.type === 'model_output').flatMap((step) => step.content ?? []);
    const text = parts
      .filter((part) => part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text ?? '')
      .join('')
      .trim();
    if (text === '') throw new Coded(E.FEED_DOWN, 'gemini returned no text');
    return text;
  };

  return {
    async json<T>(schema: unknown, prompt: string, signal: AbortSignal): Promise<T> {
      const reply = await call({ model: cfg.textModel, input: prompt, response_format: { type: 'text', mime_type: 'application/json', schema } }, signal);
      const text = textOf(reply);
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new Coded(E.FEED_DOWN, 'gemini returned invalid json');
      }
    },

    async text(prompt, signal) {
      return textOf(await call({ model: cfg.textModel, input: prompt }, signal));
    },

    async speak(text, signal) {
      const reply = await call(
        {
          model: cfg.ttsModel,
          input: [{ type: 'user_input', content: [{ type: 'text', text, annotations: [{ type: 'speech_metadata', style: TTS_STYLE }] }] }],
          response_format: { type: 'audio', mime_type: 'audio/l16' },
          generation_config: { speech_config: [{ voice: TTS_VOICE }] },
        },
        signal,
      );
      const audio = (reply.steps ?? [])
        .filter((step) => step.type === 'model_output')
        .flatMap((step) => step.content ?? [])
        .filter((part) => part.type === 'audio' && typeof part.data === 'string')
        .at(-1);
      if (audio?.data === undefined || audio.data === '') {
        log('warn', 'gemini_audio_empty', {});
        throw new Coded(E.FEED_DOWN, 'gemini returned no audio');
      }
      return Buffer.from(audio.data, 'base64');
    },
  };
}
