// Runtime settings. Every value can be overridden with configure() from the
// package root. Nothing here reads process.env, so the engine stays embeddable
// in hosts that manage their own environment.

export const env = {
    // hard cap for downloadable media length, in seconds (3 hours)
    durationLimit: 10800,

    // which YouTube backend to use: "native" (built in) or "off"
    youtubeEngine: "native",

    // how long a resolved media URL stays usable, in seconds. reported in
    // results so callers know when to resolve again.
    urlLifespan: 90,

    // default video quality preference: 144..4320 or "max"
    videoQuality: "1080",

    // allow H.265/HEVC variants when the platform offers them
    allowH265: false,

    // path to cookies.json; see USER_GUIDE.md for the format
    cookiePath: undefined,
};

const CHROME_VERSION = "138.0.0.0";

export const genericUserAgent =
    `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_VERSION} Safari/537.36`;

// Some platforms (tiktok) answer the desktop fingerprint with a bot challenge
// page but serve the real document to a mobile one.
export const mobileUserAgent =
    `Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_VERSION} Mobile Safari/537.36`;

export const cobaltUserAgent = "cobalt-engine/1.0 (+https://github.com/imputnet/cobalt)";

export function configure(overrides = {}) {
    for (const [key, value] of Object.entries(overrides)) {
        if (value === undefined) continue;
        env[key] = value;
    }
    return env;
}
