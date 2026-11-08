import { Coded, E, isCoded } from './errors.ts';

/** One HTTP shape for the whole pipeline so tests can inject fixtures instead of the network. */
export interface HttpOptions {
  maxBytes: number;
  timeoutMs?: number;
  /** Extra request headers; an adapter that needs the site's rendered variant sets them here. */
  headers?: Record<string, string>;
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
export const trustedFetch: Http = async (url, { maxBytes, timeoutMs = 20_000, headers }) => {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow', headers });
    const body = decodeBody(await readCapped(res, maxBytes), res.headers.get('content-type') ?? '');
    return { status: res.status, url: res.url || url, contentType: res.headers.get('content-type') ?? '', body };
  } catch (err) {
    // A refused connection, a TLS error or a timeout is the source being down, not an unknown bug.
    if (isCoded(err)) throw err;
    throw new Coded(E.FEED_DOWN, err instanceof Error ? err.message : String(err));
  }
};

/**
 * One decode point for both transports. Order is XML 1.0 Appendix F: BOM, then the document's own
 * declaration, then the transport, then UTF-8 — a feed's bytes often disagree with its header
 * (RFC 7303 §8.8), and the document is the authority on itself.
 */
export function decodeBody(bytes: Buffer, contentType: string): string {
  const bom =
    bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 'utf-8'
      : bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le'
        : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be'
          : undefined;
  const head = bytes.subarray(0, 200).toString('latin1');
  const charset =
    bom ??
    /<\?xml[^>]*\bencoding\s*=\s*["']([^"']+)["']/i.exec(head)?.[1] ??
    /charset\s*=\s*["']?([^;"'\s]+)/i.exec(contentType)?.[1] ??
    'utf-8';
  try {
    return new TextDecoder(charset, { fatal: false }).decode(bytes);
  } catch {
    // An unknown label is not worth a failed fetch; UTF-8 is what nearly every feed is.
    return bytes.toString('utf8');
  }
}

/** Reads at most `maxBytes`; a bigger response is a fetch failure, never a memory problem. */
export async function readCapped(res: Response, maxBytes: number): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0);
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
  return Buffer.concat(chunks);
}
