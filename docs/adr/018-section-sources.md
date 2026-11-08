# ADR-018: A category URL is a source of its own

**Status:** Accepted · 2026-11-07 · **Extends:** ARCHITECTURE §5.3 (fetch adapter selection)

## Context

Users follow one section of a site (`wired.com/category/science/`, `bbc.com/technology`), not only a whole
site or one article. Before this ADR a page with a path was `isWebsitePage`, i.e. a *post* whose origin was
the only addable source, so the smallest subscription covered every section.

Live evidence (2026-11-07) shows three different ways a site publishes a section feed, and no single one
covers the other:

| Page | Working feed | How it is found |
|---|---|---|
| `wired.com/category/science/` | `<path>/feed/` | WordPress convention, not advertised |
| `techcrunch.com/category/artificial-intelligence/` | `<path>/feed/` | advertised as a second `rel=alternate` |
| `bbc.com/technology` | `bbc.co.uk/news/technology/rss.xml` | the page links its own alias |
| `dailymirror.lk/top-stories/155` | `/rss/top_story/155` | a feed directory the page links, matched by id |

Article pages advertise only the site-wide feed, which is what separates them from a section — but that
requires a fetch, so it cannot be decided in the pure stage of §5.1.

## Options

| Option | Effect | Verdict |
|---|---|---|
| Per-site feed rules (a host table) | Works for the sites in the table, breaks for the next one | Rejected: the mechanism must apply to any blog |
| Treat every page as a section | Articles become empty subscriptions or wrong sources | Rejected |
| **Recognize the URL shape, let the feed decide, then filter** | Marker/id paths are sources up front; a one-segment page is proven by its feed; a site-wide feed is filtered by category | **Chosen** |
| Download mode only | Does not deliver anything | Rejected |

## Decision

1. **Stage 1 stays pure.** `sectionOf(url)` returns the page path of a website page (root and feed URLs
   excluded). `isSectionUrl` calls it a listing when a marker segment (`/category/`, `/topics/`, `/tag/`,
   `/section/`, `/collection/`, `/channel/`) or a section id (`/top-stories/155`) is present.
   `classifyLink` answers `source` for those, so they behave exactly like a profile link everywhere.
2. **A one-segment page is proven by its feed**, not by its shape (`/science` and `/my-article` are
   identical on the URL): free text resolves the page first, so a section goes straight to the preview
   and an article keeps the Download/Add chooser. Add Source resolves it the same way, with the site as
   the fallback (`fetchPageSource` returns which of the two answered).
3. **Stage 2 resolves the section feed** in this order: stored feed, page-scoped `rel=alternate`, the
   conventional path under the section, an alias the page links to itself, a feed directory the page
   links, and finally the site-wide feed **filtered** by `<category>` tags or item URL. Nothing usable is
   `E_NO_FEED` — never a silently empty source.
4. **Only an unscoped feed is filtered.** A feed whose URL carries the section segment is the section.

## Consequences

- No schema change: the category is the `canonical_url` path, the feed is `sources.feed_url` (already
  stored by the first check), and `sources.title` names the category (`BBC News · Technology`).
- `FeedItem` gains an optional `categories` field, so posts payloads stay small and old rows are valid.
- A resolve may now try up to 12 feeds within 20 s. It happens once per add and once per unknown feed;
  a resolved source stores its feed URL and later checks fetch exactly one.
- A site that publishes no feed for a section (no advertised feed, no conventional path, no linked
  directory, no alias) is refused with `E_NO_FEED`. That is a property of the site, not of the bot.
- `bbc.com/technology` works through the alias the page itself links, so no host-specific rule exists.
