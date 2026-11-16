/**
 * ADR-029's model ladder: free-tier quotas and capacity are per model, so a 429/5xx (or an unusable
 * answer) moves to the next model for summaries, the script and the voice. An abort never does.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DigestConfig } from '../../src/config.ts';
import { geminiClient } from '../../src/digest/gemini.ts';

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

test('a fallback that repeats the primary is not called twice', async () => {
  const { doFetch, models } = recorder((model) => (model === 'text-primary' ? fail(503) : ok(textReply('ok'))));
  await geminiClient(cfg({ textFallbacks: ['text-primary', 'text-fallback'] }), doFetch).text('prompt', new AbortController().signal);
  assert.deepEqual(models, ['text-primary', 'text-fallback']);
});
