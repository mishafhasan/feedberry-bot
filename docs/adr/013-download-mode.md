# ADR-013: Download mode as pipeline reuse

**Status:** Accepted (design) · 2026-10-29

## Context

S1 shows a **Download Mode** button and its description says: "Send post link of supported platforms and
bot will send the file/media as post." It is not in the written user flow (send link → add source).

The temptation is to build a second downloader. That would duplicate media resolution, size limits, caption
splitting and flood control — four places where behaviour must stay identical.

## Options

| Option | Duplication | Risk | Verdict |
|---|---|---|---|
| Reuse pipeline stages 3–7 with an ephemeral, unpersisted item | none | none | **Chosen** |
| Separate download codepath | resolve/download/send duplicated | divergent limits and rate handling | Rejected |
| Store download requests as a real source/subscription | pollutes `sources`, hits `MAX_SOURCES_PER_USER` | user must delete to reclaim quota | Rejected |
| Skip the feature | none | S1 button present but dead — violates the normative UI | Rejected |

## Decision

`menu:download` sets `fsm.mode = "download"` and `state = awaiting_source_link`. On link:

1. `resolve` (stage 1) — must be a **post** URL, not a profile. A profile link answers
   "Send a post link, not a profile."
2. Stages 3→7 run exactly as for a subscribed post, with `chat = current chat`, `thread_id = current topic`.
3. **Nothing is written** to `sources`, `subscriptions` or `posts`; only a `deliveries` row with
   `post_id = NULL` (nullable for this case) and an `events` row for quota accounting.
4. Quota: download requests count against a separate `MAX_DOWNLOADS_PER_DAY` (default 30), not against sources.
5. Any failure renders the standard error keyboard `[🔁 Retry] [← Back]` and returns to `idle`.

## Consequences

- One renderer, one rate limiter, one set of limits — the download path cannot drift.
- `deliveries.post_id` must be nullable, or downloads need their own table. Nullable is one column, so it wins.
- A download is not idempotent across retries (a retry re-downloads); acceptable because it is user-triggered
  and quota-limited.
- Download mode is the only way Snapchat is usable (OQ-1) and the only way to fetch a Pinterest `/ideas/`
  pin image, so it is not a gimmick.

## Evidence

`UI-Refference/1. Main menu.png` (button + description), §5.1 and §15 OQ-8 of ARCHITECTURE.md.
