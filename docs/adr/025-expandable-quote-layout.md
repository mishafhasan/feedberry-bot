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

- Stage 6 always returns `rich`. **The whole body is the quote**: `expandableQuote(body)` wraps every
  line of the post, so nothing of the post is left outside it and the client's collapsed height is
  the only preview there is. The markup cannot pin that height to a line count — the product asked
  for five lines, the client decides (docs/expandable-quotes.md) — and the visible part is the first
  lines of the quote, in every client, for every post.
- `expandableQuote(body)` renders the body as inline RichText: one line per `<br/>`, every value
  escaped by the same `inline()` the open body used, and block markers flattened to their inline
  meaning (`# heading` → `<b>`, `- item` → `• item`, `>` dropped, the fence dropped, the code kept
  as text). No heading, list, `<pre>`, table or nested element ever enters the quote. A body with no
  words (media only) gets no quote rather than an empty one.
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
- A short post wears a quote box with no toggle, because the client only folds content taller than
  its collapsed height. That is the price of one layout for every post, and it keeps the body out of
  a paragraph block the reader cannot fold when the post is long.
- `shortcut:` a fenced block inside the quote keeps its text but loses its monospace block, because
  `<pre>` would break the toggle. Upgrade when a real source posts code.

## Evidence

`test/unit/rich-render.test.ts` (whole body in the quote, the 50-item list, inline-only guard,
empty-body case), `test/unit/rich-text.test.ts` (`expandableQuote` escaping and marker flattening),
`test/unit/caption-header.test.ts` (`<h3>`, `<tg-time>`, `relativeTime`), `test/integration/threads.test.ts`
(the 3,779-char sub-post arrives inside the quote). Tag behaviour: `docs/expandable-quotes.md`.

Live, against the real Bot API with the spike bot: the two requested links rendered by the real
pipeline and sent as they come out of stage 6 —
`x.com/The_techAI/status/2120336134568087586` (4,726 chars, no media, message 1779) parsed to
`heading, paragraph, paragraph, list, expandable_blockquote`, and `threads.com/t/Dfl9OZClIHt`
(6,044 chars, one uploaded photo, message 1780) parsed to
`heading, paragraph, slideshow, paragraph, expandable_blockquote`. The API returning
`expandable_blockquote` is the server's own confirmation that the quote is collapsible rather than a
plain quote.
