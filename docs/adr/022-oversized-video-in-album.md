# ADR-022: A video past 50 MB inside an album

**Status:** Accepted · 2026-11-11 · amends ADR-012

## Context

ADR-012 covers one video per post: over 50 MB it becomes a thumbnail plus a link. Albums had no such
rule. Every downloaded file went into `sendMediaGroup`, so a single 60 MB clip made Telegram reject the
whole group, and `prepareMedia` threw `E_TOO_LARGE` on the 100 MB total, which turned the album into a
bare link. One oversized clip therefore cost the user every other photo and video in the post.

A carousel with three clips and two photos is ordinary on X, Instagram and Facebook: the platform caps
duration per clip, not bytes, and the third clip is the one that happens to be 8-bit-remuxed at 1080p.

`resolve()` reports no file size, so the ceiling cannot be checked before the bytes land. ffmpeg, which
makes the stand-in frame, needs those bytes anyway.

## Options

| Option | User result | Cost | Verdict |
|---|---|---|---|
| Whole album degrades to a link | nothing to tap but the source | 0 | Rejected: one clip costs the post |
| Upload everything, let Telegram refuse | nothing delivered, one failed attempt | 0 | Rejected: fails the post |
| **Drop the oversized clip, keep its frame, link it in the caption** | album of the rest, preview + direct link | one ffmpeg run | **Chosen** |
| Probe `Content-Length` before downloading | same result, less bandwidth | a second gate that CDNs can lie about | Rejected for now (see Consequences) |

## Decision

- A file over `MAX_UPLOAD_BYTES` never enters `sendMediaGroup`, on either scheduled posts or Download
  Mode. The rule lives in the renderer (`render/video.ts`), next to R7/R8, so no caller can forget it.
- Each oversized video contributes one ffmpeg frame (`Thumbnailer`) as a `photo` item at the end of the
  group, and one caption line `🎬 Video n` — a short label whose anchor carries the direct media URL, so a
  hundred-character CDN address never fills the caption.
- A single video takes the same line through R7/R8: the caption ends on `🎬 Video n`, so the post
  page is never the last thing a reader sees. The post link still rides along as its own message when
  a frame is shown.
- The `MAX_DOWNLOAD_MB` total counts only files that will be withheld: an oversized video is the only
  file guaranteed to stay home, so every other byte still spends the budget that guards the upload.
- `MediaFile.url` carries where the file came from, which is what the caption line links.
- The header keeps §8.2's `🌐 <a href="url">name</a> | Label` form: the URL is the link target, so a
  reader reaches the post without the caption printing it twice and spending the 1024 budget on it.
- Multi-item posts now leave the frame files as separate names (`thumb-<n>.jpg`); a fixed name would let
  the second frame overwrite the first.

Platform coverage falls out of the engine's own URLs: X yields the `video.twimg.com/amplify_video/…`
URL, Instagram and Facebook their CDN file, so the caption links something a browser can play. YouTube
is the exception in both directions: `resolve()` returns a `googlevideo.com` stream URL that expires
within hours, and a YouTube post is always a single video, so it takes the R7/R8 path where the link is
the watch page itself. No per-platform branch lives in the renderer.

## Consequences

- A post is never dropped because one of its clips is too large; the album shrinks instead.
- A download that fails is unsendable, not fatal: the engine reports a stalled 60 MB transfer as
  "no media", which used to fail the whole post with "Couldn't extract media". The video now links from
  the caption and every other item still ships.
- Adding a frame can push a 10-item album to 11, so `sendAlbum` now sends a trailing group of one as its
  own media message. `sendMediaGroup` refuses fewer than two items, and the same fix closes the
  pre-existing 11/21-item album failure.
- The oversized clip is downloaded before it is withheld, so bandwidth is spent on a file that will not
  be sent. A `Content-Length` probe would avoid that, but it becomes a second, unreliable size gate;
  revisit if a source regularly ships 500 MB carousels.
- The frame is only as good as ffmpeg: without it installed, the album keeps every uploadable item, the
  caption keeps the link, and only the preview image is missing.
- A caption long enough to trigger the Instant View "Read more" cut keeps its `🎬` lines: they are the
  only route to the clip, so the cut truncates the body around them. ADR-012's single-video path is
  unaffected.
- Photos are subject to the same ceiling; a photo over 50 MB is left out without a `🎬` line, because a
  photo has no player to link to.

## Evidence

`[TG-FILES]`, `[TG-MG]`, ADR-012, `src/render/video.ts`, `src/pipeline/prepare-media.ts`.
