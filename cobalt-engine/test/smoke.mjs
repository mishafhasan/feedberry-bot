#!/usr/bin/env node
// Offline checks for the pure parts of the engine: URL normalisation, platform
// matching, filename styles, and error shapes. No network, runs in well under
// a second. Network behaviour lives in validate.mjs.

import assert from "node:assert/strict";

import { normalizeURL, extract } from "../src/links.js";
import createFilename from "../src/naming.js";
import { resolve, resolveMany, isSupported, supportedServices } from "../index.js";

let passed = 0;
const test = (name, fn) => {
    try {
        fn();
        passed++;
    } catch (e) {
        console.error(`FAIL ${name}`);
        console.error(`  ${e.message}`);
        process.exitCode = 1;
    }
};

/* ---------------------------------- links --------------------------------- */

test("youtu.be becomes a watch url", () => {
    assert.equal(
        normalizeURL("https://youtu.be/qqb3zbTFON0?si=abc").toString(),
        "https://youtube.com/watch?v=qqb3zbTFON0"
    );
});

test("shorts become a watch url", () => {
    assert.equal(
        normalizeURL("https://www.youtube.com/shorts/qqb3zbTFON0").toString(),
        "https://www.youtube.com/watch?v=qqb3zbTFON0"
    );
});

test("x.com becomes twitter.com", () => {
    assert.equal(
        normalizeURL("https://x.com/user/status/123456789").toString(),
        "https://twitter.com/user/status/123456789"
    );
});

test("threads.com becomes threads.com", () => {
    assert.equal(
        normalizeURL("https://www.threads.com/@user/post/ABC123").toString(),
        "https://threads.com/@user/post/ABC123"
    );
});

test("tracking params are dropped", () => {
    assert.equal(
        normalizeURL("https://www.tiktok.com/@user/video/1234567890?is_from_webapp=1&x=2").toString(),
        "https://www.tiktok.com/@user/video/1234567890"
    );
});

test("the youtube id survives cleaning", () => {
    assert.equal(
        normalizeURL("https://www.youtube.com/watch?v=qqb3zbTFON0&list=PL123&t=10").toString(),
        "https://www.youtube.com/watch?v=qqb3zbTFON0"
    );
});

/* --------------------------------- matching -------------------------------- */

const matches = (url, host, expected = {}) => {
    const { host: got, patternMatch, error } = extract(normalizeURL(url));
    assert.equal(error, undefined, `expected a match, got ${error}`);
    assert.equal(got, host);
    for (const [key, value] of Object.entries(expected)) {
        assert.equal(patternMatch[key], value, `${key} mismatch`);
    }
};

test("tiktok video link", () => {
    matches("https://www.tiktok.com/@user/video/7691436084026182919", "tiktok", { postId: "7691436084026182919" });
});

test("instagram reel link", () => {
    matches("https://www.instagram.com/reel/DbndR7CNuhv/?hl=en", "instagram", { postId: "DbndR7CNuhv" });
});

test("twitter status link", () => {
    matches("https://x.com/user/status/1954587492772172079", "twitter", { id: "1954587492772172079" });
});

test("bluesky post link", () => {
    matches("https://bsky.app/profile/user.bsky.social/post/3msluxxmzdc2b", "bsky", { post: "3msluxxmzdc2b" });
});

test("threads post link", () => {
    matches("https://www.threads.com/@user/post/DeGucUNCWVS/slug", "threads", { postId: "DeGucUNCWVS" });
});

test("snapchat spotlight link", () => {
    matches("https://www.snapchat.com/@user/spotlight/ABC", "snapchat", { spotlightId: "ABC" });
});

test("tumblr post link", () => {
    matches("https://www.tumblr.com/blog/831493577877094400/slug", "tumblr", { id: "831493577877094400" });
});

test("facebook video link", () => {
    matches("https://www.facebook.com/user/videos/funny-clips/1159110793020936/", "facebook", { id: "1159110793020936" });
});

test("facebook photo link", () => {
    matches("https://web.facebook.com/photo/?fbid=1270547115300126", "facebook", { photoId: "1270547115300126" });
});

test("pinterest pin link", () => {
    matches("https://www.pinterest.com/pin/774124930871803/", "pinterest", { id: "774124930871803" });
});

test("a pin with a slug keeps the slug in the raw match", () => {
    matches("https://www.pinterest.com/pin/very-funny-video--774124930871803/", "pinterest", { id: "very-funny-video--774124930871803" });
});

test("unknown hosts are rejected", () => {
    assert.equal(extract(normalizeURL("https://example.com/watch?v=1")).error, "link.invalid");
});

test("a known host with an unknown path is rejected", () => {
    assert.equal(extract(normalizeURL("https://www.youtube.com/channel/UC123")).error, "link.unsupported");
});

test("absurdly long ids are not matchable in practice", () => {
    // the pattern still matches; the tester is what rejects it, and resolve()
    // is responsible for running the tester
    const url = normalizeURL(`https://www.youtube.com/watch?v=${"a".repeat(40)}`);
    assert.ok(extract(url).patternMatch.id.length === 40);
});

/* -------------------------------- filenames -------------------------------- */

const attributes = {
    service: "youtube",
    id: "qqb3zbTFON0",
    title: 'They Call Him "King"',
    author: "Anirudh",
    resolution: "1920x1080",
    qualityLabel: "1080p",
    youtubeFormat: "h264",
    extension: "mp4",
};

test("classic filename style", () => {
    assert.equal(
        createFilename(attributes, "classic", false, false),
        "youtube_qqb3zbTFON0_1920x1080_h264.mp4"
    );
});

test("pretty filename style", () => {
    assert.equal(
        createFilename(attributes, "pretty", false, false),
        "They Call Him ＂King＂ - Anirudh (1080p, h264, youtube).mp4"
    );
});

test("audio filenames drop the extension and gain _audio", () => {
    assert.equal(
        createFilename(attributes, "classic", true, false),
        "youtube_qqb3zbTFON0_audio"
    );
});

test("mute tags the filename", () => {
    assert.ok(createFilename(attributes, "classic", false, true).includes("mute"));
});

/* ------------------------------- public api -------------------------------- */

test("supportedServices lists every platform", () => {
    assert.deepEqual([...supportedServices].sort(), [
        "bsky", "facebook", "instagram", "pinterest", "snapchat",
        "threads", "tiktok", "tumblr", "twitter", "youtube",
    ]);
});

test("isSupported distinguishes platform links from ordinary pages", () => {
    assert.equal(isSupported("https://youtu.be/qqb3zbTFON0"), true);
    assert.equal(isSupported("https://example.com/some-post"), false);
});

const run = async () => {
    const invalid = await resolve("not a url");
    assert.equal(invalid.status, "error");
    assert.equal(invalid.error.code, "error.link.invalid");
    passed++;

    // generic fallback disabled -> an ordinary page is reported as invalid,
    // no network involved
    const noGeneric = await resolve("https://example.com/post", { generic: false });
    assert.equal(noGeneric.error.code, "error.link.invalid");
    passed++;

    const batch = await resolveMany(["not a url", "also not a url"], { concurrency: 2 });
    assert.equal(batch.length, 2);
    assert.ok(batch.every(r => r.status === "error"));
    passed++;

    // the tester rejects ids that could never resolve, before any network call
    const absurd = await resolve(`https://www.youtube.com/watch?v=${"a".repeat(40)}`);
    assert.equal(absurd.error.code, "error.link.unsupported");
    passed++;

    console.log(`${passed} checks passed`);
};

await run();
