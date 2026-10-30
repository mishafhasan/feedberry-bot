# cobalt-engine — user guide

Everything you need to drop this engine into a project, wire it to real traffic, and keep it working.

- [1. What is in the box](#1-what-is-in-the-box)
- [2. Install it](#2-install-it)
- [3. Five minute start](#3-five-minute-start)
- [4. Integration recipes](#4-integration-recipes)
- [5. Cookies](#5-cookies)
- [6. ffmpeg](#6-ffmpeg)
- [7. Handling results and errors](#7-handling-results-and-errors)
- [8. Performance and resource use](#8-performance-and-resource-use)
- [9. Adding a platform](#9-adding-a-platform)
- [10. Troubleshooting](#10-troubleshooting)
- [11. Verifying a build](#11-verifying-a-build)

---

## 1. What is in the box

```
cobalt-engine/
├── index.js                     public API
├── bin/cobalt-engine.mjs        command line tool
├── src/
│   ├── engine.js                resolve / resolveMany, platform dispatch
│   ├── download.js              streaming downloads, ffmpeg muxing
│   ├── settings.js              runtime defaults, configure()
│   ├── links.js                 URL normalisation and platform matching
│   ├── registry.js              URL patterns and sanity limits per platform
│   ├── naming.js                filename templates
│   ├── cookie-store.js          cookie pool
│   ├── cookie.js                cookie value object
│   ├── web.js                   generic extractor for ordinary web pages
│   ├── ytubedl.js               YouTube provider adapter
│   ├── net.js                   the one place fetch is imported
│   ├── helpers.js
│   ├── mime-types.js
│   ├── language-codes.js
│   ├── compat.js                createStream shim, see note below
│   └── platforms/
│       ├── tiktok.js  instagram.js  twitter.js  youtube.js  facebook.js
│       ├── threads.js tumblr.js     pinterest.js snapchat.js bluesky.js
│       └── vendor/              YouTube provider + threads extractor (upstream licenses included)
├── test/
│   ├── links.json               acceptance links
│   ├── links-extra.json         extra platform coverage
│   ├── smoke.mjs                offline unit checks
│   └── validate.mjs             live resolve + download + verify
├── examples/
├── README.md
└── USER_GUIDE.md
```

There is no server, no state, and no background worker. Every export is a plain async function; the only process-wide state is the ffmpeg probe, the YouTube probe cache, and the cookie pool.

**A note on `compat.js`.** Upstream cobalt hands media URLs to its own tunnel server: services call `createStream()` and get back `http://your-server/tunnel?id=…`. A library has no server, so `createStream()` here returns the origin URL unchanged. The practical consequence: platform handlers may be copied from upstream verbatim, and `alwaysProxy` becomes a no-op — record it, but proxy on your side if you need to hide your IP.

---

## 2. Install it

### From this folder

```bash
cd cobalt-engine
npm install
```

### Into an existing project

```bash
# from the parent of cobalt-engine
npm install ./cobalt-engine
```

or pin it in `package.json`:

```json
{ "dependencies": { "cobalt-engine": "file:./vendor/cobalt-engine" } }
```

### Vendored source (no package manager)

Copy `index.js` and `src/` into your project, keep the four dependencies in your own `package.json`, and import by relative path:

```js
import { resolve } from "./vendor/cobalt-engine/index.js";
```

Requirements: Node.js **18.17+**. No build step, no transpiler, no bundler needed.

---

## 3. Five minute start

```js
import { resolve, download } from "cobalt-engine";

const media = await resolve("https://www.tiktok.com/@user/video/7691436084026182919");

if (media.status !== "ok") {
    console.error(media.error.code, media.error.context);
} else {
    console.log(media.type, media.filename);
    const saved = await download(media, { dir: "./downloads" });
    console.log(saved.files);
}
```

From the shell:

```bash
node bin/cobalt-engine.mjs https://youtu.be/qqb3zbTFON0
node bin/cobalt-engine.mjs -d -o ./media https://youtu.be/qqb3zbTFON0
```

---

## 4. Integration recipes

### 4.1 Link preview (no download)

`resolve()` is cheap and returns metadata only. Use it to build a preview card:

```js
const r = await resolve(url);
if (r.status === "ok") {
    return {
        title: r.metadata?.title,
        author: r.metadata?.artist,
        thumbnail: r.picker?.[0]?.thumb ?? r.metadata?.thumbnail,
        duration: r.metadata?.duration,
        kind: r.type,
    };
}
```

### 4.2 Express / Node HTTP route

```js
import express from "express";
import { resolve } from "cobalt-engine";

const app = express();

app.get("/api/resolve", async (req, res) => {
    const result = await resolve(String(req.query.url ?? ""));
    res.status(result.status === "ok" ? 200 : 422).json(result);
});
```

If you stream the bytes yourself, forward the headers the engine returns and you avoid hotlink rejections:

```js
app.get("/api/stream", async (req, res) => {
    const media = await resolve(String(req.query.url ?? ""));
    if (media.status !== "ok") return res.status(422).json(media);

    const upstream = await fetch(media.urls[0], { headers: media.headers });
    res.setHeader("content-type", media.mime ?? "application/octet-stream");
    res.setHeader("content-disposition", `attachment; filename="${media.filename}"`);

    Readable.fromWeb(upstream.body).pipe(res);
});
```

Never expose this endpoint unauthenticated. It is an outbound-fetch primitive, so anyone who can call it can make your server pull arbitrary media.

### 4.3 Next.js App Router

`app/api/media/route.ts`:

```ts
import { resolve } from "cobalt-engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
    const { url } = await request.json();
    const result = await resolve(url);
    return Response.json(result, { status: result.status === "ok" ? 200 : 422 });
}
```

Keep it in the Node runtime — the engine uses `node:fs` and `node:child_process`.

### 4.4 SvelteKit

`src/routes/api/media/+server.js`:

```js
import { json } from "@sveltejs/kit";
import { resolve } from "cobalt-engine";

export async function GET({ url }) {
    const result = await resolve(url.searchParams.get("url") ?? "");
    return json(result, { status: result.status === "ok" ? 200 : 422 });
}
```

### 4.5 Batch job

```js
import { resolveMany, download } from "cobalt-engine";

const results = await resolveMany(links, { concurrency: 4, quality: "720" });

for (const result of results) {
    if (result.status === "ok") await download(result, { dir: "./library" });
}
```

`resolveMany` never rejects because of one bad link. If you want per-link isolation with different options, loop over `resolve()` yourself.

### 4.6 Cancellation

Pass an `AbortSignal` to stop a resolve or a download when the user navigates away:

```js
const controller = new AbortController();
request.on("close", () => controller.abort());
const result = await resolve(url, { signal: controller.signal });
```

A cancelled request resolves to `{ status: "error", error: { code: "error.request.cancelled" } }`.

### 4.7 Process-wide defaults

```js
import { configure } from "cobalt-engine";

configure({
    durationLimit: 60 * 30,   // refuse anything longer than 30 minutes
    videoQuality: "720",      // default quality for every call
    allowH265: false,
    youtubeEngine: "native",  // "off" disables YouTube entirely
});
```

---

## 5. Cookies

Instagram stories, some Instagram posts, and rate-limited Twitter sessions need a signed-in cookie. A cookie pool rotates between accounts so one session is not exhausted.

Create `cookies.json`:

```json
{
    "instagram": [
        "sessionid=111111%3AAAbbbb; csrftoken=abcd; ds_user_id=111111",
        "sessionid=222222%3ACCCddd; csrftoken=efgh; ds_user_id=222222"
    ],
    "twitter": [
        "auth_token=...; ct0=..."
    ],
    "youtube": [
        "SID=...; HSID=...; SSID=...; APISID=...; SAPISID=..."
    ]
}
```

Load it:

```js
import { loadCookies } from "cobalt-engine";

await loadCookies("./cookies.json");
```

or set the default path and let `resolve()` work unchanged:

```js
configure({ cookiePath: "./cookies.json" });
await loadCookies();
```

Notes:

- Only these keys are accepted: `instagram`, `instagram_bearer`, `reddit`, `twitter`, `youtube`, `vimeo_bearer`. Unknown keys are reported and ignored.
- Each value is an array of cookie header strings. One is picked at random per request.
- Rotated values are written back every 60 seconds. Call `stopCookieFlush()` before a short-lived process exits so the last rotation is not lost.
- Treat `cookies.json` as a credential: keep it out of version control and out of the ZIP you distribute.

---

## 6. ffmpeg

Only two situations need it:

1. **YouTube** returns video and audio as separate streams. `download()` fetches both and merges them.
2. **HLS** streams (`type: "hls"`, Bluesky video, some live content) must be remuxed.

Detection happens once per process, on first use:

```js
import { hasFFmpeg } from "cobalt-engine";
if (!hasFFmpeg()) console.warn("no ffmpeg: YouTube videos will save as two files");
```

If ffmpeg is missing, `download()` still succeeds — it writes `name.mp4` and `name.m4a` separately and returns `{ muxed: false, note: "…" }` rather than throwing away the audio.

Install it on the host (`apt install ffmpeg`, `brew install ffmpeg`, `winget install ffmpeg`, or the `ffmpeg-static` npm package placed on `PATH`).

---

## 7. Handling results and errors

The engine never throws for content problems. Check `status`.

```js
const result = await resolve(url);

if (result.status === "ok") {
    // result.type:  video | audio | photo | hls | picker | gif | mute
    // result.urls:  one URL, or video+audio when result.requiresMux is true
} else {
    switch (result.error.code) {
        case "error.link.invalid":      // not a URL we understand at all
        case "error.link.unsupported":  // right platform, wrong kind of link
        case "error.service.unsupported":
        case "error.fetch.empty":
        case "error.fetch.fail":
        case "error.fetch.rate":        // platform is throttling this IP
        case "error.content.too_long":
        case "error.content.post.unavailable":
        case "error.content.post.age":
        case "error.content.video.unavailable":
        case "error.content.video.live":
        case "error.download.ffmpeg_required":
        case "error.request.cancelled":
        case "error.fetch.critical":    // a handler crashed; context.message has details
    }
}
```

| Code | Meaning | What to do |
|---|---|---|
| `error.link.invalid` | The input is not a URL, or the host is unknown and the generic extractor is disabled | Validate on the client |
| `error.service.unsupported` | Recognised host with no handler | — |
| `error.link.unsupported` | Recognised platform, but this link form is not media (a profile, a channel, an ideas page) | Ask for a post link |
| `error.fetch.fail` | Platform answered, but with something unusable | Retry once, then report |
| `error.fetch.empty` | Post exists but has no media, or was removed | Show "no media here" |
| `error.fetch.rate` | Rate limited or bot-checked | Back off, add cookies, or change IP |
| `error.fetch.critical` | A handler crashed. `context.message` has the reason | Log it; this is a bug |
| `error.content.too_long` | Exceeds `durationLimit` (default 3 h) | Raise the limit or refuse |
| `error.content.post.age` / `.video.age` | Age restricted | Needs cookies from an aged account |
| `error.content.video.live` | Live stream | Not supported |
| `error.download.ffmpeg_required` | HLS download without ffmpeg | Install ffmpeg |

`context.service` is always the platform name, so you can localise the message.

---

## 8. Performance and resource use

**Resolution cost.** One or two HTTP requests per link. Measured on the acceptance set: 0.1–4.6 s depending on platform, ~1 s for YouTube.

**Memory.** Downloads stream to disk with backpressure. The only in-memory buffers are the first 16 bytes used to sniff image formats, and the YouTube probe cache (40 entries, 10 minute TTL).

**Concurrency.** `resolveMany` defaults to 4 parallel links. Raising it mostly helps when mixing platforms; per-platform rate limits bite first. A safe range is 4–8.

**Caching.** The engine does not cache results across calls, because platform CDN URLs are IP-bound and short-lived. If you need caching, cache the *metadata* you care about and re-resolve when the user clicks download.

**Batch runs.** Reuse one process. Each new process pays for the ffmpeg probe and any cookie load; the connection pool also has to warm up again.

---

## 9. Adding a platform

Three edits, no changes to the engine core.

1. **`src/registry.js`** — add a `services` entry with `patterns`, optional `tld`, `subdomains`, `altDomains`, and a `testers` entry with length limits:

```js
example: {
    patterns: ["watch/:id"],
    subdomains: ["m"],
},
// ...
"example": pattern => pattern.id?.length <= 24,
```

2. **`src/platforms/example.js`** — default-export an async function that receives the captured pattern values and returns one of:

```js
export default async function ({ id, quality }) {
    return {
        urls: "https://cdn.example.com/video.mp4",  // or [video, audio]
        filename: `example_${id}.mp4`,
        isPhoto: false,
        isHLS: false,
        fileMetadata: { title: "…", artist: "…" },
        headers: { referer: "https://example.com/" },
    };
}
```

Also allowed: `{ picker: [{ type, url, thumb }] }` for galleries, `{ filenameAttributes }` to use the shared naming templates, or `{ error: "fetch.empty", critical: true }` to signal a hard failure.

3. **`src/engine.js`** — import the handler and add a `case "example"` to `dispatch()` passing the arguments it needs.

Add a link to `test/links-extra.json` and run `node test/validate.mjs --download`.

---

## 10. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| TikTok returns `fetch.fail` | The page template depends on the user agent fingerprint, or the post is gone | The handler already tries desktop, mobile, and bot fingerprints in order. If all three fail, the post is unavailable |
| TikTok resolves but the download is 403 | The session cookie was sent to the media host | The handler deliberately sends no cookies to TikTok media URLs. Do not add them back |
| Instagram always needs login | Instagram gates most content behind a session | Add `instagram` cookies |
| YouTube says `no_matching_format` | Every progressive format failed the codec filter | Try `quality: "max"` or a different `youtubeVideoCodec` |
| YouTube resolves but there is no audio | ffmpeg missing, so tracks were saved separately | Install ffmpeg, or handle the two-file result |
| Pinterest `/ideas/…` returns one image | It is a browse page, not a pin | Use a `/pin/<id>` link |
| `error.fetch.rate` on many links | IP-level throttling | Lower concurrency, add cookies, or run from a residential IP |
| Downloads work locally but not in Docker | Alpine image without ffmpeg, or no outbound IPv6 | Install ffmpeg and check egress |
| Filename contains full-width punctuation | Windows-reserved characters are replaced on purpose | Expected; it keeps files portable |

---

## 11. Verifying a build

```bash
npm test                            # 30 offline checks, sub-second
npm run validate                    # resolve 21 live links
node test/validate.mjs --download   # + download and verify every byte
```

The `--download` run is the one that proves the engine works: for every link it fetches the media, checks the container signature (`ftyp`, RIFF/WebP, JPEG SOI, PNG, …), and when `ffprobe` is present confirms the file is decodable. A link that resolves to an HTML error page fails this run.

Expected result on a healthy network:

```
21/21 ok
```

Platforms are independently rate-limited, so a failure on one line usually means that platform is throttling the IP, not that the engine is broken. Re-run that link with `--only <name>` to confirm.
