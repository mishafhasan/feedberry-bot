// Batch resolution with bounded concurrency. A failing link never stops the
// rest: each entry carries its own result, so you can report per-link status.

import { resolveMany, download } from "../index.js";

const links = [
    "https://www.tiktok.com/@totatwity3/video/7691436084026182919",
    "https://youtu.be/qqb3zbTFON0",
    "https://www.threads.com/@jakhminawal/post/DeGucUNCWVS/video-funny-comedy-video-viral",
    "https://bsky.app/profile/funnysnarkyjoke.bsky.social/post/3msluxxmzdc2b",
];

const results = await resolveMany(links, { concurrency: 4, quality: "720" });

for (const [i, result] of results.entries()) {
    const link = links[i];

    if (result.status !== "ok") {
        console.log(`skip  ${link} — ${result.error.code}`);
        continue;
    }

    const saved = await download(result, { dir: "./downloads" });
    const size = saved.files.length === 1 ? "1 file" : `${saved.files.length} files`;

    console.log(`ok    ${result.service.padEnd(10)} ${size}${saved.muxed ? ", muxed" : ""} — ${result.filename}`);
}
