import { fetch } from "./net.js";

const redirectStatuses = new Set([301, 302, 303, 307, 308]);

// Resolve a shortened or redirecting link without following it. HEAD first
// (cheap), GET as fallback for servers that answer HEAD with 405.
export async function getRedirectingURL(url, headers) {
    const attempt = async (method) => {
        try {
            const r = await fetch(url, { method, headers, redirect: "manual" });
            if (redirectStatuses.has(r.status) && r.headers.get("location")) {
                return r.headers.get("location");
            }
            // drain the body so the socket returns to the pool
            await r.body?.cancel().catch(() => {});
        } catch {}
    };

    return (await attempt("HEAD")) ?? (await attempt("GET"));
}

export function merge(a, b) {
    for (const k of Object.keys(b)) {
        if (Array.isArray(b[k])) {
            a[k] = [...(a[k] ?? []), ...b[k]];
        } else if (typeof b[k] === 'object') {
            a[k] = merge(a[k], b[k]);
        } else {
            a[k] = b[k];
        }
    }

    return a;
}

export function splitFilenameExtension(filename) {
    const parts = filename.split('.');
    const ext = parts.pop();

    if (!parts.length) {
        return [ ext, "" ]
    } else {
        return [ parts.join('.'), ext ]
    }
}

export function zip(a, b) {
    return a.map((value, i) => [ value, b[i] ]);
}

export function isURL(input) {
    try {
        new URL(input);
        return true;
    } catch {
        return false;
    }
}
