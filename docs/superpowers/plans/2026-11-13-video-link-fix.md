# Video link label, 50 MB gate and the X/YouTube quality ladder

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Every non-RSS post shows its videos either as an inline attachment that fits the 50 MB Bot API ceiling, or as one `🎬 Video N` link to the direct file — never a raw URL, never a wasted download.

**Architecture:** Stage 5 decides with a remote byte probe (`MediaEngine.size`) instead of downloading first; for X and YouTube it steps 1080 → 720 → 480 and keeps the first rung that fits. Stage 6 already owns the `🎬 Video N` line (`withVideoLinks`); the change there is that every platform, a YouTube community attachment included, reaches it instead of printing a URL in the body.

**Tech Stack:** Node 24 (type stripping), TypeScript, cobalt-engine (vendored), node:test, grammY, SQLite.

## Global Constraints

- Upload ceiling is `MAX_UPLOAD_BYTES = 50 * 1024 * 1024` from `src/render/video.ts` — the Bot API multipart cap; never restate the number.
- The visible label is exactly `🎬 Video N`, the whole label is the link (`href` = direct media URL). No raw URL may be visible text.
- No new dependency, no new config key.
- Offline tests only: no network in `test/**`.
- Commit identity comes from `git config`; never override it.
- Worktree: `.worktrees/show-more`, branch `feat/video-link-fix`.

---

### Task 1: A YouTube watch link keeps its video id

`detectSource('https://www.youtube.com/watch?v=<id>')` currently drops the query, so the canonical URL is
`https://youtube.com/watch` and resolvers fetch the YouTube home page instead of the video.

**Files:** Modify `src/platform/registry.ts:131-151`, Test `test/unit/registry.test.ts`

**Interfaces:** Produces `SourceRef.canonicalUrl = 'https://youtube.com/watch?v=<id>'` and
`externalId = '<id>'` for a watch link; `/shorts/<id>` and `/live/<id>` keep today's shape.

- [ ] Add a registry test: watch link → canonical `https://youtube.com/watch?v=dQw4w9WgXcQ`, `externalId`
      `dQw4w9WgXcQ`, `strategy: 'single_post'`; a `watch` link without `v` still throws `E.LINK_INVALID`.
- [ ] Run it, watch it fail on the canonical URL.
- [ ] Split the `watch` case out of the `shorts | live` case in `registry.ts` and pass the canonical URL to
      `single()`.
- [ ] Re-run; the whole registry file passes.

### Task 2: The media engine can answer quality, remote size, and the second track

**Files:** Modify `src/media/media-engine.ts`, Test `test/unit/media-engine.test.ts` (new)

**Interfaces:**
- `MediaEngine.resolve(url, signal, quality?: string): Promise<ResolvedMedia>`
- `MediaEngine.size?(item, signal): Promise<number | null>` — remote byte length, `null` when the host will not say
- `MediaItem.audio?: string` — the second URL of a muxed result (YouTube video + audio)
- `downloadInput(item, filename).urls` = `[item.url, item.audio?]`, so cobalt muxes the tracks

- [ ] Add a test that `downloadInput` carries `audio` as the second URL and leaves a picker descriptor alone;
      add a test that `bytesFrom(headers)` reads `content-range: bytes 0-0/1234` → 1234 and a bare
      `content-length: 99` → 99 and nothing → `null`.
- [ ] Run: fail (no such exports).
- [ ] Add `audio` to `MediaItem`, `quality` to `resolve`, optional `size` to the interface; `cobaltEngine.resolve`
      passes `{ quality }` and keeps `urls[1]` as `audio`; `cobaltEngine.size` issues a ranged GET
      (`range: bytes=0-0`, plus `item.headers`) and reads the total from a pure `bytesFrom(headers)` helper,
      cancelling the body either way.
- [ ] Run: pass.

### Task 3: Stage 5 gates on size and climbs the X/YouTube ladder

**Files:** Modify `src/pipeline/prepare-media.ts`, `src/pipeline/run.ts:222-295`,
`src/bot/callbacks.ts:1023-1055`, Test `test/unit/prepare-media.test.ts` (new)

**Interfaces:**
- `PrepareOptions.ladderUrl?: string` — the post link to re-resolve at a lower rung; set only for `x` and `youtube`
- `prepareMedia` returns `{ path: '', kind: 'video', size: 0, url }` for a video it will not download, which
  `withVideoLinks` already turns into the labelled line
- The fallback URL is the **first** rung's URL (1080p or the native best), per spec

Behaviour:
1. `engine.size` > ceiling → do not download; return the link file.
2. No `engine.size` answer, or a downloaded file still over the ceiling → same link file.
3. With `ladderUrl`: rungs `['1080', '720', '480']`; rung 1 is the item the caller already resolved, rungs 2–3
   are a fresh `resolve(ladderUrl, signal, quality)`. A URL already tried is skipped without a second probe.
   The first rung that fits is downloaded and kept.

- [ ] Tests (fake engine, counted calls, no network): ≤ ceiling → downloaded and inline; > ceiling → zero
      downloads and the link file; ladder where 1080 is too big and 720 fits → one download at the 720 URL;
      ladder where every rung is too big → zero downloads, link file carries the 1080 URL; a rung that repeats
      the previous URL is not probed twice; a download failure still returns the link file.
- [ ] Run: fail.
- [ ] Implement `prepareVideo` inside `prepare-media.ts` (one new function, used by the existing loop) and pass
      `ladderUrl` from `planForDelivery` and `runDownload` when the platform is `x` or `youtube`.
- [ ] Run: pass.

### Task 4: Every platform reaches the label, YouTube community included

A community post's attached video today lands in the post text as
`🎬 <title>\nhttps://youtu.be/<id>`; the rich renderer then prints the raw URL as visible text.

**Files:** Modify `src/platform/feed/youtube-post.ts`, `src/pipeline/run.ts`, `src/bot/callbacks.ts`,
`test/unit/youtube-post.test.ts`, Test `test/unit/video-label.test.ts` (new)

**Interfaces:**
- `YouTubePostDoc.videos: string[]` — attached video page links, in post order
- `PagePost.links: MediaFile[]` — media the page can only link (`path: ''`)
- `attachmentParts` returns the video **title only** (no emoji, no URL); the labelled line comes from the
  shared renderer, so `🎬` never appears twice for the same clip

- [ ] Update the youtube-post test: `doc.text` no longer ends in the youtu.be URL, `doc.videos` holds it.
- [ ] Add `video-label.test.ts`: for each of `x, instagram, tiktok, youtube, tumblr, facebook, bluesky,
      snapchat, pinterest` a plan with `[{ path: '', kind: 'video', size: 0, url: DIRECT }]` renders exactly
      `<p>🎬 <a href="DIRECT">Video 1</a></p>`, and the raw URL never appears as visible text; two link videos
      number 1 and 2.
- [ ] Run: fail.
- [ ] Implement `videos`, the two consumers, and the shared label test.
- [ ] Run: pass.

### Task 5: Download mode renders the same layout as auto-check

**Files:** Test `test/unit/download-caption.test.ts`

- [ ] Add a test: the same post, files, platform, tz and source name produce byte-identical html through
      `renderPost(post, 'video'|'album', files, …)` and `renderDownload(files, …)`. Cover a video post and a
      mixed album with one oversized clip.
- [ ] Run; if it differs, fix `renderDownload` (not the scheduled path) and re-run.

### Task 6: Record the decision, verify, run the bot, commit

**Files:** Create `docs/adr/026-video-size-gate-and-quality-ladder.md`; amend the one-line consequences in
ADR-023/ADR-025 that claim an oversized video is downloaded first.

- [ ] Write the ADR: options (download-then-withhold, HEAD probe, ranged probe), the chosen ladder, the
      fallback URL rule, the community-post limit (`shortcut:` community clips are linked, never inlined).
- [ ] `npm run typecheck`, `npm test`, `npm run build` — all green.
- [ ] Tier 2 live run against the seven test links with the throwaway bot in `tmp/live.env`, confirming:
      Tumblr photo/video post, X long video (link only), two Instagram albums, YouTube video, TikTok clip,
      and that no message shows a bare URL.
- [ ] Commit on `feat/video-link-fix` with the owner's git identity; prove it with
      `git log -1 --pretty="%an <%ae> | %cn <%ce>"`.
