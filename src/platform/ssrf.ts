import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { Coded, E } from './errors.ts';
import type { Http, HttpOptions, HttpResponse } from './http.ts';

/** ARCHITECTURE §12.2: scheme/port/length, one DNS resolve, connect by IP, 2 redirects, timeouts. */
const MAX_URL_LENGTH = 2048;
const MAX_REDIRECTS = 2;
const CONNECT_TIMEOUT_MS = 10_000;

export function assertUrl(raw: string): URL {
  if (raw.length > MAX_URL_LENGTH) throw new Coded(E.LINK_INVALID, 'url longer than 2048');
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Coded(E.LINK_INVALID, 'unparseable url');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Coded(E.LINK_INVALID, `scheme ${u.protocol}`);
  if (u.username || u.password) throw new Coded(E.LINK_INVALID, 'credentials in url');
  if (u.port && u.port !== '80' && u.port !== '443') throw new Coded(E.LINK_INVALID, `port ${u.port}`);
  return u;
}

export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a = 0, b = 0] = ip.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) || // CGNAT
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  const v6 = ip.toLowerCase();
  if (v6 === '::' || v6 === '::1') return true;
  if (v6.startsWith('fe80') || v6.startsWith('fc') || v6.startsWith('fd')) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
  return mapped ? isPrivateAddress(mapped[1] as string) : false;
}

/** SSRF-guarded fetch for links a user typed. Never follows a redirect without re-validating it. */
export const safeFetch: Http = async (url, options) => {
  let current = assertUrl(url);
  let headers = options.headers;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const address = await resolvePublic(current.hostname);
    const res = await rawRequest(current, address, { ...options, headers });

    if (res.status >= 300 && res.status < 400 && res.location) {
      const next = assertUrl(new URL(res.location, current).toString());
      // Sec-Fetch and site-specific headers are origin-scoped: never carry them to another host.
      if (next.hostname !== current.hostname) headers = undefined;
      current = next;
      continue;
    }
    return { status: res.status, url: current.toString(), contentType: res.contentType, body: res.body };
  }
  throw new Coded(E.FEED_DOWN, 'too many redirects');
};

async function resolvePublic(hostname: string): Promise<string> {
  // The bot's own host is never fetched (§12.2 rule 5); localhost names never resolve publicly anyway.
  if (hostname === 'localhost' || hostname.endsWith('.local')) throw new Coded(E.LINK_INVALID, 'local host');
  let address: string;
  try {
    address = (await lookup(hostname)).address;
  } catch {
    throw new Coded(E.FEED_DOWN, `dns failure for ${hostname}`);
  }
  if (isPrivateAddress(address)) throw new Coded(E.LINK_INVALID, `private address ${address}`);
  return address;
}

interface RawResponse {
  status: number;
  location: string | null;
  contentType: string;
  body: string;
}

/** Connects to the resolved IP with the original Host header: no re-resolve, no DNS rebinding. */
function rawRequest(u: URL, address: string, { maxBytes, timeoutMs = 20_000, headers }: HttpOptions): Promise<RawResponse> {
  const secure = u.protocol === 'https:';
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err: Error) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    };

    const req = (secure ? httpsRequest : httpRequest)(
      {
        host: address,
        port: u.port || (secure ? 443 : 80),
        path: u.pathname + u.search,
        method: 'GET',
        servername: secure ? u.hostname : undefined,
        headers: {
          'user-agent': 'FeedBerry/0.1 (+https://github.com/mishafhasan/feedberry-bot)',
          accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.9, */*;q=0.5',
          ...headers,
          // Last word on the host: it is what lets the guard connect to the resolved IP.
          host: u.host,
        },
        lookup: ((_h: string, _o: unknown, cb: (err: Error | null, addr: string, family: number) => void) =>
          cb(null, address, isIP(address))) as never,
        signal: AbortSignal.timeout(timeoutMs),
      },
      (res) => {
        const chunks: Buffer[] = [];
        let total = 0;
        res.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (total > maxBytes) {
            req.destroy(new Coded(E.FEED_DOWN, 'response too large'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          if (settled) return;
          settled = true;
          resolve({
            status: res.statusCode ?? 0,
            location: (res.headers.location as string | undefined) ?? null,
            contentType: String(res.headers['content-type'] ?? ''),
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );

    req.setTimeout(CONNECT_TIMEOUT_MS, () => req.destroy(new Coded(E.FEED_DOWN, 'connect timeout')));
    req.on('error', (err) => fail(err instanceof Coded ? err : new Coded(E.FEED_DOWN, err.message)));
    req.end();
  });
}

export type { HttpResponse };
