// Adapter between the vendored YTubeDL provider (the upstream cobalt engine,
// MIT/ISC licensed, see vendor/ytubedl-engine/LICENSE) and the shape the
// youtube platform handler consumes.
//
// The adapter never rejects: every failure resolves to
// { ok: false, errorClass, error } which the handler maps onto an engine error.

import { YouTubeProvider } from "./platforms/vendor/ytubedl-engine/providers/youtube.js";
import { DirectProvider } from "./platforms/vendor/ytubedl-engine/providers/direct.js";
import { getCookie } from "./cookie-store.js";

const probeTimeoutMs = 45_000;

const youtubeProvider = new YouTubeProvider();
const directProvider = new DirectProvider();

// Results hold signed stream URLs; caching them for a few minutes makes batch
// runs and repeated calls effectively free.
const PROBE_TTL = 10 * 60_000;
const PROBE_CACHE_LIMIT = 40;
const probeCache = new Map();

function cacheGet(key) {
    const hit = probeCache.get(key);
    if (!hit) return;
    if (Date.now() - hit.at > PROBE_TTL) {
        probeCache.delete(key);
        return;
    }
    return hit.result;
}

function cachePut(key, result) {
    probeCache.delete(key);
    probeCache.set(key, { at: Date.now(), result });
    while (probeCache.size > PROBE_CACHE_LIMIT) {
        probeCache.delete(probeCache.keys().next().value);
    }
}

export function clearProbeCache() {
    probeCache.clear();
}

// Playlist URLs are out of scope: the engine resolves single media items.
function isYouTubeURL(url) {
    try {
        const { hostname, pathname } = new URL(url);
        const host = hostname.replace(/^www\./, "");
        return host === "youtube.com"
            || host === "m.youtube.com"
            || host === "music.youtube.com"
            || host === "youtu.be"
            || (pathname.startsWith("/watch") || pathname.startsWith("/shorts"));
    } catch {
        return false;
    }
}

export async function probeURL(url, opts = {}) {
    const key = url;
    if (!opts.refresh) {
        const cached = cacheGet(key);
        if (cached) return cached;
    }

    const provider = isYouTubeURL(url) ? youtubeProvider : directProvider;
    const result = await provider.probe(url, opts);

    // never cache formats-blocked results: a transient upstream failure would
    // otherwise poison the link for the whole TTL
    if (result.streams?.size > 0) {
        cachePut(key, result);
    }
    return result;
}

// map playability failure strings onto the bridge-style exception names the
// youtube handler classifies. order matters: bot-check reasons also contain
// "sign in", so they must be matched before age checks.
const classifyFailures = (failures) => {
    const hay = failures.join("\n").toLowerCase();

    if (hay.includes("not a bot")) return "ReCaptchaException";
    if (hay.includes("drm")) return "DrmException";
    if (hay.includes("confirm your age") || hay.includes("age-restricted")) {
        return "AgeRestrictedContentException";
    }
    if (hay.includes("private video")) return "PrivateContentException";
    if (hay.includes("country") || hay.includes("region")) {
        return "GeographicRestrictionException";
    }
    if (hay.includes("premium") || hay.includes("paid") || hay.includes("rental")) {
        return "PaidContentException";
    }
    if (hay.includes("account associated") || hay.includes("terminated")) {
        return "AccountTerminatedException";
    }
    if (hay.includes("unavailable") || hay.includes("removed")) {
        return "ContentNotAvailableException";
    }
    return "ContentNotSupportedException";
};

// the handler matches codec families ("avc1" / "vp9" / "av01") inside the
// mimeType + codec haystack; vp9's full InnerTube name ("vp09.00.51.03") would
// never match, so formats carry the family alias instead
const codecAlias = { h264: "avc1", vp9: "vp9", av1: "av01" };

const videoEntry = (f, streams) => {
    const alias = codecAlias[f.codecFamily] ?? f.codec;
    return {
        itag: f.itag,
        url: f.url ?? streams.get(f.itag)?.url,
        mimeType: `video/${f.container}; codecs="${alias}"`,
        codec: alias,
        width: f.width,
        height: f.height,
        fps: f.fps,
        bitrate: f.bitrate,
        contentLength: f.sizeBytes ?? 0,
        deliveryMethod: "PROGRESSIVE_HTTP",
    };
};

const audioEntry = (f, streams) => {
    const entry = {
        itag: f.itag,
        url: f.url ?? streams.get(f.itag)?.url,
        mimeType: f.container === "webm"
            ? 'audio/webm; codecs="opus"'
            : 'audio/mp4; codecs="mp4a.40.2"',
        codec: f.codec === "opus" ? "opus" : "mp4a",
        bitrate: f.bitrate,
        contentLength: f.sizeBytes ?? 0,
        deliveryMethod: "PROGRESSIVE_HTTP",
    };

    if (f.audioTrack) {
        entry.audioTrackId = f.audioTrack.id;
        entry.audioTrackName = f.audioTrack.name;
        if (f.audioTrack.isDefault) entry.audioTrackType = "ORIGINAL";
        // track ids look like "en.0" / "es.3": the prefix is the locale
        entry.audioLocale = (f.audioTrack.id ?? "").split(".")[0];
    }

    return entry;
};

const toHandlerJSON = ({ media, streams, captions }) => ({
    ok: true,
    id: media.id,
    title: media.title ?? "",
    uploader: media.author ?? "",
    description: media.description ?? "",
    duration: media.durationSec ?? 0,
    thumbnail: media.thumbnail,
    live: media.isLive === true,
    hls: media.hlsManifestUrl ?? null,
    // upstream cobalt never used muxed formats, so progressive entries stay out
    videoOnly: media.videoFormats
        .filter(f => !f.hasAudio && (f.url || streams.has(f.itag)))
        .map(f => videoEntry(f, streams)),
    audio: media.audioFormats
        .filter(f => f.url || streams.has(f.itag))
        .map(f => audioEntry(f, streams)),
    subtitles: media.subtitleTracks
        // po_token-locked captions reject ffmpeg's fetch; dropping them beats
        // failing the whole merge over a subtitle
        .filter(t => {
            const url = captions.get(t.id);
            return url && !url.includes("exp=xpe");
        })
        .map(t => {
            const baseUrl = captions.get(t.id);
            return {
                language: t.languageCode,
                auto: t.auto,
                // ffmpeg fetches this url itself when embedding; of youtube's
                // timedtext formats only vtt is demuxable
                url: `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}fmt=vtt`,
            };
        }),
});

export const callYTubeDL = async (url, {
    probe = probeURL,
    cookie = getCookie("youtube")?.toString(),
} = {}) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), probeTimeoutMs);

    let probeResult;
    try {
        probeResult = await probe(url, {
            signal: controller.signal,
            cookieHeader: cookie,
        });
    } catch (e) {
        if (controller.signal.aborted) {
            return {
                ok: false,
                errorClass: "EngineTimeoutException",
                error: `engine probe exceeded ${probeTimeoutMs}ms`,
            };
        }

        const failures = Array.isArray(e?.failures) ? e.failures : [];
        if (failures.length) {
            return {
                ok: false,
                errorClass: classifyFailures(failures),
                error: failures[failures.length - 1],
            };
        }

        return { ok: false, errorClass: "EngineException", error: e?.message || String(e) };
    } finally {
        clearTimeout(timer);
    }

    const { media, streams, captions, failures = [] } = probeResult ?? {};

    if (!media) {
        return { ok: false, errorClass: "EngineException", error: "probe returned no media" };
    }

    // every client failed and only oEmbed metadata came back — there is
    // nothing downloadable, so this is a content-level failure
    if (!streams?.size) {
        return {
            ok: false,
            errorClass: classifyFailures([media.note ?? "", ...failures]),
            error: media.note ?? "no playable formats",
        };
    }

    return toHandlerJSON(probeResult);
};
