// Resolve a link and save it. The two steps are separate on purpose: resolve()
// is cheap enough to call for a preview, download() is the expensive part.

import { resolve, download } from "../index.js";

const url = process.argv[2] ?? "https://youtu.be/qqb3zbTFON0";

const media = await resolve(url);

if (media.status !== "ok") {
    console.error("could not resolve:", media.error);
    process.exit(1);
}

console.log("service :", media.service);
console.log("type    :", media.type);
console.log("filename:", media.filename);
console.log("urls    :", media.urls.length);

const saved = await download(media, {
    dir: "./downloads",
    onProgress: ({ received, total }) => {
        if (total) process.stderr.write(`\r${Math.round((received / total) * 100)}%`);
    },
});

process.stderr.write("\r");
console.log("saved   :", saved.files);
