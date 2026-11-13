# ADR-026: A video is chosen by its size, and X/YouTube step down the quality ladder

**Status:** Accepted · 2026-11-13 · amends ADR-012, ADR-022 and ADR-023 for non-RSS posts

## Context

ADR-012 decided that a clip past the Bot API's 50 MB multipart ceiling is not uploaded: it ships as a
preview plus a link. ADR-022 gave an RSS album a stand-in frame cut from the same download, and ADR-023
let that rule stand for social posts too ("an oversized video is still downloaded before it is withheld").
The size was therefore known only **after** the bytes landed, because `resolve()` reports URLs and no
length.

Measured on a real post (2026-11-13, `x.com/0xCodila/status/2083602508807569560`): the tweet's best mp4
is **491 MB** (1280x720), its 360p rendition is **186 MB**, its 270p rendition is **77 MB**. The bot pulled
the 491 MB file, waited for it, then withheld it and printed a link. On a slow host the transfer simply
timed out and the post arrived as a bare link.

Two facts make the decision cheap:

- Media CDNs state the total before the body: a ranged `GET` (`range: bytes=0-0`) answers
  `content-range: bytes 0-0/491858616`. `HEAD` is not enough — TikTok answers it with a JSON stub while
  the same URL names 34,503,703 bytes for a ranged GET.
- X, YouTube and Threads publish several renditions of one clip and accept a height ceiling
  (`resolve(url, { quality: '720' })`). Instagram, TikTok, Tumblr, Facebook, Bluesky, Snapchat and
  Pinterest publish one.

## Options

| Option | User result | Cost | Verdict |
|---|---|---|---|
| Keep download-then-withhold | correct link, no attachment | up to 491 MB per post, timeouts turn into bare links | Rejected: the bandwidth is the bug |
| `HEAD` before download | same, no waste | TikTok and several CDNs answer `HEAD` with a stub or 403 | Rejected: not a contract |
| **Ranged GET (`bytes=0-0`) before download** | same, one small request | one extra request per video, `null` when the host will not say | **Chosen** |
| Transcode down to 50 MB | inline video | ffmpeg CPU per post, minutes on a Pi, quality loss (ADR-012) | Rejected for the MVP |
| Link every video, never attach | one clean layout | loses the inline player the product wants | Rejected |

## Decision

- **Stage 5 asks for the size first.** `MediaEngine.size()` issues the ranged GET with the item's own
  headers and reads the total (`content-range`, else `content-length`). A file over `MAX_UPLOAD_BYTES`
  is never downloaded; `prepareMedia` returns `{ path: '', kind: 'video', size: 0, url }`, which stage 6
  already renders as the labelled line. A host that answers nothing falls back to today's behaviour: the
  file is pulled, measured, and deleted when it is too big. A muxed result is the sum of its tracks.
- **X and YouTube walk a ladder**: `1080 → 720 → 480`. Rung one is the resolve the caller already paid
  for; each lower rung is a fresh `resolve(postUrl, { quality })`, matched **by item position** so a
  carousel keeps its order. A URL already tried is not probed again. The first rung that fits is
  downloaded; when every rung is too big, the link is **rung one's URL** — the direct file the post
  offers, two tracks or one. The header already carries the post page, so the label never repeats it.
- **The downloader stops at the ceiling on its own.** `download(..., { maxBytes })` rejects the
  advertised `content-length` before the body and counts the streamed bytes through a transform, so a
  host that names no size still cannot land more than 50 MB; the partial file is removed and a size
  rejection is never retried. Measured live: an X rung that answered no length to the probe (it does
  answer a ranged GET) cost seconds, not the 240 s a blind 491 MB transfer took before this cap.
- **Only X and YouTube climb.** `ladderFor(platform, url)` returns a ladder URL for those two and
  nothing else; every other platform resolves once and is gated by size.
- **RSS posts keep ADR-012/022 untouched**: `keepOversizedVideo` is set for `platform === 'rss'`, so an
  oversized blog clip is still downloaded once for its thumbnail or stand-in frame. The gate is a social
  -post rule; the frame is an RSS-layout rule.
- **One label, every platform.** `🎬 Video N` is the link (`href` = direct URL), built once by
  `withVideoLinks`. A YouTube community post's attached video is a page, not a file: `attachmentParts`
  stops writing `🎬 <title>\nhttps://youtu.be/…` into the body, `YouTubePostDoc.videos` and the feed
  payload's `{ type: 'video' }` keep the link, and the renderer prints the labelled line. Delivery
  (`planForDelivery`) and Download Mode (`youtubePage` → `PagePost.links`) both reach it.

## Consequences

- A post with a long clip costs one resolve and one ranged request per rung instead of a 491 MB transfer,
  and it still arrives with a playable label.
- A clip that fits is kept at the best quality that fits, not the smallest: 1080 → 720 → 480 is a
  fallback, never a preference.
- `shortcut:` a community post's attached clip is **linked, never inlined** — its page URL is not a media
  file cobalt can fetch, so it gets no size probe and no upload. Upgrade when inline community clips are
  asked for (one resolve of the `youtu.be` link plus the same ladder).
- A YouTube inline video now carries its audio track (`MediaItem.audio`), because the merged result's
  second URL used to be dropped and the upload was silent.
- The fallback link can expire: platform CDN URLs are signed and short-lived. A message forwarded days
  later may open a dead URL; the header still links the post itself.
- A host whose `content-length`/`content-range` lies still cannot upload past the ceiling: the
  downloader stops the stream at 50 MB, deletes the partial file, and the label takes over. A platform
  without a ladder pays at most 50 MB before it links; a ladder pays that per rung, never more.

## Evidence

- Sizes and renditions measured live (2026-11-13): X `1280x720` 491,858,616 B, `640x360` 186,619,301 B,
  `480x270` 77,110,958 B; Tumblr 2,802,178 B; Instagram 1,443,317 B; TikTok 34,503,703 B (ranged GET,
  `HEAD` answered JSON).
- YouTube `resolve(quality)` returns 1080p 6,746,756 B + audio, 720p 2,795,185 B, 480p 1,527,945 B; the
  muxed download landed as video+audio (`ffprobe`: `video,1080` + `audio`).
- `test/unit/prepare-media.test.ts` (gate, ladder, dedupe, lying host, muxed link, frame keep),
  `test/unit/media-engine.test.ts` (descriptor audio, ranged total), `test/unit/video-label.test.ts`
  (nine platforms, numbering, Download Mode), `test/unit/download-caption.test.ts` (identical layout),
  `test/unit/registry.test.ts` (watch link keeps its id), `test/unit/youtube-post.test.ts` (no raw URL).
