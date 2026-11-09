# cobalt-engine

Standalone media extraction engine, extracted from the [cobalt](https://github.com/imputnet/cobalt) API and stripped down to the part that actually downloads things.

One link in, ready-to-use media URLs out. No HTTP server, no database, no Redis, no native binaries, no yt-dlp. Four small pure-JavaScript dependencies.

```js
import { resolve, download } from "cobalt-engine";

const media = await resolve("https://youtu.be/qqb3zbTFON0");
// { status: "ok", type: "video", filename: "...", urls: [...], metadata: {...} }

await download(media, { dir: "./downloads" });
```

## Why it is fast and cheap

| | |
|---|---|
| **No subprocess for metadata** | YouTube is parsed through a native InnerTube provider. A typical resolve is ~0.9–1.5 s and allocates no process, so a batch of links costs almost nothing. |
| **One HTTP hop per platform** | Each handler talks to the platform's own JSON API. No browser, no headless Chrome, no scraping loop. |
| **Resolution is metadata-only** | `resolve()` never downloads bytes. Use it for link previews, thumbnails, or to check a link before saving it. |
| **Streamed downloads** | Bytes go socket → disk. A 13 MB video never sits in memory. |
| **ffmpeg only when unavoidable** | Detected once per process, spawned only for HLS or for merging separate video+audio tracks. |
| **Bounded concurrency** | `resolveMany()` runs four links at a time by default, reusing the same keep-alive connection pool. |

## Install

```bash
npm install cobalt-engine
```

Requires Node.js 18.17 or newer. ffmpeg is optional and only needed for YouTube (separate video/audio tracks) and HLS streams.

## Supported platforms

| Platform | Link forms |
|---|---|
| **TikTok** | `tiktok.com/@user/video/<id>`, `/photo/<id>`, `vt.tiktok.com/…`, `vm.tiktok.com/…` |
| **Instagram** | `instagram.com/p/<id>`, `/reel/<id>`, `/tv/<id>`, `/stories/<user>/<id>`, `ddinstagram.com` |
| **X / Twitter** | `x.com/<user>/status/<id>`, `twitter.com/…`, `vxtwitter.com`, `fxtwitter`, `/video/<n>` and `/photo/<n>` indexes |
| **YouTube** | `youtu.be/<id>`, `/watch?v=`, `/shorts/`, `/live/`, `music.youtube.com` |
| **Facebook** | `facebook.com/<user>/videos/<id>`, `/reel/<id>`, `/share/…`, `/photo?fbid=…`, `fb.watch` |
| **Threads** | `threads.com/@user/post/<code>`, `threads.com`, `/post/<code>`, `/t/<code>` |
| **Tumblr** | `tumblr.com/<blog>/<postId>`, `/post/<id>`, `/blog/view/<user>/<id>` |
| **Pinterest** | `pinterest.com/pin/<id>`, `pin/<slug>--<id>`, `pin.it` short links |
| **Snapchat** | `snapchat.com/@user/spotlight/<id>`, `/spotlight/<id>`, `/t/<code>`, `/add/<user>/<id>` |
| **Bluesky** | `bsky.app/profile/<handle>/post/<rkey>` |
| **Any other website** | Falls back to a generic extractor: OpenGraph video/audio/image tags, JSON-LD `VideoObject`, and `<video>`/`<source>`/`<audio>` elements. Blog posts, news articles, self-hosted players, and direct media URLs all work. |

Pinterest `/ideas/…` and `/search/…` links are browse pages, not pins. They have no single media item, so the generic extractor returns the page's preview image instead.

## API

### `resolve(input, options?)`

Returns a descriptor. Never throws on a bad link — check `status`.

```js
const r = await resolve("https://www.instagram.com/reel/DbndR7CNuhv/");
```

| Option | Default | |
|---|---|---|
| `quality` | `"1080"` | `144`–`4320`, or `"max"` |
| `mode` | `"video"` | `"video"`, `"audio"`, `"mute"` |
| `filenameStyle` | `"pretty"` | `"classic"`, `"basic"`, `"pretty"`, `"nerdy"` |
| `metadata` | `true` | include title/artist/album in the result |
| `generic` | `true` | fall back to the web-page extractor for unknown hosts |
| `signal` | — | `AbortSignal` to cancel |

Result:

```js
{
  status: "ok",
  service: "instagram",
  type: "video",          // video | audio | photo | hls | picker | gif | mute
  filename: "instagram_DbndR7CNuhv.mp4",
  mime: "video/mp4",
  urls: ["https://…"],
  requiresMux: true,      // only when urls holds separate video + audio tracks
  headers: { … },         // send these when fetching the URLs yourself
  metadata: { title: "…", artist: "…" },
  expiresIn: 90
}
```

A carousel or gallery returns `type: "picker"` with a `picker` array of `{ type, url, thumb }`.

A failure returns the same shape with `status: "error"` and `error.code`, for example `error.link.unsupported`, `error.fetch.rate`, `error.content.too_long`.

### `download(input, options?)`

Accepts a URL or an already resolved result.

```js
await download("https://youtu.be/qqb3zbTFON0", {
    dir: "./downloads",
    onProgress: ({ received, total }) => {},
});
```

| Option | Default | |
|---|---|---|
| `dir` | `process.cwd()` | target directory, created if missing |
| `filename` | resolved name | override; never collides with an existing file |
| `index` | all | which item to take from a picker |
| `mux` | `true` | merge separate video+audio with ffmpeg when available |
| `signal` | — | `AbortSignal` |

Returns `{ status, files: [...], muxed }`.

### `resolveMany(inputs, options?)`

Resolves a list with bounded concurrency; `concurrency` defaults to 4. One failing link never fails the batch — each entry carries its own result.

### Others

`configure(env)` for process-wide defaults, `loadCookies(path)` for a cookie pool, `setCookies({ service: ["cookie"] })` to seed that pool from memory instead of a file, `hasFFmpeg()`, `isSupported(url)`, `normalizeURL(url)`, `extract(url)`.

## CLI

```bash
cobalt-engine https://youtu.be/qqb3zbTFON0          # print resolved JSON
cobalt-engine -d -o ./media https://…               # download
cobalt-engine --audio -d https://…                  # audio only
cobalt-engine -d https://a https://b https://c      # batch
```

Output is JSON, so it pipes into `jq` or any script.

## Validation

```bash
npm test            # 30 offline checks: URL normalisation, matching, filenames
npm run validate    # resolve 21 real links
node test/validate.mjs --download   # resolve, download, then verify every file
```

The download run sniffs each file's container signature and, when ffprobe is present, confirms the stream is decodable. A resolved link that returns an HTML error page fails the run instead of passing silently.

## Limitations

- Story links (`instagram.com/stories/…`) need cookies; Instagram only serves them to a signed-in session.
- Age-restricted, private, region-locked, and DRM-protected media cannot be extracted by design.
- `resolve()` returns platform CDN URLs. They are usually bound to the requesting IP and expire in minutes; resolve again rather than caching a result for long.
- Rate limits are per platform and per IP. Running from a datacenter address gets you throttled first — see `USER_GUIDE.md` for the cookie pool and IP notes.

## License

AGPL-3.0, inherited from cobalt. The YouTube provider under `src/platforms/vendor/` keeps its own upstream license, reproduced alongside it.

If you deploy this as part of a network service, AGPL-3.0 obliges you to publish the source of that service.
