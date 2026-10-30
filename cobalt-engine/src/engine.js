// The engine: one URL in, a normalised download descriptor out.
//
// Everything platform specific lives in ./platforms. This module owns the
// order of operations (normalise -> match -> dispatch -> normalise result) and
// is the only place that knows what a result looks like.

import { env } from "./settings.js";
import { extract, normalizeURL, resolveRedirectingURL } from "./links.js";
import { friendlyServiceName, testers } from "./registry.js";
import { getType } from "./mime-types.js";
import createFilename from "./naming.js";
import { extractWebPage } from "./web.js";

import tiktok from "./platforms/tiktok.js";
import instagram from "./platforms/instagram.js";
import twitter from "./platforms/twitter.js";
import bluesky from "./platforms/bluesky.js";
import snapchat from "./platforms/snapchat.js";
import tumblr from "./platforms/tumblr.js";
import pinterest from "./platforms/pinterest.js";
import facebook from "./platforms/facebook.js";
import youtube from "./platforms/youtube.js";
import threads from "./platforms/threads.js";

export const PLATFORMS = [
    "instagram", "twitter", "tiktok", "youtube", "facebook",
    "threads", "tumblr", "pinterest", "snapchat", "bsky",
];

const fail = (code, context) => ({
    status: "error",
    error: { code, ...(context && { context }) },
});

// Turn a raw handler result into the public result shape. Handlers speak the
// same dialect the upstream cobalt API used, which keeps them easy to update
// from upstream without translation layers.
function normalize(r, {
    service,
    mode,
    filenameStyle,
    metadata,
    convertGif,
    idHint,
}) {
    if (!r) return fail("error.fetch.empty", { service });

    const isAudioOnly = mode === "audio" || r.isAudioOnly === true;
    const isAudioMuted = mode === "mute";

    let urls = r.urls;
    if (typeof urls === "string") {
        urls = [urls];
    } else if (Array.isArray(urls)) {
        urls = urls.filter(Boolean);
    } else {
        urls = [];
    }

    if (isAudioOnly && urls.length > 1) urls = [urls[1]];
    if (isAudioMuted && urls.length > 1) urls = [urls[0]];

    let type = r.isPhoto ? "photo"
        : r.picker ? "picker"
        : r.isGif && convertGif ? "gif"
        : isAudioOnly ? "audio"
        : isAudioMuted ? "mute"
        : r.isHLS ? "hls"
        : "video";

    let filename = r.filenameAttributes
        ? createFilename(r.filenameAttributes, filenameStyle, isAudioOnly, isAudioMuted)
        : r.filename;

    // A collection has no single name; use a stable base so the downloader can
    // suffix each item without guessing.
    if (!filename && type === "picker") {
        filename = `${service}_${idHint}`;
    }

    if (type === "audio" && filename) {
        const format = r.bestAudio && isAudioOnly ? r.bestAudio : undefined;
        if (format && !filename.endsWith(`.${format}`)) filename = `${filename}.${format}`;
    }

    if (type === "gif" && filename) {
        filename = `${filename.replace(/\.[^.]+$/, "")}.gif`;
    }

    const picker = r.picker?.map(item => ({
        type: item.type === "video" ? "video" : "photo",
        url: item.url,
        ...(item.thumb && { thumb: item.thumb }),
    }));

    return {
        status: "ok",
        service,
        type: picker ? "picker" : type,
        filename: filename || undefined,
        mime: getType(filename) || undefined,
        urls: picker ? picker.map(p => p.url) : urls,
        ...(picker && { picker }),
        ...(urls.length > 1 && !picker && { requiresMux: true }),
        ...(r.headers && { headers: r.headers }),
        ...(r.isHLS && { isHLS: true }),
        ...(r.subtitles && { subtitles: r.subtitles }),
        ...(metadata && r.fileMetadata && { metadata: r.fileMetadata }),
        ...(env.urlLifespan && type !== "picker" && { expiresIn: env.urlLifespan }),
    };
}

async function dispatch(host, patternMatch, params, url) {
    switch (host) {
        case "twitter":
            return twitter({
                id: patternMatch.id,
                index: patternMatch.index - 1,
                toGif: !!params.convertGif,
                alwaysProxy: params.alwaysProxy,
                subtitleLang: params.subtitleLang,
            });

        case "tiktok":
            return tiktok({
                postId: patternMatch.postId,
                shortLink: patternMatch.shortLink,
                fullAudio: params.tiktokFullAudio,
                isAudioOnly: params.mode === "audio",
                h265: params.allowH265,
                alwaysProxy: params.alwaysProxy,
                subtitleLang: params.subtitleLang,
            });

        case "tumblr":
            return tumblr({
                id: patternMatch.id,
                user: patternMatch.user,
                url,
            });

        case "instagram":
            return instagram({
                ...patternMatch,
                quality: params.quality,
                alwaysProxy: params.alwaysProxy,
            });

        case "threads":
            return threads({
                ...patternMatch,
                quality: params.quality,
                alwaysProxy: params.alwaysProxy,
            });

        case "pinterest":
            return pinterest({
                id: patternMatch.id,
                shortLink: patternMatch.shortLink || false,
            });

        case "snapchat":
            return snapchat({
                ...patternMatch,
                alwaysProxy: params.alwaysProxy,
            });

        case "facebook":
            return facebook(patternMatch);

        case "bsky":
            return bluesky({
                ...patternMatch,
                alwaysProxy: params.alwaysProxy,
            });

        case "youtube": {
            const isAudioOnly = params.mode === "audio";
            return youtube({
                id: patternMatch.id.slice(0, 11),
                quality: isAudioOnly ? "max" : params.quality,
                codec: params.youtubeVideoCodec ?? "h264",
                container: params.youtubeVideoContainer ?? "auto",
                isAudioOnly,
                isAudioMuted: params.mode === "mute",
                dubLang: params.youtubeDubLang,
                youtubeHLS: false,
                subtitleLang: params.subtitleLang,
            });
        }

        default:
            return { error: "service.unsupported" };
    }
}

const DEFAULTS = {
    quality: undefined,          // 144..4320 | "max"
    mode: "video",              // video | audio | mute
    filenameStyle: "pretty",    // classic | basic | pretty | nerdy
    metadata: true,             // include title/artist/etc in the result
    convertGif: false,
    allowH265: undefined,
    alwaysProxy: false,         // hint only, see compat.js
    subtitleLang: undefined,
    generic: true,              // fall back to the web-page extractor
    signal: undefined,
};

/**
 * Resolve a link into downloadable media.
 *
 * @param {string} input
 * @param {object} [options] see DEFAULTS
 * @returns {Promise<object>} result descriptor, or { status: "error" }
 */
export async function resolve(input, options = {}) {
    // callers routinely pass {quality: undefined} from a CLI or config object;
    // those must not clobber the defaults
    const params = { ...DEFAULTS };
    for (const [key, value] of Object.entries(options)) {
        if (value !== undefined) params[key] = value;
    }

    if (params.quality === undefined) params.quality = env.videoQuality;
    if (params.allowH265 === undefined) params.allowH265 = env.allowH265;

    if (params.signal?.aborted) return fail("error.request.cancelled");

    let url;
    try {
        url = normalizeURL(input);
    } catch {
        return fail("error.link.invalid");
    }

    const matched = extract(url);

    // Unknown host: any ordinary page may still carry playable media, so give
    // the generic extractor a chance before giving up.
    if (matched.error) {
        const retryable = matched.error === "link.invalid"
            || matched.error === "service.unsupported"
            || matched.error === "link.unsupported";

        if (!params.generic || !retryable) {
            return fail(`error.${matched.error}`, matched.context);
        }

        return resolveGeneric(input, params);
    }

    const { host, patternMatch } = matched;

    // pattern match only proves the shape of the URL; the tester rejects ids
    // that are absurdly long and would never resolve
    if (!testers[host]?.(patternMatch)) {
        return fail("error.link.unsupported", { service: friendlyServiceName(host) });
    }

    let r;
    try {
        r = await dispatch(host, patternMatch, params, url);
    } catch (e) {
        return fail("error.fetch.critical", { service: friendlyServiceName(host), message: e?.message });
    }

    if (r?.error && r.critical) {
        return fail(`error.${r.error}`, { service: friendlyServiceName(host) });
    }

    if (r?.error) {
        const context = { service: friendlyServiceName(host) };
        if (r.error === "content.too_long") {
            context.limit = parseFloat((env.durationLimit / 60).toFixed(2));
        }
        return fail(`error.${r.error}`, context);
    }

    const result = normalize(r, {
        service: host,
        idHint: patternMatch.postId ?? patternMatch.id ?? patternMatch.spotlightId ?? patternMatch.shortLink ?? "media",
        ...params,
    });

    // share links that bounce between platforms (tiktok vm., snapchat /t/)
    // only reveal their post after one hop
    if (result.status === "error" && result.error.code === "error.fetch.fail") {
        return resolveGeneric(input, params);
    }

    return result;
}

async function resolveGeneric(input, params) {
    let r;
    try {
        r = await extractWebPage(input, { signal: params.signal });
    } catch (e) {
        return fail("error.fetch.fail", { message: e?.message });
    }

    if (r?.error) {
        return fail(`error.${r.error}`, { service: "web", ...r.context && { context: r.context } });
    }

    let idHint = "page";
    try {
        idHint = new URL(input).hostname.replace(/^www\./, "");
    } catch {}

    return normalize(r, { service: "web", idHint, ...params });
}

/**
 * Resolve many links with bounded concurrency. A failing link never fails the
 * batch; each entry keeps its own result.
 */
export async function resolveMany(inputs, options = {}) {
    const { concurrency = 4, ...rest } = options;
    const results = new Array(inputs.length);
    let cursor = 0;

    const worker = async () => {
        while (cursor < inputs.length) {
            const index = cursor++;
            results[index] = await resolve(inputs[index], rest);
        }
    };

    await Promise.all(
        Array.from({ length: Math.min(concurrency, inputs.length) }, worker)
    );

    return results;
}

export { resolveRedirectingURL };
