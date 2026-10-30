/** One HTTP shape for the whole pipeline so tests can inject fixtures instead of the network. */
export interface HttpOptions {
  maxBytes: number;
  timeoutMs?: number;
}

export interface HttpResponse {
  status: number;
  /** URL after redirects. */
  url: string;
  contentType: string;
  body: string;
}

export type Http = (url: string, options: HttpOptions) => Promise<HttpResponse>;

export const HTML_LIMIT = 20 * 1024 * 1024;
export const FEED_LIMIT = 5 * 1024 * 1024;

/**
 * Trusted fetch for operator-configured endpoints (RSSHub, Bluesky AppView): the host comes from
 * config or a fixed constant, so the SSRF guard of §12.2 does not apply.
 */
export const trustedFetch: Http = async (url, { maxBytes, timeoutMs = 20_000 }) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
  const body = await readCapped(res, maxBytes);
  return { status: res.status, url: res.url || url, contentType: res.headers.get('content-type') ?? '', body };
};

/** Reads at most `maxBytes`; a bigger response is a fetch failure, never a memory problem. */
export async function readCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`response exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
