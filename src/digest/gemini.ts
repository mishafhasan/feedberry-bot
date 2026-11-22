import type { DigestConfig } from '../config.ts';
import { log } from '../obs/log.ts';
import { Coded, E, isCoded } from '../platform/errors.ts';
import { mediaSignal } from '../pipeline/prepare-media.ts';

/** ADR-029: the only door to Gemini. Text and speech share one key; tests inject their own fetch. */
export interface Gemini {
  /** `reserve` is how many of the rung's slots this call must leave free — the summaries keep the script's. */
  json<T>(schema: unknown, prompt: string, signal: AbortSignal, reserve?: number): Promise<T>;
  text(prompt: string, signal: AbortSignal, reserve?: number): Promise<string>;
  /** Raw PCM: s16le, 24 kHz, mono, no container — the chunks concatenate as they are. */
  speak(text: string, signal: AbortSignal): Promise<Buffer>;
}

/**
 * ADR-033: the free tier's per-model caps, remembered across restarts. A spent rung is skipped before
 * any request, and a 429 of the provider's own blocks that rung until the wait it names.
 */
export interface Ledger {
  spent(model: string, reserve: number): boolean;
  spend(model: string): void;
  block(model: string, until: number): void;
}

/** No ledger (tests, or a caller without a database): every rung is always available. */
export const NO_LEDGER: Ledger = { spent: () => false, spend: () => undefined, block: () => undefined };

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

/**
 * A "too long" answer is about the payload, not the model: re-sending it to the next rung wastes every
 * call, and marking the rung spent would cost the voice its quota for the day (ADR-033).
 */
export function inputTooLong(err: unknown): boolean {
  return isCoded(err) && /^gemini 400\b/.test(err.message) && /too long|too large|too many|maximum/i.test(err.message);
}

/** Free-tier days reset on the provider's clock; the ledger's own day is UTC, which resets earlier. */
function endOfUtcDay(now = Date.now()): number {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
}

export function geminiClient(cfg: DigestConfig, doFetch: typeof fetch = fetch, timeoutMs = CALL_TIMEOUT_MS, ledger: Ledger = NO_LEDGER): Gemini {
  /** Primary first, deduped; an empty id never enters a ladder. */
  const ladder = (primary: string, fallbacks: string[]): string[] => [primary, ...fallbacks].filter((model, index, all) => model !== '' && all.indexOf(model) === index);

  /**
   * The caller's abort (the job's budget) stays fatal; the per-call cap is the model hanging, so it is a
   * model failure and the ladder moves on — a silent voice is worse than a slower one.
   */
  const request = async (url: string, init: RequestInit, signal: AbortSignal): Promise<Response> => {
    const timed = mediaSignal(timeoutMs);
    try {
      return await doFetch(url, { ...init, signal: AbortSignal.any([signal, timed]) });
    } catch (err) {
      if (timed.aborted && !signal.aborted) throw new Coded(E.FEED_DOWN, 'gemini call timed out');
      throw err;
    }
  };

  const call = async (body: unknown, signal: AbortSignal): Promise<InteractionReply> => {
    const res = await request(API, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': cfg.apiKey, 'Api-Revision': API_REVISION },
      body: JSON.stringify(body),
    }, signal);
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
   * One role's ladder: a spent rung is skipped with no request, a 429/5xx (or a model that answers with
   * nothing usable) moves to the next model, and a too-long payload ends it at once (ADR-033).
   */
  const attempt = async <R>(role: 'text' | 'tts', models: string[], reserve: number, send: (model: string) => Promise<R>): Promise<R> => {
    for (const [index, model] of models.entries()) {
      if (ledger.spent(model, reserve)) {
        log('info', 'gemini_rung_spent', { role, model });
        continue;
      }
      // Counted before the call: three summaries run at once, so the last slot must go to exactly one.
      ledger.spend(model);
      try {
        return await send(model);
      } catch (err) {
        if (inputTooLong(err)) throw err;
        // shortcut: the deadline is read from the provider's message ("… per day"); a differently
        // worded per-day 429 blocks a minute instead, and the day counter stops that rung at its rpd.
        // Upgrade when a rung keeps answering 429 inside one day.
        if (isCoded(err) && err.code === E.RATE_LIMIT) ledger.block(model, /per day/i.test(err.message) ? endOfUtcDay() : Date.now() + 60_000);
        const next = models[index + 1];
        if (!isCoded(err) || next === undefined) throw err;
        log('warn', 'gemini_model_fallback', { role, from: model, to: next, cause: err.message });
      }
    }
    // Every rung is spent or blocked: a retry later is cheaper than a request that must fail.
    throw new Coded(E.RATE_LIMIT, 'every gemini model is spent');
  };

  /** A legacy voice's only audio door: generateContent with the AUDIO modality. */
  const speakLegacy = async (text: string, model: string, signal: AbortSignal): Promise<Buffer> => {
    const res = await request(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': cfg.apiKey },
      body: JSON.stringify({
        contents: [{ parts: [{ text }] }],
        generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: TTS_VOICE } } } },
      }),
    }, signal);
    const reply = (await res.json().catch(() => ({}))) as LegacyReply;
    if (!res.ok) throw new Coded(res.status === 429 ? E.RATE_LIMIT : E.FEED_DOWN, `gemini ${res.status}: ${reply.error?.message ?? ''}`);
    const inline = (reply.candidates ?? []).flatMap((candidate) => candidate.content?.parts ?? []).find((part) => part.inlineData?.data)?.inlineData;
    if (inline?.data === undefined || inline.data === '') throw new Coded(E.FEED_DOWN, 'gemini returned no audio');
    return pcmOf(inline.data, inline.mimeType ?? '');
  };

  return {
    async json<T>(schema: unknown, prompt: string, signal: AbortSignal, reserve = 0): Promise<T> {
      return attempt('text', textModels, reserve, async (model) => {
        const body = textOf(await call({ model, input: prompt, response_format: { type: 'text', mime_type: 'application/json', schema } }, signal));
        try {
          return JSON.parse(body) as T;
        } catch {
          throw new Coded(E.FEED_DOWN, 'gemini returned invalid json');
        }
      });
    },

    async text(prompt, signal, reserve = 0) {
      return attempt('text', textModels, reserve, async (model) => textOf(await call({ model, input: prompt }, signal)));
    },

    async speak(text, signal) {
      return attempt('tts', ttsModels, 0, async (model) => {
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
