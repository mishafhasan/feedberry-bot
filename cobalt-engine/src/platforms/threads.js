import { createRequire } from "node:module";

import { fetch as undiciFetch } from "../net.js";

import { createStream } from "../compat.js";

const require = createRequire(import.meta.url);
const { threads } = require("./vendor/threads-downloader-engine.cjs");

// cobalt videoQuality -> engine rendition
const mapQuality = quality => {
    const q = Number(quality);
    if (q <= 360) return "lowest";
    if (q <= 720) return "medium";
    return "best";
}

// The whole caption travels with the media (same contract as instagram.js); a headline alone
// left long posts without their words in the bot's caption.
const postCaption = post => (post.caption || "").trim()

export default async function ({ postId, username, quality, dispatcher }) {
    // username is accepted for pattern symmetry, the engine
    // resolves everything from the bare shortcode

    let result;
    try {
        result = await threads.extract(postId, {
            quality: mapQuality(quality),
            ...(dispatcher ? {
                fetchImpl: (url, init) => undiciFetch(url, { ...init, dispatcher })
            } : {})
        });
    } catch (e) {
        result = { ok: false, code: e?.code || "unknown", error: e?.message };
    }

    if (!result.ok) {
        switch (result.code) {
            case "not-found":
                return { error: "content.post.unavailable" };
            case "rate-limited":
                return { error: "fetch.rate" };
            default:
                return { error: "fetch.fail" };
        }
    }

    const post = result.post;
    if (!post.media?.length) {
        return { error: "content.post.unavailable" };
    }

    const originalRequest = {
        postId,
        quality,
        dispatcher: undefined
    };

    const title = postCaption(post);

    if (post.media.length > 1) {
        const picker = post.media.map((m, i) => ({
            type: m.kind === "video" ? "video" : "photo",
            url: m.url,
            thumb: createStream({
                service: "threads",
                type: "proxy",
                url: m.kind === "video" ? (m.posterUrl || m.previewUrl) : (m.previewUrl || m.url),
                filename: `threads_${post.code}_${i + 1}.jpg`,
            }),
        }));

        if (picker.length) return { picker, ...(title && { fileMetadata: { title } }) };
    }

    const media = post.media[0];

    if (media.kind === "video") {
        return {
            urls: media.url,
            filename: `threads_${post.code}.mp4`,
            audioFilename: `threads_${post.code}_audio`,
            ...(title && { fileMetadata: { title } }),
            originalRequest,
        }
    }

    return {
        isPhoto: true,
        urls: media.url,
        filename: `threads_${post.code}.jpg`,
        ...(title && { fileMetadata: { title } }),
        originalRequest,
    }
}
