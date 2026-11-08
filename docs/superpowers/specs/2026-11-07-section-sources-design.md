# Section sources: monitoring one category of a blog or news site

**Date:** 2026-11-07 · **Branch:** feat/section-sources

## Problem

Pasting a category URL (`https://www.wired.com/category/science/`) is classified as a post of its
origin, so the only subscriptions available are the whole site or a single article. Users want to
follow one category and receive only that category's posts.

## Evidence (live, 2026-11-07)

| Page | Advertises | Working feed | Items |
|---|---|---|---|
| `wired.com/category/science/` | site-wide `feed/rss` only | `<path>/feed/` (WordPress) | 20, tagged `Science` |
| `techcrunch.com/category/artificial-intelligence/` | site feed + category feed | category feed | 20 |
| `bbc.com/technology` | nothing; page links its alias `bbc.co.uk/news/technology` | `<alias>/rss.xml` | 21, no tags |
| `dailymirror.lk/top-stories/155` | nothing; page links a feed directory `/rss` | `/rss/top_story/155` (same id) | 12 |
| `theguardian.com/science` | `rel=alternate` → `/science/rss` | scoped alternate | — |

Article pages (`wired.com/story/…`, `techcrunch.com/2026/11/06/…`, `bbc.com/news/articles/…`)
advertise only the site-wide feed, which is what separates them from a section.

The Guardian shows that a section can be a single path segment and still be identifiable — by its
feed, not by its shape. BBC shows the opposite: no advertised feed, but the page links its own alias
(`/news/technology`), and `<alias>/rss.xml` is a real feed.

## Design

### Stage 1 (pure) — `src/platform/registry.ts`

- `sectionOf(url)` — the page path of any website page that is not a feed (used at resolve time).
- `isSectionUrl(section)` — the URL alone says "listing": a marker segment (`/category/`, `/topics/`,
  `/tag/`, `/section/`, `/collection/`, `/channel/`, `/sections/`, `/categories/`) or a section id
  (`/top-stories/155`). A single segment (`/science`) is ambiguous with an article slug, so it is not
  classified as a source; the feed decides instead.
- `classifyLink` returns `{kind:'source'}` for a section URL. `isWebsitePage` is unchanged, so
  Download Mode still accepts the page.

### Stage 2 — `src/platform/feed/section.ts`

`fetchSectionFeed(http, ref, section)` tries, in order, stopping at the first usable feed:

1. the stored/discovered feed URL;
2. feeds the page advertises that are **scoped** to the section;
3. `<origin><section>/feed/`, `/rss`, `/rss.xml`, … (WordPress, Ghost, Hugo, news CMS);
4. `<alias>/rss.xml` for same-section links the page makes to itself under another path (BBC);
5. a **feed directory** the page links (`/rss`), matched by the section's id or words (Daily Mirror);
6. the page's unscoped site-wide feed, **filtered** to items whose link or `<category>` tags match the
   section.

Nothing usable → `E_NO_FEED` (the existing "Couldn't find a feed for this page." message). The feed
that answered is returned as `feedUrl`, so later checks go straight to it.

A feed counts as scoped when its URL carries the section's last path segment; only an unscoped feed
is filtered, so a genuinely category-scoped feed is never emptied by a stricter tag rule.

### Filtering — `src/platform/feed/native.ts`

`FeedItem.categories?: string[]` is parsed from RSS `<category>` and Atom `<category term=…>`. An item
matches when its link path carries a section word, or one of its tags equals a section word after
slug normalization.

### Add flow — `src/pipeline/s2-feed.ts`

`fetchFeed` routes a `native_rss` source with a section path to `fetchSectionFeed`.
`fetchPageSource` (used by `runResolve`) resolves a pasted page as a section first and falls back to
the site it belongs to, so "Add source" on an article keeps its old meaning.

### UI

- S4/S5 body gains `📂 Category: Science` (`s4.category`, six languages), so the preview states what
  is being monitored.
- The stored title names the section (`BBC News · Technology`) unless the feed title already does
  (`Science Latest`), so S6 and the S7 card confirm it without a second line.

### Storage

No schema change: the section is the `canonical_url` path, and the section feed is `sources.feed_url`.

## Non-goals

- A site that publishes no feed at all (no advertised feed, no conventional path, no linked
  directory, no alias) stays unsupported and reports `E_NO_FEED`.
- No per-site rule table: the mechanism is the same for every host.

## Tests

- Unit: `sectionOf`/`isSectionUrl`/`classifyLink` shapes, the six resolver tiers with a stubbed `Http`,
  `<category>` parsing in RSS and Atom, the item filter.
- Integration: paste a category URL → S4 shows the category line → Add stores the section URL, the
  scoped feed URL and the section title.
