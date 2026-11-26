import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import tls from 'node:tls';
import undici from 'undici';

export function ensureCaBundle(filePath) {
    if (existsSync(filePath)) return;
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, tls.rootCertificates.join('\n') + '\n', { mode: 0o644 });
}

if (process.platform === 'linux' && process.env.NODE_ENV === 'production') {
    ensureCaBundle('/etc/ssl/certs/ca-certificates.crt');
}

const proxyUri = process.env.PROXY_URI;
const proxyUrlRegex = process.env.PROXY_URL_REGEX;

if (proxyUri && !proxyUrlRegex) {
    throw new Error('PROXY_URL_REGEX is required when PROXY_URI is set');
}

if (proxyUri && proxyUrlRegex) {
    const allowedUrl = new RegExp(proxyUrlRegex);
    const directDispatcher = new undici.Agent();
    const proxyDispatch = undici.ProxyAgent.prototype.dispatch;

    undici.ProxyAgent.prototype.dispatch = function (opts, handler) {
        let origin;
        try {
            origin = new URL(opts?.origin);
        } catch {}

        allowedUrl.lastIndex = 0;
        if (!origin || !['http:', 'https:'].includes(origin.protocol) || !allowedUrl.test(origin.href)) {
            return directDispatcher.dispatch(opts, handler);
        }
        return proxyDispatch.call(this, opts, handler);
    };
}
