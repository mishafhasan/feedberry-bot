#!/usr/bin/env node
// cobalt-engine CLI
//
//   cobalt-engine <url...>                 print resolved media as JSON
//   cobalt-engine <url> --download         save to ./downloads
//   cobalt-engine <url> -o ./media -a      audio only, save to ./media
//   cobalt-engine --json <file.json>       batch, one URL per line

import { parseArgs } from "node:util";

import { resolve, resolveMany, download, hasFFmpeg, VERSION } from "../index.js";

const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
        download: { type: "boolean", short: "d" },
        output: { type: "string", short: "o" },
        audio: { type: "boolean", short: "a" },
        mute: { type: "boolean" },
        "quality": { type: "string", short: "q" },
        "filename-style": { type: "string" },
        "no-metadata": { type: "boolean" },
        "no-generic": { type: "boolean" },
        "concurrency": { type: "string", short: "c" },
        "pretty": { type: "boolean", default: true },
        "quiet": { type: "boolean" },
    },
});

const USAGE = `cobalt-engine ${VERSION}

Usage:
  cobalt-engine <url...> [options]

Options:
  -d, --download          save media to disk (default: print metadata only)
  -o, --output <dir>      download directory (default: ./downloads)
  -a, --audio             extract audio only
      --mute              strip audio from video
  -q, --quality <px>      video quality: 144..4320 or max
      --filename-style    classic | basic | pretty | nerdy
      --no-metadata       omit title/artist metadata from output
      --no-generic        do not fall back to the web-page extractor
  -c, --concurrency <n>   parallel resolves for multiple URLs (default 4)
      --quiet             only print the output file paths
  -h, --help              show this help
  -v, --version           print version

Examples:
  cobalt-engine https://youtu.be/qqb3zbTFON0
  cobalt-engine -d -o ./media https://www.instagram.com/reel/XXXX/
  cobalt-engine --audio -d https://x.com/user/status/123

ffmpeg: ${hasFFmpeg() ? "found — video+audio will be muxed" : "not found — YouTube videos save as separate video and audio files"}
`;

if (values.help) {
    console.log(USAGE);
    process.exit(0);
}

if (values.version) {
    console.log(VERSION);
    process.exit(0);
}

if (!positionals.length) {
    console.error(USAGE);
    process.exit(1);
}

const options = {
    mode: values.audio ? "audio" : values.mute ? "mute" : "video",
    quality: values.quality ?? undefined,
    filenameStyle: values["filename-style"] ?? undefined,
    metadata: !values["no-metadata"],
    generic: !values["no-generic"],
};

const quiet = values.quiet;

async function main() {
    const resolved = await resolveMany(positionals, {
        ...options,
        concurrency: Number(values.concurrency) || 4,
    });

    const output = [];

    for (const [i, result] of resolved.entries()) {
        if (result.status !== "ok") {
            output.push({ input: positionals[i], ...result });
            if (!quiet) console.error(`[!] ${positionals[i]}: ${result.error?.code}`);
            continue;
        }

        if (!values.download) {
            output.push({ input: positionals[i], ...result });
            continue;
        }

        const saved = await download(result, {
            dir: values.output ?? "./downloads",
            onProgress: values.quiet ? undefined : ({ received, total }) => {
                if (!total) return;
                process.stderr.write(`\r${Math.round((received / total) * 100)}% (${(received / 1048576).toFixed(1)} MB)   `);
            },
        });

        if (!quiet) process.stderr.write("\r");

        output.push({ input: positionals[i], ...saved });
    }

    // machine readable on purpose: this CLI is meant to be piped
    console.log(JSON.stringify(positionals.length === 1 ? output[0] : output, null, 2));
}

main().catch((e) => {
    console.error(e?.stack ?? e);
    process.exit(1);
});
