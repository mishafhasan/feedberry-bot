// Generic extractor for ordinary web pages: blog posts, news articles, forums,
// self-hosted galleries. No site-specific logic, so it reads the same
// structured metadata that link previews and players use.

import { fetch } from "./net.js";
import { genericUserAgent } from "./settings.js";
import { extensionFor } from "./mime-types.js";

const MAX_HTML_BYTES = 3 * 1024 * 1024;
const requestTimeoutMs = 20_000;

const HTML_ENTITIES = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#39;": "'",
    "&#x27;": "'",
    "&apos;": "'",
    "&nbsp;": " ",
};

const unescape = (s) => s.replace(
    /&(?:amp|lt|gt|quot|#39|#x27|apos|nbsp);/g,
    (m) => HTML_ENTITIES[m] ?? m
);

const attr = (tag, name) => {
    const re = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i");
    const m = tag.match(re);
    return m ? unescape(m[1] ?? m[2] ?? m[3]) : undefined;
};

const metaTags = (html) => {
    const out = new Map();
    for (const [tag] of html.matchAll(/<meta\b[^>]*>/gi)) {
        const key = (attr(tag, "property") ?? attr(tag, "name"))?.toLowerCase();
        const content = attr(tag, "content");
        if (key && content && !out.has(key)) out.set(key, content);
    }
    return out;
};

const titleOf = (html) => {
    const og = html.match(/<meta\b[^>]*property\s*=\s*["']og:title["'][^>]*>/i);
    const fromOg = og && attr(og[0], "content");
    if (fromOg) return fromOg;
    const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    return t ? unescape(t[1]).trim() : undefined;
};

// JSON-LD VideoObject / ImageObject blocks carry a clean contentUrl
const jsonLdMedia = (html) => {
    const out = [];
    for (const m of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
        let data;
        try {
            data = JSON.parse(m[1]);
        } catch {
            continue;
        }

        const walk = (node) => {
            if (!node || typeof node !== "object") return;
            if (Array.isArray(node)) return node.forEach(walk);

            const url = node.contentUrl ?? node.embedUrl;
            if (typeof url === "string" && /\.(mp4|webm|mkv|m3u8|mp3|m4a)(\?|$)/i.test(url)) {
                out.push({
                    type: node["@type"] === "AudioObject" ? "audio" : "video",
                    url,
                });
            }
            Object.values(node).forEach(walk);
        };

        walk(data);
    }
    return out;
};

// <video src>, <source src>, <audio src> — covers self-hosted players
const mediaElements = (html) => {
    const out = [];
    for (const [tag] of html.matchAll(/<(video|audio|source)\b[^>]*>/gi)) {
        const url = attr(tag, "src");
        if (!url || url.startsWith("blob:") || url.startsWith("data:")) continue;
        const type = attr(tag, "type") ?? "";
        out.push({
            type: tag.toLowerCase() === "audio" || type.startsWith("audio/") ? "audio" : "video",
            url,
        });
    }
    return out;
};

const absolute = (url, base) => {
    try {
        return new URL(url, base).toString();
    } catch {
        return;
    }
};

const dedupe = (items) => {
    const seen = new Set();
    return items.filter(item => {
        if (!item?.url || seen.has(item.url)) return false;
        seen.add(item.url);
        return true;
    });
};

const filenameFrom = (url, fallbackExt) => {
    try {
        const name = decodeURIComponent(new URL(url).pathname.split("/").pop() || "");
        if (name && /\.[a-z0-9]{2,5}$/i.test(name)) return name;
    } catch {}
    return `web_${Date.now()}.${fallbackExt}`;
};

export async function extractWebPage(url, opts = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeout ?? requestTimeoutMs);

    let html, finalURL = url, contentType;
    try {
        const response = await fetch(url, {
            headers: {
                "user-agent": genericUserAgent,
                "accept": "text/html,application/xhtml+xml,*/*;q=0.8",
                "accept-language": "en-US,en;q=0.9",
            },
            redirect: "follow",
            signal: controller.signal,
        });

        finalURL = response.url || url;
        contentType = response.headers.get("content-type") ?? "";

        // a direct media link is already the answer
        if (!contentType.includes("html") && !contentType.includes("xml")) {
            const ext = extensionFor(contentType);
            if (ext && /^(video|audio|image)\//.test(contentType)) {
                const type = contentType.split("/")[0];
                return {
                    urls: finalURL,
                    isPhoto: type === "image",
                    filename: filenameFrom(finalURL, ext),
                };
            }
            return { error: "link.unsupported" };
        }

        html = (await response.text()).slice(0, MAX_HTML_BYTES);
    } catch (e) {
        return { error: controller.signal.aborted ? "fetch.critical" : "fetch.fail", context: e?.message };
    } finally {
        clearTimeout(timer);
    }

    const meta = metaTags(html);
    const title = titleOf(html);
    const author = meta.get("og:site_name") ?? meta.get("author");

    const candidates = dedupe([
        ...mediaElements(html).map(m => ({ ...m, url: absolute(m.url, finalURL) })),
        ...jsonLdMedia(html).map(m => ({ ...m, url: absolute(m.url, finalURL) })),
        ...(meta.get("og:video:secure_url") ? [{ type: "video", url: absolute(meta.get("og:video:secure_url"), finalURL) }] : []),
        ...(meta.get("og:video") ? [{ type: "video", url: absolute(meta.get("og:video"), finalURL) }] : []),
        ...(meta.get("og:video:url") ? [{ type: "video", url: absolute(meta.get("og:video:url"), finalURL) }] : []),
        ...(meta.get("twitter:player:stream") ? [{ type: "video", url: absolute(meta.get("twitter:player:stream"), finalURL) }] : []),
        ...(meta.get("og:audio:secure_url") ? [{ type: "audio", url: absolute(meta.get("og:audio:secure_url"), finalURL) }] : []),
        ...(meta.get("og:audio") ? [{ type: "audio", url: absolute(meta.get("og:audio"), finalURL) }] : []),
        ...(meta.get("og:image:secure_url") ? [{ type: "photo", url: absolute(meta.get("og:image:secure_url"), finalURL) }] : []),
        ...(meta.get("og:image") ? [{ type: "photo", url: absolute(meta.get("og:image"), finalURL) }] : []),
        ...(meta.get("twitter:image") ? [{ type: "photo", url: absolute(meta.get("twitter:image"), finalURL) }] : []),
    ]);

    // a video or audio stream wins over the preview image
    const playable = candidates.filter(c => c.type !== "photo");
    const usable = playable.length ? playable : candidates;

    if (!usable.length) {
        return { error: "link.unsupported" };
    }

    const fileMetadata = {};
    if (title) fileMetadata.title = title;
    if (author) fileMetadata.artist = author;

    if (usable.length > 1) {
        return {
            picker: usable.map(item => ({
                type: item.type,
                url: item.url,
                ...(meta.get("og:image") && item.type === "video"
                    ? { thumb: absolute(meta.get("og:image"), finalURL) }
                    : {}),
            })),
        };
    }

    const [item] = usable;
    const isDirectHLS = /\.m3u8(\?|$)/i.test(item.url);

    if (item.type === "photo") {
        return {
            urls: item.url,
            isPhoto: true,
            filename: filenameFrom(item.url, "jpg"),
            ...(title && { fileMetadata }),
        };
    }

    return {
        urls: item.url,
        isHLS: isDirectHLS,
        filename: filenameFrom(item.url, item.type === "audio" ? "mp3" : "mp4"),
        ...(title && { fileMetadata }),
    };
}
