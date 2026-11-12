# ADR-025: Long social posts fold into an expandable quote

**Status:** Accepted · 2026-11-13 · amends ADR-023, supersedes ADR-024

## Context

ADR-023 delivers a non-RSS post as one rich message, and ADR-024 folded long bodies behind a "Show
more" button: the bot stored the full body under a token, the tap edited the message in place with
the `file_id`s the send returned.

That works, and it costs a callback route, a process-local payload cache with its TTL, and an edit
per tap — all of it gone after a restart, and none of it present when the message is forwarded. Bot
API 10.x offers the same interaction natively: a `<blockquote expandable>` renders a client-side
"Show more" control with no bot state at all. `docs/expandable-quotes.md` records what the tag does
and does not allow, verified live against the API.

Two facts decided the layout:

- A quote takes **inline RichText only**. One block child (a heading, a list, a `<pre>`) and the
  client silently drops the collapse control and renders the quote permanently open.
- The **collapsed height is not configurable**. "Show N lines, hide the rest" is therefore built
  structurally: the visible part is ordinary blocks, the hidden tail is the quote.

## Options

| Option | User result | Cost | Verdict |
|---|---|---|---|
| Keep ADR-024's button | preview + tap to edit | callback route, payload cache, one edit per tap | Rejected: the client already ships this control |
| Whole body always open | everything readable | a wall of text above the reader's thumb | Rejected: the reason ADR-024 exists |
| **Visible preview + `<blockquote expandable>` tail** | preview, then one native tap to expand | a tail renderer that is inline-only | **Chosen** |

## Decision

- Stage 6 always returns `rich`. The body is split at a paragraph boundary with
  `splitPreview(text)`: the preview is the first two paragraphs or about 240 characters, and the tail
  is everything else. A tail under 240 characters is not folded — a quote that fits the collapsed
  height draws no toggle, so the post would wear a dead quote.
- `expandableQuote(tail)` renders the tail as inline RichText: one line per `<br/>`, every value
  escaped by the same `inline()` the open body uses, and block markers flattened to their inline
  meaning (`# heading` → `<b>`, `- item` → `• item`, `>` dropped, the fence dropped, the code kept
  as text). No heading, list, `<pre>`, table or nested element ever enters the quote.
- Order stays: header, `<tg-slideshow>` (≤50 uploaded photos/videos/animations) and audio blocks,
  the body, then one `🎬 <a href="direct URL">Video n</a>` line per video that cannot upload.
- The header becomes two blocks (ADR-023's single `<p>` is gone): the source line as `<h3>`
  (`{platformIcon} <a href="post URL">SourceName</a> | SourceType`) and the time as
  `<p>⏱️ <b>Time</b>: <tg-time unix=… format="r">…</tg-time></p>`. `relativeTime()` writes the
  fallback label — "just now", "5 minutes ago", "2 days ago" — and the day-first absolute time in
  the reader's `users.tz` past a week; `<tg-time format="r">` keeps the label right as the message
  ages, which a static string cannot.
- `platformIcon()` falls back to `🌐` for a platform the icon table does not own (it used to print a
  satellite dish).
- Retired with ADR-024: the `rich_more` plan kind, `sendRichMore`, `expandMore`, `moreButton`,
  `fileRefsOf`, `src/telegram/more.ts`, and the `more:` callback route. Nothing in the delivery path
  carries post state across messages any more.

## Consequences

- A long post opens compact and expands with no round trip: it works in a forwarded copy, after a
  bot restart, and in channels where a callback would need the bot to be an admin.
- Collapsed text is client-side only, so it is not searchable and not in the message preview line
  while folded — the trade ADR-024 named, now paid for a smaller mechanism.
- A quote whose tail lands under 240 characters is not built at all; the post simply stays open.
- `shortcut:` a fenced block inside the folded tail keeps its text but loses its monospace block,
  because `<pre>` would break the toggle. Upgrade when a real source posts code past the fold.

## Evidence

`test/unit/rich-render.test.ts` (preview + tail, inline-only guard, short-tail case),
`test/unit/rich-text.test.ts` (`splitPreview`, `expandableQuote` escaping),
`test/unit/caption-header.test.ts` (`<h3>`, `<tg-time>`, `relativeTime`),
`test/integration/threads.test.ts` (the 3,779-char sub-post arrives inside the quote).
Tag behaviour: `docs/expandable-quotes.md`.
