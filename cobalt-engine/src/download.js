// Streaming downloads to disk.
//
// The engine never buffers a whole media file: bytes go from the socket to the
// file handle. ffmpeg is only spawned when the chosen format cannot be a single
// file on its own (separate video+audio tracks, HLS playlists, gif conversion),
// and it is detected once per process.

import { createWriteStream } from "node:fs";
import { access, mkdir, open, rename, rm, stat } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { constants as fsConstants } from "node:fs";
import { join, resolve as resolvePath, basename } from "node:path";
import { tmpdir } from "node:os";

import { fetch } from "./net.js";
import { resolve } from "./engine.js";
import { sanitizeString } from "./naming.js";
import { splitFilenameExtension } from "./helpers.js";

let ffmpegBin;

/** Is ffmpeg available? Detected once, then cached for the process lifetime. */
export function hasFFmpeg() {
    if (ffmpegBin !== undefined) return !!ffmpegBin;

    for (const bin of ["ffmpeg", "ffmpeg.exe"]) {
        const probe = spawnSync(bin, ["-version"], { stdio: "ignore" });
        if (!probe.error && probe.status === 0) {
            ffmpegBin = bin;
            return true;
        }
    }

    ffmpegBin = null;
    return false;
}

export function ffmpegPath() {
    return ffmpegBin;
}

function safeName(name, fallback) {
    const cleaned = sanitizeString(basename(name || fallback || "download"))
        .replace(/[\u0000-\u001F]/g, "")
        .trim();

    // "." and ".." would escape the target directory
    if (!cleaned || cleaned === "." || cleaned === "..") return fallback || "download";
    return cleaned;
}

async function uniquePath(dir, filename) {
    const [stem, ext] = splitFilenameExtension(filename);
    let candidate = join(dir, filename);
    let n = 1;

    while (true) {
        try {
            await access(candidate, fsConstants.F_OK);
            candidate = join(dir, `${stem} (${n++})${ext ? `.${ext}` : ""}`);
        } catch {
            return candidate;
        }
    }
}

// CDNs frequently serve a different image format than the URL extension
// claims (bluesky hands out webp behind .jpg names). Fix the name so the file
// opens in whatever the user double-clicks it with.
const acceptedImageExt = {
    jpeg: new Set(["jpg", "jpeg"]),
    png: new Set(["png"]),
    webp: new Set(["webp"]),
    gif: new Set(["gif"]),
    avif: new Set(["avif"]),
};

const imageExt = new Set(["jpg", "jpeg", "png", "webp", "gif", "avif"]);

async function sniffImage(file) {
    const handle = await open(file, "r");
    try {
        const { buffer } = await handle.read(Buffer.alloc(16), 0, 16, 0);

        if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "jpeg";
        if (buffer[0] === 0x89 && buffer.subarray(1, 4).toString("ascii") === "PNG") return "png";
        if (buffer.subarray(0, 3).toString("ascii") === "GIF") return "gif";
        if (buffer.subarray(8, 12).toString("ascii") === "WEBP") return "webp";
        if (buffer.subarray(4, 11).toString("ascii") === "ftypavi") return "avif";
    } finally {
        await handle.close();
    }
}

async function alignImageExtension(file) {
    const detected = await sniffImage(file);
    if (!detected) return file;

    const [stem, ext] = splitFilenameExtension(file);
    const current = (ext ?? "").toLowerCase();

    // audio and video containers share boxes with some sniff results, so only
    // touch files that were named as images
    if (!imageExt.has(current)) return file;
    if (acceptedImageExt[detected].has(current)) return file;

    const corrected = `${stem}.${detected === "jpeg" ? "jpg" : detected}`;
    await rename(file, corrected);
    return corrected;
}

async function streamToFile(url, destination, { headers, signal, onProgress, attempts = 2 } = {}) {
    for (let attempt = 1; ; attempt++) {
        try {
            const response = await fetch(url, { headers, signal });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status} for media URL`);
            }
            if (!response.body) {
                throw new Error("empty response body");
            }

            const total = Number(response.headers.get("content-length")) || 0;
            let received = 0;

            const source = Readable.fromWeb(response.body);

            if (onProgress) {
                source.on("data", (chunk) => {
                    received += chunk.length;
                    onProgress({ received, total });
                });
            }

            await pipeline(source, createWriteStream(destination));
            return { bytes: received, total };
        } catch (e) {
            // CDNs drop long transfers now and then. Drop the partial file so a
            // retry starts clean and a failed run leaves nothing half-written.
            await rm(destination, { force: true }).catch(() => {});

            const retryable = attempt < attempts
                && !signal?.aborted
                && !/^HTTP 4\d\d/.test(e?.message ?? "");

            if (!retryable) throw e;
        }
    }
}

function runFFmpeg(args) {
    return new Promise((resolvePromise, reject) => {
        const child = spawn(ffmpegBin, args, { stdio: ["ignore", "ignore", "pipe"] });

        let stderr = "";
        child.stderr.on("data", (d) => {
            stderr += d.toString();
            // ffmpeg is chatty; only the tail matters for diagnostics
            if (stderr.length > 8192) stderr = stderr.slice(-4096);
        });

        child.on("error", reject);
        child.on("close", (code) => {
            if (code === 0) resolvePromise();
            else reject(new Error(`ffmpeg exited with ${code}: ${stderr.trim().split("\n").pop() ?? ""}`));
        });
    });
}

async function mux(videoPath, audioPath, outputPath) {
    const [videoExt] = splitFilenameExtension(videoPath).reverse();
    const args = [
        "-y",
        "-i", videoPath,
        "-i", audioPath,
        "-c", "copy",
        ...(videoExt === "mp4" ? ["-movflags", "+faststart"] : []),
        outputPath,
    ];
    await runFFmpeg(args);
}

async function remuxHLS(url, outputPath) {
    const args = [
        "-y",
        "-headers", "Referer: https://www.youtube.com/\r\n",
        "-i", url,
        "-c", "copy",
        "-bsf:a", "aac_adtstoasc",
        outputPath,
    ];
    await runFFmpeg(args);
}

/**
 * Download a link (or an already resolved result) to disk.
 *
 * @param {string|object} input URL, or a result from resolve()
 * @param {object} [options]
 * @param {string} [options.dir] target directory, defaults to cwd
 * @param {string} [options.filename] override the resolved filename
 * @param {number} [options.index] pick one item when the result is a picker
 * @param {boolean} [options.mux] merge separate video+audio with ffmpeg (default true)
 * @param {Function} [options.onProgress] ({ received, total, file })
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<object>} { status, files, muxed, skipped }
 */
export async function download(input, options = {}) {
    const result = typeof input === "string" ? await resolve(input, options) : input;

    if (!result || result.status !== "ok") {
        return { status: "error", error: result?.error ?? { code: "error.fetch.empty" } };
    }

    const dir = resolvePath(options.dir ?? process.cwd());
    await mkdir(dir, { recursive: true });

    const { signal, onProgress, mux: shouldMux = true } = options;

    const items = result.picker
        ? Number.isInteger(options.index)
            ? [result.picker[options.index]].filter(Boolean)
            : result.picker
        : null;

    const headers = result.headers;

    // a carousel or gallery: every item is its own file
    if (items) {
        const files = [];
        for (const [i, item] of items.entries()) {
            const ext = splitFilenameExtension(item.url.split("?")[0]).reverse()[0] || "bin";
            const name = safeName(
                options.filename
                    ? `${splitFilenameExtension(options.filename)[0]}_${i + 1}.${ext}`
                    : `${splitFilenameExtension(result.filename ?? `item`)[0]}_${i + 1}.${ext}`,
                `item_${i + 1}.${ext}`
            );
            const target = await uniquePath(dir, name);
            await streamToFile(item.url, target, { headers, signal, onProgress: onProgress && (p => onProgress({ ...p, file: target })) });
            files.push(await alignImageExtension(target));
        }
        return { status: "ok", files, muxed: false };
    }

    if (!result.urls?.length) {
        return { status: "error", error: { code: "error.fetch.empty" } };
    }

    const baseName = safeName(options.filename ?? result.filename, "download");
    const [stem, ext] = splitFilenameExtension(baseName);

    // single stream
    if (result.urls.length === 1) {
        const [url] = result.urls;

        if (result.isHLS) {
            if (!hasFFmpeg()) {
                return {
                    status: "error",
                    error: {
                        code: "error.download.ffmpeg_required",
                        context: { message: "HLS streams need ffmpeg on PATH" },
                    },
                };
            }
            const target = await uniquePath(dir, baseName);
            await remuxHLS(url, target);
            return { status: "ok", files: [target], muxed: true };
        }

        const target = await uniquePath(dir, baseName);
        await streamToFile(url, target, {
            headers,
            signal,
            onProgress: onProgress && (p => onProgress({ ...p, file: target })),
        });
        return { status: "ok", files: [await alignImageExtension(target)], muxed: false };
    }

    // separate video + audio tracks
    const [videoURL, audioURL] = result.urls;
    const workDir = join(tmpdir(), `cobalt-engine-${process.pid}-${Date.now()}`);
    await mkdir(workDir, { recursive: true });

    try {
        const videoPath = join(workDir, `video.${ext || "mp4"}`);
        await streamToFile(videoURL, videoPath, {
            headers,
            signal,
            onProgress: onProgress && (p => onProgress({ ...p, file: "video" })),
        });

        const audioExt = /\.(m4a|mp3|opus|ogg|webm)(\?|$)/i.exec(audioURL)?.[1] ?? "m4a";
        const audioPath = join(workDir, `audio.${audioExt}`);
        await streamToFile(audioURL, audioPath, { headers, signal });

        if (shouldMux && hasFFmpeg()) {
            const target = await uniquePath(dir, baseName);
            await mux(videoPath, audioPath, target);
            return { status: "ok", files: [target], muxed: true };
        }

        // no ffmpeg: keep both tracks rather than silently dropping audio
        const videoTarget = await uniquePath(dir, baseName);
        await rename(videoPath, videoTarget);

        const audioTarget = await uniquePath(dir, `${stem}.${audioExt}`);
        await rename(audioPath, audioTarget);

        return {
            status: "ok",
            files: [videoTarget, audioTarget],
            muxed: false,
            note: "ffmpeg not found: video and audio were saved as separate files",
        };
    } finally {
        await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
}

/** Byte size of the files a download produced. */
export async function sizeOf(files) {
    let total = 0;
    for (const file of files) {
        total += (await stat(file)).size;
    }
    return total;
}
