/**
 * cobalt-engine — standalone media extraction.
 *
 *   import { resolve, download } from "cobalt-engine";
 *
 *   const media = await resolve("https://youtu.be/qqb3zbTFON0");
 *   await download(media, { dir: "./downloads" });
 *
 * Resolution is metadata-only and cheap. Downloading is a separate, optional
 * step, so the engine is equally useful for link previews as for saving files.
 */

export { resolve, resolveMany, PLATFORMS } from "./src/engine.js";
export { download, hasFFmpeg, sizeOf } from "./src/download.js";
export { configure, env } from "./src/settings.js";
export { loadCookies, stopCookieFlush } from "./src/cookie-store.js";
export { extract, normalizeURL } from "./src/links.js";
export { extractWebPage } from "./src/web.js";

import { extract as extractLink, normalizeURL } from "./src/links.js";

export const VERSION = "1.0.0";

/** Platforms with a dedicated extractor (before the generic web fallback). */
export const supportedServices = [
    "instagram",
    "twitter",
    "tiktok",
    "youtube",
    "facebook",
    "threads",
    "tumblr",
    "pinterest",
    "snapchat",
    "bsky",
];

/**
 * Does this link target a platform with a dedicated extractor?
 * Generic web pages return false but are still downloadable via resolve().
 */
export function isSupported(input) {
    try {
        return !extractLink(normalizeURL(input)).error;
    } catch {
        return false;
    }
}
