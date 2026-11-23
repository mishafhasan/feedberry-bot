# ADR-034: The digest window follows publication time, and every part is bounded in bytes

**Status:** Accepted · 2026-11-24 · amends ADR-029 and ADR-033

## Context

Two reports came from the bot running on the Oracle host:

1. **Stale stories.** The digest summarised posts published two and three days earlier, not
   the day's news.
2. **A digest that stopped part-way.** A Tamil digest arrived as one message and the later
   summaries were missing, with no error in the chat.

Both traced to a single wrong unit each:

1. `digestPosts` bounded `posts.first_seen_at` — when the bot recorded the post. A source that serves
   its backlog (a new subscription, a republished archive, a feed that rotates its window) stamps
   every old story with today's fetch time. In the local database a post is recorded about an hour
   after it is published, (Tamilwin delivered 82 posts in 1.3 days), so a backlog lands squarely
   inside one window even though the stories are days old.
2. `pack` bounded **visible characters** only, and only at 30 000. ADR-033 measured 30 000 ASCII
   characters accepted and 33 000 refused, and separately recorded an accepted Tamil payload as
   "24 000 characters / **64 000 UTF-8 bytes**", and a real accepted part as "24 224 Tamil
   characters ... in **28 632 characters of HTML**". Those three readings are not the same quantity,
   and the digest guarded only one of them:
   - a realistic Tamil window (20 summaries and 60 "Also today" links) is **24 056 visible
     characters — inside the 30 000 budget — and 76 374 UTF-8 bytes**, 19% past the accepted payload;
   - a maximal English window is 29 066 visible characters but **34 136 characters of source HTML**,
     1 368 past the `RICH_TEXT_LIMIT = 32 768` that every other rich-message clamp in this repo
     measures — including `render-post.ts`.

   The packer therefore emitted one part, Telegram refused it, and `for (const plan of built.plans)`
   threw on the first part: nothing after it was ever sent. That is the "single message, later
   summaries dropped" symptom, and it is silent because the refusal only reaches the log.

## Decision

- **The window's clock is the post's publication time.** `digestPosts` selects and orders on
  `COALESCE(p.published_at, p.first_seen_at)`, strict on both ends. `first_seen_at` remains the
  fallback for a feed that carries no date, which is the only clock such a post has.
- **The trade-off is accepted and named:** a story published before the window never reaches a
  digest, however late a source served it. Per-post delivery still sends it, so nothing is lost from
  the chat; only its place in a summary is. This is what "the window is the day's news" costs, and
  it is why the column exists at all.
- **Every part is bounded in all three readings of the cap.** `pack` keeps `MAX_PART_CHARS = 30 000`
  on visible text (ADR-033's rule), and adds `MAX_PART_HTML = 30 000` on the source string — which is
  the unit `render-post.ts` already uses, and bounds the visible count for free — and
  `MAX_PART_BYTES = 64 000` on the UTF-8 payload, next to the existing 480 blocks and 49 media. The
  header and footer are reserved in each unit because they are our own, mostly ASCII, labels.
- **A feed's own name is clamped too.** The header prints `sources.title` once per story and nothing
  bounded it, so a paragraph-sized feed title could spend a whole part's budget before a summary was
  rendered — the one piece `pack` cannot split, because it only ever closes a part *between* pieces.
  `MAX_SOURCE_TITLE = 200` clamps it where the digest reads it.
- **English costs nothing.** Its markup is ASCII, so the byte budget never binds there; the source
  length binds instead of the visible count, which costs the maximal English digest nothing at all
  (it already needed two messages for its 60 photos). A maximal Tamil digest gains at most one.

## Consequences

- A busy Tamil day ships as several messages instead of one refused one. `digest_part_over_budget`
  now reports `chars`, `htmlChars` and `bytes`, so a future regression names the unit that broke.
- A backfilled archive no longer floods a digest; the stories stay reachable one by one.
- The `shortcut:` on resend-after-crash is unchanged: the window is still committed only after the
  last part is sent, so a crash still resends the whole digest.
- `shortcut:` a feed URL is the one string no clamp reaches. A post whose URL is tens of kilobytes
  would still make one oversized piece; it is refused with `digest_part_over_budget` and the run
  retries. Upgrade if a real source ever produces one.

## Evidence

- Probe on the real renderer, this repo. The Tamil shape (20 summaries + 60 overflow links) weighs
  `{chars: 24056, html: 33551, bytes: 76374}` and rendered as **one** part before this ADR; after it,
  two parts of `{chars: 18268, html: 22983, bytes: 56633}` and
  `{chars: 5788, html: 9292, bytes: 19741}`. The maximal English shape renders as two parts of
  `{chars: 24606, html: 28904, bytes: 29025}` and `{chars: 20157, html: 23683, bytes: 23782}`; before
  the source-length budget its first part was 34 136 characters of HTML against a 32 768 limit.
- `npx tsc --noEmit`: exit 0. `npm test`: **500/500 pass**. `npm run build`: exit 0.
- The artifact the image runs (`COPY --from=build /app/dist`), exercised directly: against a real
  SQLite file, `dist/db/repos/digests.js` selected `[undated, fresh]` and excluded a post recorded an
  hour ago but published three days ago; `dist/digest/render.js` split the Tamil shape into parts of
  `{chars: 18348, html: 23223, bytes: 56873}` and `{chars: 5788, html: 9292, bytes: 19741}`, with all
  20 summaries, all 60 "Also today" stories and the footer on the last part.
- The tests that pin it: `digest-window` (posts seeded so that fetch order and publication order
  disagree, so the ordering is pinned; a post exactly at the window's start is included and one
  exactly at its end opens the next window; a post recorded inside the window but published three
  days ago never appears, in this window or the next; a post with no date still counts by its fetch
  stamp), `digest-render` (a Tamil digest inside the text budget but past the payload ceiling is
  split; a maximal Tamil part stays inside all three budgets and still exceeds 32 KiB of UTF-8; every
  summary and every "Also today" story still present), and `digest-job` (a window that needs more
  than one part is sent as every part, the footer on the last, the oldest overflow story present, the
  window committed once).
- The Instant View cache needed no change and is unchanged by this ADR: `summarisePost` and
  `publishPage` already write `posts.telegraph_url` (schema v7), and delivery stores the page it
  publishes through `planArticle`'s and `withReadMore`'s `onPage`. A post whose page is thinner than
  `ARTICLE_MIN_CHARS` deliberately gets no page at either door.
