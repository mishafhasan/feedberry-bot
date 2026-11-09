// In-memory cookie pool, optionally seeded from a cookies.json file.
//
// Some platforms (instagram, twitter, youtube) serve far more content when the
// request carries a signed-in session. A pool lets the engine rotate between
// accounts so a single session does not get rate limited.

import { readFile, writeFile } from 'node:fs/promises';
import { parse as parseSetCookie, splitCookiesString } from 'set-cookie-parser';

import Cookie from './cookie.js';
import { env } from './settings.js';

const WRITE_INTERVAL = 60000;
const VALID_SERVICES = new Set([
    'instagram',
    'instagram_bearer',
    'reddit',
    'twitter',
    'youtube',
    'vimeo_bearer',
]);

const invalidCookies = {};
let cookies = {}, dirty = false, intervalId, cookiePath;

function writeChanges() {
    if (!dirty || !cookiePath) return;
    dirty = false;

    const cookieData = JSON.stringify({ ...cookies, ...invalidCookies }, null, 4);
    writeFile(cookiePath, cookieData).catch((e) => {
        console.warn('[!] failed writing updated cookies to storage:', e?.message);
        clearInterval(intervalId);
        intervalId = null;
    });
}

export const loadCookies = async (path = env.cookiePath) => {
    if (!path) return cookies;

    cookiePath = path;
    try {
        cookies = JSON.parse(await readFile(path, 'utf8'));
        for (const serviceName in cookies) {
            if (!VALID_SERVICES.has(serviceName)) {
                console.warn(`[!] ignoring unknown service in cookie file: ${serviceName}`);
            } else if (!Array.isArray(cookies[serviceName])) {
                console.warn(`[!] ${serviceName} in cookies file is not an array, ignoring it`);
            } else if (cookies[serviceName].some(c => typeof c !== 'string')) {
                console.warn(`[!] some cookie for ${serviceName} contains non-string value`);
            } else continue;

            invalidCookies[serviceName] = cookies[serviceName];
            delete cookies[serviceName];
        }

        if (!intervalId) {
            intervalId = setInterval(writeChanges, WRITE_INTERVAL);
        }
    } catch (e) {
        console.warn('[!] failed to load cookies:', e?.message);
    }

    dirty = false;
    return cookies;
};

// Seed the pool from memory for hosts that keep credentials in their own environment:
// no file to read, nothing written back.
export function setCookies(services = {}) {
    for (const [service, entries] of Object.entries(services)) {
        if (!VALID_SERVICES.has(service) || !Array.isArray(entries)) continue;

        const valid = entries.filter(entry => typeof entry === 'string');
        if (valid.length) cookies[service] = valid;
    }
    return cookies;
}

export function getCookie(service) {
    if (!VALID_SERVICES.has(service)) return;
    if (!cookies[service] || !cookies[service].length) return;

    const idx = Math.floor(Math.random() * cookies[service].length);

    const cookie = cookies[service][idx];
    if (typeof cookie === 'string') {
        cookies[service][idx] = Cookie.fromString(cookie);
    }

    cookies[service][idx].meta = { service, idx };
    return cookies[service][idx];
}

export function updateCookieValues(cookie, values) {
    let changed = false;

    for (const [ key, value ] of Object.entries(values)) {
        changed = cookie.set(key, value) || changed;
    }

    if (changed && cookie.meta) dirty = true;

    return changed;
}

export function updateCookie(cookie, headers) {
    if (!cookie) return;

    const raw = headers.get('set-cookie');
    if (!raw) return;

    const parsed = parseSetCookie(splitCookiesString(raw), { decodeValues: false }),
        values = {};

    cookie.unset(parsed.filter(c => c.expires < new Date()).map(c => c.name));
    parsed.filter(c => !c.expires || c.expires > new Date())
        .forEach(c => values[c.name] = c.value);

    updateCookieValues(cookie, values);
}

// let the host process exit without waiting on the flush timer
export const stopCookieFlush = () => {
    if (intervalId) clearInterval(intervalId);
    intervalId = null;
    writeChanges();
};
