import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { promisify } from 'node:util';
import tls from 'node:tls';

const execFileAsync = promisify(execFile);
const patchUrl = new URL('../../rsshub-patches/meta-only-proxy.mjs', import.meta.url).href;
const metaRegex = '^https?://(?:[a-z0-9-]+\\.)*(?:instagram\\.com|facebook\\.com)(?::[0-9]+)?(?:/|$)';

const probe = `
import http from 'node:http';
import undici from 'undici';
await import(process.argv[1]);

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const directServer = http.createServer((request, response) => {
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({ route: 'direct', cookie: request.headers.cookie ?? null, url: request.url }));
});
const proxyServer = http.createServer((request, response) => {
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({ route: 'proxy', cookie: request.headers.cookie ?? null, url: request.url }));
});
await listen(directServer);
await listen(proxyServer);
const directUrl = 'http://127.0.0.1:' + directServer.address().port + '/';
const proxy = new undici.ProxyAgent({ uri: 'http://127.0.0.1:' + proxyServer.address().port });
const dispatcher = proxy.compose((dispatch) => (opts, handler) => dispatch({
  ...opts,
  headers: { ...opts.headers, cookie: 'session=abc' },
}, handler));

const target = process.argv[2];
const input = target === 'matched'
  ? 'http://instagram.com/'
  : target === 'uppercase'
    ? directUrl.toUpperCase()
    : target === 'request'
      ? new undici.Request(directUrl)
      : directUrl;

try {
  const response = await undici.fetch(input, { dispatcher });
  console.log(await response.text());
} catch (error) {
  console.log(JSON.stringify({ error: error.cause?.message ?? error.message }));
} finally {
  directServer.closeAllConnections();
  proxyServer.closeAllConnections();
  await Promise.all([
    new Promise((resolve) => directServer.close(resolve)),
    new Promise((resolve) => proxyServer.close(resolve)),
  ]);
  await dispatcher.close();
}
`;

const runProbe = (target: string, regex: string | null = metaRegex) => {
  const env = { ...process.env, PROXY_URI: 'http://proxy.invalid:8888' };
  if (regex === null) delete env.PROXY_URL_REGEX;
  else env.PROXY_URL_REGEX = regex;

  return execFileAsync(process.execPath, ['--input-type=module', '-e', probe, patchUrl, target], { env });
};

test('RSSHub startup preserves its 32 KiB HTTP header limit', () => {
  const compose = readFileSync(new URL('../../docker-compose.yml', import.meta.url), 'utf8');
  assert.match(compose, /NODE_OPTIONS:\s*--max-http-header-size=32768/);
});

test('RSSHub proxy dispatchers honor the URL boundary without dropping authentication interceptors', async () => {
  for (const target of ['direct', 'uppercase', 'request']) {
    const { stdout } = await runProbe(target);
    assert.deepEqual(JSON.parse(stdout), { route: 'direct', cookie: 'session=abc', url: '/' }, `${target} input must go direct with its cookie`);
  }

  const matched = await runProbe('matched');
  assert.deepEqual(JSON.parse(matched.stdout), {
    route: 'proxy',
    cookie: 'session=abc',
    url: 'http://instagram.com/',
  }, 'a Meta URL must use the proxy and retain its cookie');
});

test('RSSHub fails closed when a proxy is configured without a URL boundary', async () => {
  await assert.rejects(runProbe('direct', null), /PROXY_URL_REGEX is required when PROXY_URI is set/);
});

test('RSSHub startup can restore a missing CA bundle from Node root certificates', async () => {
  const probe = `
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tls from 'node:tls';
const { ensureCaBundle } = await import(process.argv[1]);
const directory = mkdtempSync(join(tmpdir(), 'rsshub-ca-'));
const bundle = join(directory, 'ca-certificates.crt');
try {
  ensureCaBundle(bundle);
  console.log(JSON.stringify({ content: readFileSync(bundle, 'utf8'), roots: tls.rootCertificates.length }));
} finally {
  rmSync(directory, { recursive: true, force: true });
}
`;
  const env = { ...process.env, NODE_ENV: 'test' };
  delete env.PROXY_URI;
  delete env.PROXY_URL_REGEX;
  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', probe, patchUrl], { env });
  const result = JSON.parse(stdout);
  assert.ok(result.roots > 0);
  assert.equal(result.content, tls.rootCertificates.join('\n') + '\n');
});
