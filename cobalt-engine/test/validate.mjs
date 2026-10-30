#!/usr/bin/env node
// Resolve every link in links.json and report what happened.
//
//   node test/validate.mjs             resolve only (fast, no media bytes)
//   node test/validate.mjs --download  also download and verify bytes land
//   node test/validate.mjs --only yt   run a subset by name substring
//
// Exit code is 0 when every link resolved, 1 otherwise, so it works in CI.

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, open, rm, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

import { resolve, download, hasFFmpeg } from "../index.js";

const here = dirname(fileURLToPath(import.meta.url));
const args = new Set(process.argv.slice(2));

const onlyArg = process.argv.find(a => a.startsWith("--only="))?.split("=")[1]
    ?? (args.has("--only") ? process.argv[process.argv.indexOf("--only") + 1] : undefined);

const shouldDownload = args.has("--download");

// links.json holds the acceptance set; links-extra.json adds platform coverage
// the acceptance set does not reach (pinterest pins, generic web pages, direct
// media URLs).
const links = {};
for (const file of ["links.json", "links-extra.json"]) {
    try {
        Object.assign(links, JSON.parse(await readFile(join(here, file), "utf8")));
    } catch (e) {
        if (file === "links.json") throw e;
    }
}

const entries = Object.entries(links)
    .filter(([name]) => !onlyArg || name.includes(onlyArg));

if (!entries.length) {
    console.error("no links matched");
    process.exit(1);
}

const pad = (s, n) => String(s ?? "").padEnd(n).slice(0, n);

// A file that downloads successfully can still be an HTML error page, a
// login wall, or a zeroed placeholder. Check the container signature, then
// let ffprobe confirm the stream is decodable when it is available.
const sniff = async (file) => {
    const handle = await open(file, "r");
    try {
        const { buffer, bytesRead } = await handle.read(Buffer.alloc(16), 0, 16, 0);
        const b = buffer.subarray(0, bytesRead);

        if (b.subarray(4, 8).toString("ascii") === "ftyp") return "mp4";
        if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "webm";
        if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
        if (b[0] === 0x89 && b.subarray(1, 4).toString("ascii") === "PNG") return "png";
        if (b.subarray(0, 3).toString("ascii") === "GIF") return "gif";
        if (b.subarray(8, 12).toString("ascii") === "WEBP") return "webp";
        if (b.subarray(4, 8).toString("ascii") === "styp") return "fmp4";
        if (b.subarray(0, 3).toString("ascii") === "ID3") return "mp3";
        if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return "mpeg-audio";
        if (b.subarray(0, 4).toString("ascii") === "fLaC") return "flac";
        if (b.subarray(0, 4).toString("ascii") === "OggS") return "ogg";

        const head = b.toString("utf8").trimStart().toLowerCase();
        if (head.startsWith("<!doctype") || head.startsWith("<html") || head.startsWith("{")) {
            return "NOT-MEDIA";
        }

        return "unknown";
    } finally {
        await handle.close();
    }
};

const ffprobe = (file) => {
    const probe = spawnSync("ffprobe", [
        "-v", "error",
        "-show_entries", "format=duration,format_name",
        "-of", "json",
        file,
    ], { encoding: "utf8" });

    if (probe.error) return { available: false };
    if (probe.status !== 0) return { available: true, ok: false, error: probe.stderr.trim().split("\n").pop() };

    try {
        const format = JSON.parse(probe.stdout).format ?? {};
        return { available: true, ok: true, format: format.format_name, duration: Number(format.duration) || 0 };
    } catch {
        return { available: true, ok: false, error: "unparsable ffprobe output" };
    }
};

let ffprobeAvailable = null;
const failures = [];
const downloadDir = shouldDownload
    ? await mkdtemp(join(tmpdir(), "cobalt-engine-validate-"))
    : undefined;

console.log(`resolving ${entries.length} link(s)${shouldDownload ? ", then downloading" : ""}`);
console.log(`ffmpeg: ${hasFFmpeg() ? "yes" : "no"}`);
console.log("");
console.log(`${pad("name", 26)}${pad("service", 11)}${pad("type", 8)}${pad("ms", 7)}detail`);
console.log("-".repeat(100));

for (const [name, url] of entries) {
    const started = Date.now();
    let result;

    try {
        result = await resolve(url);
    } catch (e) {
        result = { status: "error", error: { code: "threw", context: { message: e?.message } } };
    }

    const elapsed = Date.now() - started;

    if (result.status !== "ok") {
        const detail = `${result.error?.code ?? "unknown"} ${result.error?.context?.message ?? ""}`.trim();
        console.log(`${pad(name, 26)}${pad(result.error?.context?.service ?? "-", 11)}${pad("-", 8)}${pad(elapsed, 7)}${detail}`);
        failures.push({ name, url, code: result.error?.code, detail });
        continue;
    }

    const count = result.picker ? `${result.picker.length} items` : `${result.urls.length} url${result.urls.length > 1 ? "s" : ""}`;
    let detail = `${count} | ${result.filename ?? "no filename"}`;

    if (shouldDownload) {
        try {
            const saved = await download(result, { dir: downloadDir });
            if (saved.status !== "ok") {
                detail += ` | DOWNLOAD FAILED ${saved.error?.code}`;
                failures.push({ name, url, code: saved.error?.code, detail });
            } else {
                let bytes = 0;
                const kinds = [];

                for (const file of saved.files) {
                    bytes += (await stat(file)).size;

                    const kind = await sniff(file);
                    kinds.push(kind);

                    if (kind === "NOT-MEDIA" || kind === "unknown") {
                        failures.push({ name, url, code: "not_media", detail: `${file} looks like ${kind}` });
                    }

                    if (ffprobeAvailable === null) ffprobeAvailable = ffprobe(file).available;
                    if (ffprobeAvailable) {
                        const info = ffprobe(file);
                        if (!info.ok) {
                            failures.push({ name, url, code: "undecodable", detail: `${file}: ${info.error}` });
                        }
                    }
                }

                detail += ` | saved ${saved.files.length} file(s), ${(bytes / 1048576).toFixed(2)} MB${saved.muxed ? ", muxed" : ""} [${[...new Set(kinds)].join(",")}]`;

                if (bytes < 1024) {
                    detail += " | SUSPICIOUS: under 1KB";
                    failures.push({ name, url, code: "too_small", detail });
                }
            }
        } catch (e) {
            detail += ` | DOWNLOAD THREW ${e?.message}`;
            failures.push({ name, url, code: "download_threw", detail });
        }
    }

    console.log(`${pad(name, 26)}${pad(result.service, 11)}${pad(result.type, 8)}${pad(elapsed, 7)}${detail}`);
}

if (downloadDir) {
    await rm(downloadDir, { recursive: true, force: true }).catch(() => {});
}

console.log("");
console.log(`${entries.length - failures.length}/${entries.length} ok`);

if (failures.length) {
    console.log("");
    for (const f of failures) {
        console.log(`FAIL ${f.name}: ${f.code} — ${f.detail}`);
    }
    process.exit(1);
}
