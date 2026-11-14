# ADR-028: Download Mode and the schedule are two doors into one pipeline

**Status:** Accepted · 2026-11-14 · amends ADR-013 and ADR-026

## Context

A pasted link (`src/bot/callbacks.ts`, `runDownload`) and a subscribed post (`src/pipeline/run.ts`,
`planForDelivery` → `deliverPending`) are two entry points to the same stages 5–7. They already share
`prepareMedia`, `ladderFor`, `withPosters` and the renderer, so the *decision* logic cannot drift. What
drifted was the environment each door handed to that logic, and the user saw it as randomness:

- A delivered post showed the direct media URL as visible text where a paste showed `🎬 Video 1`.
- A clip well under 50 MB arrived as a label in the schedule but attached inline from a paste.

Both doors called `mediaSignal(120_000)` — one wall clock covering resolve, size probe, poster fetch
**and** the transfer. The gate allows a 50 MB file, and 50 MB at 1.5 Mbps needs ~4.5 minutes. The same
post therefore attached or linked depending on the network of that minute, and a transfer cut mid-stream
degrades exactly like an oversized clip: the label takes over. The tests were green because a fake engine
answers instantly; only a real transfer exposed the contradiction.

The visible-URL symptom had a second, independent cause: a feed whose text repeats the media URL printed
that URL in the quote *and* linked it from the label, so the reader saw the raw string twice.

## Options

| Option | Result | Cost | Verdict |
|---|---|---|---|
| Raise the single 120 s window | fewer cut transfers | still couples a small page fetch to a 50 MB body; 50 MB on a slow line still fails | Rejected: the same bug, less often |
| Per-door timeouts | each door can tune its own | two numbers to keep equal, and they will diverge again | Rejected: the divergence *was* the bug |
| **One budget per kind of operation, shared by both doors** | a transfer is sized by the ceiling, extraction stays short | two constants, one rule | **Chosen** |
| Never link a video, retry until it fits | inline always | a dead host blocks the post forever; ADR-012 already accepts a labelled link | Rejected |

## Decision

- **Two budgets, named by what they cover.** `EXTRACT_BUDGET_MS = 30_000` covers resolve, size probe,
  metadata and posters — small requests. `DOWNLOAD_BUDGET_MS = 300_000` covers the transfer: 50 MB at
  ~1.4 Mbps, with headroom. Both live in `prepare-media.ts` and are imported by both doors; neither door
  owns a timeout of its own. `run.ts`'s old `MEDIA_TIMEOUT_MS` and `callbacks.ts`'s
  `DOWNLOAD_TIMEOUT_MS` are gone.
- **The split is by operation, not by stage.** `resolve`, `pageMeta`, `pageText` and the poster pass get
  the extract signal; `prepareMedia` (the size probe + download) and the poster download it triggers get
  the transfer signal. A page fetch can no longer eat the transfer's time, and a slow transfer no longer
  looks like a dead page.
- **A label already carries its URL, so the body drops the duplicate.** `richPlan` strips, from the
  post's own words, every URL a link-only video links. It runs inside `richPlan`, so both doors get it;
  it touches text only when the label exists, so an inline clip keeps its author's words intact.
  Removal leaves no triple newlines and no trailing spaces behind.
- **Parity is tested, not asserted in prose.** `test/integration/mode-parity.test.ts` drives the same
  post through `deliverPending` with seeded rows and through the bot's paste handler on the fake Bot API,
  with one fake engine and one fake HTTP for both, and compares the two `rich_message.html` strings
  byte for byte. Four shapes: a small Instagram clip (inline), a large X clip (label + poster, 1080 URL),
  a YouTube community post (derived `hqdefault` poster + `youtu.be` label), a two-clip Instagram carousel
  (all inline). Case (c) makes the fake engine answer the post page with two of its own images, which is
  what caught the last divergence before it reached a user.
- **`keepOversizedVideo` stays an RSS-only flag.** Both doors pass `ladderUrl` + `poster` for every
  non-RSS platform and never set `keepOversizedVideo`; only the schedule's RSS branch sets it, because a
  blog album cuts a stand-in frame from the bytes (ADR-012/022). A social post therefore takes the same
  branch from either door.
- **A community post is never resolved.** `planForDelivery` skips `media.resolve` when the URL is a
  YouTube `/post/`, because that page is not a media file: the feed already carries its photos and its
  attached clip, and resolving the page only answers with the page's own images. Live, cobalt answered
  with two images and the schedule printed them beside the poster while the paste printed one; the paste
  door routes a community post to its page adapter and never resolves it, so neither does the schedule.

## Consequences

- A clip under the ceiling now has five minutes to land instead of two; the label is reserved for clips
  that genuinely do not fit, are gone, or exceed the ladder.
- A post's text that repeats its own media URL reads once, as the label; the link is not lost, because
  the label is the link.
- The two doors still differ in *failure* UX by design: a paste answers with the bot's error message, a
  schedule records `failed` and moves on. Layout parity is a success-path guarantee.
- `shortcut:` the per-post total budget (`MAX_DOWNLOAD_MB`, 100 MB by default) is unchanged. A carousel
  whose items each fit 50 MB but sum past 100 MB still trips it, and the schedule then loses the whole
  album rather than trimming it. Upgrade when a real source ships such a carousel.
- `shortcut:` the parity harness fakes the engine, so it proves the *decisions* are shared, not that a
  live CDN transfer survives. The live Docker run (both doors) is the evidence for the transfer budget.

## Evidence

- Live, inside the deployed image, both doors on the same link (real CDN, real Telegram):
  - X long tweet — paste 9 s / schedule 4 s, 1 upload (poster), 1 label on `…/1280x720/….mp4`, no bare URL.
  - Instagram reel — paste 22 s / schedule 17 s, 1 upload (the clip inline), 0 labels.
  - TikTok — paste 10 s / schedule 5 s, 1 upload (the clip inline), 0 labels.
  - YouTube community post — both doors 1 upload (derived `hqdefault` poster), 1 label on `youtu.be/…`,
    identical slideshow and identical quote+label body after the resolve skip.
- A real subscription cycle on the deployed container (no probe process, the scheduler fetching on its
  own): a seeded YouTube channel delivered 11 posts (messages 2053–2063: one video inline and ten
  community posts); a seeded TikTok source delivered 10 videos (2066–2075) and a seeded Instagram source
  10 posts (2076–2085), every row `status = sent`. X profiles cannot be followed without instance tokens
  (ADR-017), so X is verified through both doors on a single post instead of a subscription.
- `npm test`: 405/405, including the four parity cases and the ADR-028 budget arithmetic
  (`50 MB / DOWNLOAD_BUDGET_MS` ≥ 150 kB/s) and the URL-dedupe case in `test/unit/video-label.test.ts`.
- `test/unit/prepare-media.test.ts` keeps the gate, ladder, poster and idempotence cases green under the
  new budgets.
