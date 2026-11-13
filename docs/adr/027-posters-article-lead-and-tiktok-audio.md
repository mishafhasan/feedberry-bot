# ADR-027: A linked clip keeps its face, the article keeps its picture, TikTok keeps its sound

**Status:** Accepted · 2026-11-13 · amends ADR-023 (rich layout) and ADR-016 (article extraction)

## Context

Three reports came from the same delivery batch:

- A post whose video is past the 50 MB ceiling ships as `🎬 Video N` with no picture at all. ADR-012 gave
  the *RSS* layout a stand-in frame for exactly this case; the rich message never had one, so a social
  post with a long clip opened on a blank space above the quote.
- Two BBC articles (`/news/articles/cq39glwprknjo`, `/cwvg238zrnm5o`) reached Instant View with no image.
  Measured on the live pages: the HTML carries 32–33 `<img>` tags and declares `og:image`, but
  Readability returns content with **zero** images — the lead picture sits outside the text container
  it picks, and BBC loads the rest client-side.
- One TikTok (`@funnyxcv3/video/7676388145302211870`) attached with no audio. The play address is the
  picture only: `ffprobe` on the downloaded file showed a single `hevc,video` stream, while the page
  exposes the soundtrack separately as `music.playUrl` (`mp3,audio`).

## Options

| Option | User result | Cost | Verdict |
|---|---|---|---|
| Thumbnail: per-platform `cover` in all nine handlers | exact poster per clip | nine handler edits, several with no poster in the payload (Facebook, Pinterest) | Rejected: uneven and large |
| Thumbnail: **engine poster, then the page's `og:image`** | a picture for every platform | one page fetch only on the oversized path | **Chosen** |
| Thumbnail: ffmpeg frame | like the RSS layout | the bytes we just refused to download | Rejected |
| Article: scrape the body for images | every picture | a second DOM walk and BBC loads them client-side anyway | Rejected: nothing to scrape |
| Article: **the page's declared `og:image` when Readability kept none** | the article's lead picture | zero | **Chosen** |
| TikTok: prefer `downloadAddr` | one file | unverified: the CDN answers 403 to a probe, so we would ship a guess | Rejected |
| TikTok: **mux `playAddr` + `music.playUrl`** | sound | ffmpeg, already in the image | **Chosen** (verified: `hevc,video` + `mp3,audio`) |

## Decision

- **A linked clip keeps its face.** `MediaItem.poster` carries what the extractor states (`cover` for a
  single video, the picker item's `thumb`); `MediaFile.poster` carries it to the link file. When a post
  ends with a link-only video, stage 5 downloads that poster as an ordinary photo — or, when the
  extractor named none, asks the page for `og:image` **once** through `PrepareOptions.poster`. The photo
  joins the slideshow, so the thumbnail and the label are one message. The page is only read on the
  oversized path; an inline clip never pays for it.
- **Both doors call it.** `planForDelivery` and Download Mode both go through `prepareMedia`; download
  mode passes the `og:image` from the page it already read, scheduled delivery fetches it lazily. The
  bytes of the two plans stay identical (`test/unit/video-label.test.ts`).
- **RSS keeps ADR-012/022**: `keepOversizedVideo` skips the poster, because a frame cut from the clip is
  already in the album.
- **An article with no pictures gets its own lead image.** After sanitizing, a body with no `<img>` is
  prefixed with `<figure><img src="…"/></figure>` built from `og:image` (else `og:image:secure_url`,
  else `twitter:image`), resolved against the final URL and filtered by the same `usableUrl` rules as
  every other picture. A body that already carries a picture is left untouched.
- **TikTok ships two tracks.** The single-video branch returns `[playAddr, music.playUrl]`, which cobalt
  muxes with ffmpeg — the same two-track path YouTube already used. The branch also states `cover`
  (`originCover`, else `cover`), which `normalize()` now passes through as `cover`.

## Consequences

- A social post with a long clip is a poster plus a labelled link, which is what ADR-012 promised for RSS.
- One poster per post: a carousel whose clips are all oversized shows the platform's own `og:image`, not
  one frame per clip. The requirement named "the video's thumbnail"; the page states one.
- An article whose page declares no `og:image` still renders text-only; nothing is invented.
- A TikTok that states no `music.playUrl` falls back to its single stream, exactly as before.
- The poster image is an extra Telegram upload: one photo per oversized post, well under the ceiling.

## Evidence

- `test/unit/prepare-media.test.ts` (extractor poster, page poster once, inline asks for none, dead URL),
  `test/unit/video-label.test.ts` (poster in the slideshow, both doors identical),
  `test/unit/article.test.ts` (`lead-image.html` fixture), `test/unit/page-text.test.ts` (`metaImageOf`).
- Live: BBC `cq39glwprknjo` published `https://telegra.ph/Rosenberg-…-11-13-5` — 0 images before the fix
  (raw page 32 `<img>`, Readability 0). TikTok mux probe: 42,503,063 B, `hevc,video` + `mp3,audio`.
