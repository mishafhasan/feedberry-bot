/**
 * ADR-029's model ladder: free-tier quotas and capacity are per model, so a 429/5xx (or an unusable
 * answer) moves to the next model for summaries, the script and the voice. An abort never does.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DigestConfig } from '../../src/config.ts';
import { geminiClient, type Ledger } from '../../src/digest/gemini.ts';

const cfg = (over: Partial<DigestConfig> = {}): DigestConfig => ({
  apiKey: 'test-key',
  textModel: 'text-primary',
  ttsModel: 'tts-primary',
  textFallbacks: ['text-fallback'],
  ttsFallbacks: ['tts-fallback'],
  maxPosts: 3,
  ...over,
});

const ok = (payload: unknown): Response => new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
const fail = (status: number): Response => new Response(JSON.stringify({ error: { message: `status ${status}` } }), { status });
const textReply = (text: string): unknown => ({ steps: [{ type: 'model_output', content: [{ type: 'text', text }] }] });
const audioReply = (bytes: number): unknown => ({ steps: [{ type: 'model_output', content: [{ type: 'audio', data: Buffer.alloc(bytes).toString('base64') }] }] });

function recorder(handler: (model: string, call: number, init: RequestInit | undefined) => Response): { doFetch: typeof fetch; models: string[] } {
  const models: string[] = [];
  const doFetch: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { model: string };
    models.push(body.model);
    return handler(body.model, models.length, init ?? undefined);
  };
  return { doFetch, models };
}

test('json: a 429 moves the summary to the next model in the ladder', async () => {
  const { doFetch, models } = recorder((model) => (model === 'text-primary' ? fail(429) : ok(textReply(JSON.stringify({ headline: 'h' })))));
  const reply = await geminiClient(cfg(), doFetch).json<{ headline: string }>({}, 'prompt', new AbortController().signal);
  assert.deepEqual(reply, { headline: 'h' });
  assert.deepEqual(models, ['text-primary', 'text-fallback']);
});

test('json: all models failing surfaces the last error and stops the ladder', async () => {
  const { doFetch, models } = recorder(() => fail(503));
  await assert.rejects(geminiClient(cfg(), doFetch).json({}, 'prompt', new AbortController().signal), /gemini 503/);
  assert.deepEqual(models, ['text-primary', 'text-fallback']);
});

test('json: an unusable answer on one model is retried on the next', async () => {
  const { doFetch, models } = recorder((model) => (model === 'text-primary' ? ok(textReply('not json')) : ok(textReply(JSON.stringify({ ok: true })))));
  assert.deepEqual(await geminiClient(cfg(), doFetch).json({}, 'prompt', new AbortController().signal), { ok: true });
  assert.deepEqual(models, ['text-primary', 'text-fallback']);
});

test('text: the script call uses the same ladder', async () => {
  const { doFetch, models } = recorder((model) => (model === 'text-primary' ? fail(500) : ok(textReply('Welcome to the digest.'))));
  assert.equal(await geminiClient(cfg(), doFetch).text('prompt', new AbortController().signal), 'Welcome to the digest.');
  assert.deepEqual(models, ['text-primary', 'text-fallback']);
});

test('speak: an overloaded voice falls back to the lite voice', async () => {
  const { doFetch, models } = recorder((model) => (model === 'tts-primary' ? fail(503) : ok(audioReply(48_000))));
  const pcm = await geminiClient(cfg(), doFetch).speak('script', new AbortController().signal);
  assert.equal(pcm.length, 48_000);
  assert.deepEqual(models, ['tts-primary', 'tts-fallback']);
});

test('a ledger that reports a spent rung skips it without a request', async () => {
  const { doFetch, models } = recorder(() => ok(textReply('the script')));
  const spent: string[] = [];
  const ledger: Ledger = {
    spent: (model) => model === 'text-primary',
    spend: (model) => spent.push(model),
    block: () => undefined,
  };
  assert.equal(await geminiClient(cfg(), doFetch, undefined, ledger).text('prompt', new AbortController().signal), 'the script');
  assert.deepEqual(models, ['text-fallback'], 'the spent rung costs no request');
  assert.deepEqual(spent, ['text-fallback'], 'and only the rung that went out is counted');
});

test('a per-day 429 blocks the rung until the day turns', async () => {
  const { doFetch } = recorder(() => new Response(JSON.stringify({ error: { message: 'quota exceeded, 20 requests per day' } }), { status: 429 }));
  const blocked: number[] = [];
  const ledger: Ledger = { spent: () => false, spend: () => undefined, block: (_model, until) => blocked.push(until) };
  await assert.rejects(geminiClient(cfg(), doFetch, undefined, ledger).json({}, 'prompt', new AbortController().signal), /gemini 429/);
  assert.equal(blocked.length, 2, 'every rung that answered 429 is blocked, not only the first');
  assert.equal(new Date(blocked[0] ?? 0).getUTCHours(), 0, 'a per-day 429 ends at the UTC midnight');
});

test('every rung spent throws a rate limit without a request', async () => {
  const { doFetch, models } = recorder(() => ok(textReply('never')));
  const ledger: Ledger = { spent: () => true, spend: () => undefined, block: () => undefined };
  await assert.rejects(geminiClient(cfg(), doFetch, undefined, ledger).text('prompt', new AbortController().signal), /every gemini model is spent/);
  assert.deepEqual(models, [], 'no request is spent on a rung that cannot answer');
});

test('a too-long payload ends the ladder at once and blocks no rung', async () => {
  const { doFetch, models } = recorder(() => new Response(JSON.stringify({ error: { message: 'input is too long' } }), { status: 400 }));
  const blocked: string[] = [];
  const ledger: Ledger = { spent: () => false, spend: () => undefined, block: (model) => blocked.push(model) };
  await assert.rejects(geminiClient(cfg(), doFetch, undefined, ledger).speak('script', new AbortController().signal), /gemini 400/);
  assert.deepEqual(models, ['tts-primary'], 'the next voice cannot fit the same payload either');
  assert.deepEqual(blocked, [], 'and a healthy voice is not marked spent');
});

test('an abort ends the ladder at once — no other model is called', async () => {
  const controller = new AbortController();
  controller.abort();
  const { doFetch, models } = recorder((_model, _call, init) => {
    if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    return ok(textReply('never'));
  });
  await assert.rejects(geminiClient(cfg(), doFetch).text('prompt', controller.signal), /aborted/);
  assert.deepEqual(models, ['text-primary']);
});

test('the per-call cap is a model failure: the voice moves down the ladder', async () => {
  const models: string[] = [];
  const doFetch: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { model: string };
    models.push(body.model);
    if (body.model === 'tts-primary') {
      // A hung model: the request only settles when the per-call signal aborts it.
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    }
    return ok(audioReply(64));
  };
  const pcm = await geminiClient(cfg(), doFetch, 10).speak('hello', new AbortController().signal);
  assert.deepEqual(models, ['tts-primary', 'tts-fallback']);
  assert.equal(pcm.length, 64, 'the fallback voice still speaks');
});

test('a legacy voice speaks through generateContent and yields raw PCM', async () => {
  const pcm = Buffer.alloc(2_400, 7);
  const calls: string[] = [];
  const doFetch: typeof fetch = async (url) => {
    calls.push(String(url));
    return ok({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: pcm.toString('base64') } }] } }] });
  };
  const voice = await geminiClient(cfg({ ttsModel: 'gemini-2.5-flash-preview-tts', ttsFallbacks: [] }), doFetch).speak('Good morning.', new AbortController().signal);
  assert.deepEqual(voice, pcm);
  assert.match(calls[0] ?? '', /gemini-2\.5-flash-preview-tts:generateContent$/);
});

test('a WAV container from a legacy voice is stripped to its PCM', async () => {
  const body = Buffer.from([1, 2, 3, 4, 5, 6]);
  const header = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt '), Buffer.alloc(16), Buffer.from('data'), Buffer.from([6, 0, 0, 0])]);
  const wav = Buffer.concat([header, body]);
  const doFetch: typeof fetch = async () => ok({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/wav', data: wav.toString('base64') } }] } }] });
  const voice = await geminiClient(cfg({ ttsModel: 'gemini-3.1-flash-tts-preview', ttsFallbacks: [] }), doFetch).speak('Hello.', new AbortController().signal);
  assert.deepEqual(voice, body);
});

test('a rate-limited legacy voice falls to the next model on the interactions call', async () => {
  const seen: string[] = [];
  const doFetch: typeof fetch = async (url, init) => {
    if (String(url).includes(':generateContent')) {
      seen.push('legacy');
      return fail(429);
    }
    seen.push((JSON.parse(String(init?.body)) as { model: string }).model);
    return ok(audioReply(1_200));
  };
  const voice = await geminiClient(cfg({ ttsModel: 'gemini-3.1-flash-tts-preview', ttsFallbacks: ['gemini-3.8-flash-tts'] }), doFetch).speak('Hello.', new AbortController().signal);
  assert.equal(voice.length, 1_200);
  assert.deepEqual(seen, ['legacy', 'gemini-3.8-flash-tts']);
});

test('a fallback that repeats the primary is not called twice', async () => {
  const { doFetch, models } = recorder((model) => (model === 'text-primary' ? fail(503) : ok(textReply('ok'))));
  await geminiClient(cfg({ textFallbacks: ['text-primary', 'text-fallback'] }), doFetch).text('prompt', new AbortController().signal);
  assert.deepEqual(models, ['text-primary', 'text-fallback']);
});
