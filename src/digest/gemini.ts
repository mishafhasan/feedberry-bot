import type { DigestConfig } from '../config.ts';
import { log } from '../obs/log.ts';
import { Coded, E, isCoded } from '../platform/errors.ts';
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
  /** Primary first, deduped; an empty id never enters a ladder. */
  const ladder = (primary: string, fallbacks: string[]): string[] => [primary, ...fallbacks].filter((model, index, all) => model !== '' && all.indexOf(model) === index);

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

  const textModels = ladder(cfg.textModel, cfg.textFallbacks);
  const ttsModels = ladder(cfg.ttsModel, cfg.ttsFallbacks);

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

  /**
   * One role's ladder: a 429/5xx (or a model that answers with nothing usable) moves to the next model,
   * because free-tier quotas and capacity are per model. A network error or an abort ends it at once.
   */
  const attempt = async <R>(role: 'text' | 'tts', models: string[], build: (model: string) => unknown, parse: (reply: InteractionReply) => R, signal: AbortSignal): Promise<R> => {
    for (const [index, model] of models.entries()) {
      try {
        return parse(await call(build(model), signal));
      } catch (err) {
        const next = models[index + 1];
        if (!isCoded(err) || next === undefined) throw err;
        log('warn', 'gemini_model_fallback', { role, from: model, to: next, cause: err.message });
      }
    }
    throw new Coded(E.FEED_DOWN, 'gemini model ladder is empty');
  };

  return {
    async json<T>(schema: unknown, prompt: string, signal: AbortSignal): Promise<T> {
      const text = await attempt(
        'text',
        textModels,
        (model) => ({ model, input: prompt, response_format: { type: 'text', mime_type: 'application/json', schema } }),
        (reply) => {
          const body = textOf(reply);
          try {
            return JSON.parse(body) as T;
          } catch {
            throw new Coded(E.FEED_DOWN, 'gemini returned invalid json');
          }
        },
        signal,
      );
      return text;
    },

    async text(prompt, signal) {
      return attempt('text', textModels, (model) => ({ model, input: prompt }), textOf, signal);
    },

    async speak(text, signal) {
      return attempt(
        'tts',
        ttsModels,
        (model) => ({
          model,
          input: [{ type: 'user_input', content: [{ type: 'text', text, annotations: [{ type: 'speech_metadata', style: TTS_STYLE }] }] }],
          response_format: { type: 'audio', mime_type: 'audio/l16' },
          generation_config: { speech_config: [{ voice: TTS_VOICE }] },
        }),
        (reply) => {
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
        signal,
      );
    },
  };
}
