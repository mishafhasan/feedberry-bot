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

/**
 * The legacy TTS previews predate the interactions audio format: they speak only through
 * `models/{id}:generateContent` with the AUDIO modality and answer raw 16-bit PCM 24 kHz
 * (probed live, 2026-11-17). Every other voice uses the unary interactions call.
 */
const LEGACY_TTS = new Set(['gemini-3.1-flash-tts-preview', 'gemini-2.5-flash-preview-tts']);

interface InteractionReply {
  steps?: Array<{ type?: string; content?: Array<{ type?: string; text?: string; data?: string }> }>;
  error?: { message?: string };
}

interface LegacyReply {
  candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { mimeType?: string; data?: string } }> } }>;
  error?: { message?: string };
}

/** The legacy models answer raw L16; a WAV container is stripped to its PCM so chunks concatenate. */
function pcmOf(base64: string, mime: string): Buffer {
  const bytes = Buffer.from(base64, 'base64');
  if (/l16/i.test(mime)) return bytes;
  if (/wav/i.test(mime)) {
    const marker = bytes.indexOf('data');
    return marker >= 0 && bytes.length > marker + 8 ? bytes.subarray(marker + 8) : bytes;
  }
  throw new Coded(E.FEED_DOWN, `unsupported audio type ${mime}`);
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
  const attempt = async <R>(role: 'text' | 'tts', models: string[], send: (model: string) => Promise<R>): Promise<R> => {
    for (const [index, model] of models.entries()) {
      try {
        return await send(model);
      } catch (err) {
        const next = models[index + 1];
        if (!isCoded(err) || next === undefined) throw err;
        log('warn', 'gemini_model_fallback', { role, from: model, to: next, cause: err.message });
      }
    }
    throw new Coded(E.FEED_DOWN, 'gemini model ladder is empty');
  };

  /** A legacy voice's only audio door: generateContent with the AUDIO modality. */
  const speakLegacy = async (text: string, model: string, signal: AbortSignal): Promise<Buffer> => {
    const res = await doFetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': cfg.apiKey },
      body: JSON.stringify({
        contents: [{ parts: [{ text }] }],
        generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: TTS_VOICE } } } },
      }),
      signal: AbortSignal.any([signal, mediaSignal(CALL_TIMEOUT_MS)]),
    });
    const reply = (await res.json().catch(() => ({}))) as LegacyReply;
    if (!res.ok) throw new Coded(res.status === 429 ? E.RATE_LIMIT : E.FEED_DOWN, `gemini ${res.status}: ${reply.error?.message ?? ''}`);
    const inline = (reply.candidates ?? []).flatMap((candidate) => candidate.content?.parts ?? []).find((part) => part.inlineData?.data)?.inlineData;
    if (inline?.data === undefined || inline.data === '') throw new Coded(E.FEED_DOWN, 'gemini returned no audio');
    return pcmOf(inline.data, inline.mimeType ?? '');
  };

  return {
    async json<T>(schema: unknown, prompt: string, signal: AbortSignal): Promise<T> {
      return attempt('text', textModels, async (model) => {
        const body = textOf(await call({ model, input: prompt, response_format: { type: 'text', mime_type: 'application/json', schema } }, signal));
        try {
          return JSON.parse(body) as T;
        } catch {
          throw new Coded(E.FEED_DOWN, 'gemini returned invalid json');
        }
      });
    },

    async text(prompt, signal) {
      return attempt('text', textModels, async (model) => textOf(await call({ model, input: prompt }, signal)));
    },

    async speak(text, signal) {
      return attempt('tts', ttsModels, async (model) => {
        if (LEGACY_TTS.has(model)) return speakLegacy(text, model, signal);
        const reply = await call(
          {
            model,
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
      });
    },
  };
}
