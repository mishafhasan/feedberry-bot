# ADR-019: RSS/Atom format coverage — parse the dialects, not every protocol

**Status:** Accepted · 2026-11-08 · **Extends:** ARCHITECTURE §5.3 (fetch adapter selection)

## Context

The feed layer reads three item dialects with one regex parser: RSS 2.0, Atom 1.0 and RSS 1.0 (RDF).
Live probes on 2026-11-08 (GitHub Atom, Wired RSS, Slashdot RDF, Guardian, BBC) showed three concrete
holes that no test covered, plus one spec-only hole:

- **RDF feeds could not be discovered.** `discoverAlternates` accepted only
  `application/(rss|atom)+xml`; RSS 1.0 advertises `application/rdf+xml`, and older sites use
  `application/xml` or `text/xml`.
- **An Atom entry could yield the feed's URL instead of the post's.** `linkOf` took the first `<link>`
  tag; a per-entry `rel="self"` before `rel="alternate"` (legal per RFC 4287 §4.2.7.1) won.
- **Every body was decoded as UTF-8** (`ssrf.ts`, `http.ts`), ignoring both the `Content-Type`
  charset and the document's own `<?xml encoding=?>` — a legacy `windows-1251` feed arrives as mojibake.
- **The guessed-path fallback had no budget.** Five paths at the 20 s default could hold one worker job
  for 100 s.
- **RSS 1.0 dates are `dc:date`** (there is no `pubDate` in the dialect). The parser only read
  `pubDate`/`published`/`updated`, so an RDF item with a date showed as undated. No live feed in the
  sample omits `pubDate`, so this one is spec completeness rather than a reproduced failure.

The parser is deliberately a regex reader with a `shortcut:` comment; it handles CDATA, entities,
relative links, `content:encoded` vs `description`, enclosures and `media:*`. Replacing it is not part of
this decision.

## Options

| Option | Effect | Verdict |
|---|---|---|
| **Keep the regex parser; close the four holes** | One file, no dependency, every current feed still parses | **Chosen** |
| Adopt `fast-xml-parser`/`sax` | Correct for malformed and exotic markup, but changes error semantics for every existing feed and adds a failure surface | Rejected for now; see the upgrade trigger |
| Per-site adapters | Works for the sites named, breaks for the next | Rejected |
| Add JSON Feed / HTTP `Link:` discovery | New formats for rare sites; nothing in the sample needs them | Rejected |

## Decision

1. **Discovery** accepts `application/(rss|atom|rdf)+xml` and `(application|text)/xml` alternates; JSON
   Feed and `Link:` headers stay out. The typed alternates are ranked first, and only they are a promise:
   a plain `application/xml` alternate is as often a sitemap as a feed, so when it fails discovery moves on
   to the next alternate and then to the guessed paths.
2. **The guessed-path fallback shares one budget**: `fetchNativeFeed(http, ref, budgetMs = 20_000)`
   stops between candidates and hands each the remaining time, so a dead site costs one request's worth
   of overrun, not five.
3. **A typed alternate stays authoritative.** A failed `rss`/`atom`/`rdf` alternate is rethrown as
   `DiscoveredFeedError`, because YouTube's RSSHub fallback keys its route by the URL it carries; a silent
   fallthrough would downgrade `…/youtube/channel/UC…` to `…/youtube/user/@handle`.
4. **`linkOf` chooses by `rel`** — `alternate`, else no `rel`, else the first tag — so RSS body links and
   Atom `href` links both survive.
5. **Dates**: `pubDate` → `published` → `dc:date` → `updated`. RSS 1.0 items are dated; feeds that carry
   `pubDate` are unaffected.
6. **One decode point**, `decodeBody(bytes, contentType)` in `http.ts`, used by both transports. Order is
   XML 1.0 §4.3.3 / Appendix F: BOM → the document's `encoding=` → the `Content-Type` charset → UTF-8.
   An unknown label falls back instead of failing the fetch. This applies to pages too, which is where
   most legacy encodings still live.
7. **A parse failure says what it saw**: `feed has no readable items` for a feed-shaped document, or
   `not a feed: <first 80 characters>` for a page. The code stays `E_NO_FEED` (the user-facing sentence
   and the retry ladder are correct); only the log message is sharper.
8. **No feed cache and no conditional GET.** Checks run every slot (hours); `HttpResponse` carries no
   `ETag`/`Last-Modified`, and adding them touches the transport, the schema and invalidation for a read
   that happens a few times a day. Revisit if a source interval drops below ~15 minutes.
9. **A page's own advertised feed is not fetched as a feed directory.** `directoryFeeds` skips URLs that are
   already alternates: the directory pass used to fetch the feed, discard it on the content-type check, and
   let `attempt()` fetch it again. Trade-off: a site that mislabels an HTML index as `rss+xml` loses that
   one directory pass; no such site was found, and keeping it would cost a request on every add.
10. **A pasted feed URL is used as itself.** `genericWebsite` now applies the same path rule as `sectionOf`,
    so `/rss/breaking_news/108` is a `feedUrl` rather than a page. Before, only a path *ending* in
    feed/rss/xml qualified; the URL was read as a page, resolved to its site root, and a site whose root
    publishes no feed answered `E_NO_FEED` — even though the pasted URL was a valid feed.
11. **The pasted page is never its own evidence, scoped or not.** WordPress answers `/<post-slug>/feed/`
    with the post's **comments** feed, whose URL carries the slug and whose items point back at the post, so
    the scoped test alone accepted it and a post link became a "category". `usable()` now drops items that
    point at the page before deciding, and compares hosts without `www.` (canonical URLs drop it, feed items
    keep it). A feed that is only the page talking about itself is not a section.

## Consequences

- `readCapped` returns `Buffer` (one caller) and `rawRequest` decodes with the same helper; no `Http`
  stub or adapter signature changes.
- The parser stays a regex reader. **Upgrade trigger:** a real site whose feed it cannot read — then a
  real parser goes behind the same `parseFeed` signature, with the current fixtures as the regression
  suite.
- Eight new fixtures: two captured (Wired RSS with all 50 items, GitHub Atom with one entry), one
  spec-shaped RSS 1.0 document, one Atom multi-link document, one discovery page, one HTML error page, one
  media-shape feed, and one raw `windows-1251` byte file. Captured files carry their URL and capture date in
  an XML comment after the root element.
- `E_NO_FEED` is still retried by the queue (five attempts); a permanently broken document goes quiet
  after the ladder, which is the existing contract.
