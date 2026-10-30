# ADR-012: Thumbnail fallback above 50 MB

**Status:** Accepted (design) · 2026-10-29

## Context

The rule "video under 3 minutes is sent as a video file" collides with a platform limit: bots can upload
files "up to 50 MB" via multipart `[TG-FILES]`, and URL-based sending is capped at 20 MB for non-photos
`[TG-FILES]`. A 1080p clip of 2:50 can easily exceed 50 MB. The only way to send more is a local Bot API
server in `--local` mode, which allows up to 2000 MB and local paths `[TG-LOCAL]`.

## Options

| Option | User result | Cost | Verdict |
|---|---|---|---|
| Thumbnail + caption + link | clean card, tap to watch at source | 0 | **Chosen** |
| Transcode to fit 50 MB | full video, quality loss | ffmpeg CPU per post, minutes on a Pi, violates C2 | Rejected for MVP |
| Local Bot API server (`--local`, 2000 MB) | full video uploaded | `api_id`/`api_hash` from a Telegram app, a second binary, TLS termination, bot login/logout migration `[TG-LOCAL]` | Rejected for MVP (revisit if > 50 MB becomes common) |
| Upload as document (no compression) | file, not a player | still capped at 50 MB `[TG-FILES]` | Rejected: no gain |
| Public URL handoff | Telegram fetches it | 20 MB cap `[TG-FILES]`; CDN URLs expire in minutes `[COBALT-README]` | Rejected: worse |

## Decision

- ≤ 50 MB → normal upload (R6).
- \> 50 MB → **R7/R8**: thumbnail (platform poster, else an ffmpeg frame at 1 s) + caption + source link,
  in **one** message where possible, with `🎬`-free plain text (no emoji unless the UI spec says so).
- No transcoding in the MVP. No local Bot API server.
- The decision is made **before** upload, from `Content-Length` / file size, so we never half-send.

## Consequences

- A long or high-bitrate video is never silently dropped: the user always gets a tappable card.
- The "under 3 min ⇒ video" promise holds only for files that fit; the README must say so (OQ-5).
- If the product later needs > 50 MB playback, the local Bot API server is a contained change: one compose
  service, one `apiRoot` config, plus the documented logOut/migration dance `[TG-LOCAL]`. ADR-012 is then
  superseded, not amended.
- Thumbnail generation needs ffmpeg; without it, use the platform poster and, if there is none, send text +
  link (R14).

## Evidence

`[TG-FILES]`, `[TG-LOCAL]`, `[COBALT-README]`.
