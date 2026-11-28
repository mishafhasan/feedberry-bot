# ADR-031: A walled extractor is not a failed download, and every source is named

**Status:** Accepted · 2026-11-21 · amends ADR-018 §2, ADR-021 and ADR-030 · its Facebook rows are
amended by ADR-032

## Context

Five reports, measured live on 2026-11-21, came from four different layers. One is a missing rule in
each, and every one of them was a place where two doors or two names disagreed.

- `instagram.com/p/Df9jCcQAOq8` in **Download Mode**: "This source needs a login the bot doesn't have"
  or "Couldn't extract media". The same post arrives from the **schedule**, because ADR-030 lets a
  walled Instagram resolve fall back to the feed's own photos — a rule the paste door never applied.
  Worse, the paste door let the extractor's exception end the *whole* download, so the reader got an
  error where the schedule got a post. Measured: with the operator session seeded, `oembed` answers
  `404 No Media Match`, the signed-out page shell carries no `media_id`, and cobalt returns
  `fetch.empty`; the account's RSSHub feed still holds the post and its pictures.
- **Facebook** `pfbid` story links: `permalink.php?story_fbid=…&id=…` was classified as a *page*, so
  the bot offered to follow `facebook.com/permalink.php`. cobalt has no Facebook story extractor
  (only `reel`, `share`, `watch?v=`, `photo?fbid=`), and ADR-006 keeps `FACEBOOK_COOKIE` in the
  RSSHub sidecar, so a story post has no media to fetch in either door. The schedule ships it as a
  link; the paste door answered with an error.
- `dailymirror.lk/rss/breaking_news/108` and `/rss/top_story/155`: both sources showed
  `www.dailymirror.lk`, because that is literally what the site publishes as `<channel><title>`.
  `feed.title ?? externalId` therefore named the domain twice.
- `tamilwin.com/article/…` and `tamilwin.com/popular`: the article extracts (853 readable characters)
  and downloads, but its site publishes no feed at all — no `rel=alternate`, `404` on `/rss` and
  `/feed`, and `/sitemap.xml` is a `<sitemapindex>` whose children ADR-021 never followed. Adding the
  site answered a bare `E_NO_FEED` with a Retry that could only fail again, and `/popular` was called
  "a post link" because a one-segment path is ambiguous by ADR-018 §2.

## Options

| Option | Result | Cost | Verdict |
|---|---|---|---|
| Fix each report where it was seen (paste door only, host table for titles, one path for `/popular`) | the same bugs on the next site | none | Rejected: four symptoms, one shared cause each |
| A second downloader for Download Mode | its own limits and failures | duplicates stage 5 | Rejected (ADR-013, ADR-028) |
| **One failure policy for both doors, and one naming rule for every source** | a walled post ships what the schedule ships | a few lines per layer | **Chosen** |
| Give the bot a Facebook cookie and write a story extractor | media for Facebook stories | a vendor extractor + ADR-006 reversal | Rejected: not a bug, and `FACEBOOK_COOKIE` stays the sidecar's |
| Treat every one-segment path as a source | `/popular` is a source | every article link becomes a source | Rejected |

## Decision

- **An extractor failure is a degradation, not a failure (both doors).** `runDownload` resolves in a
  `try`/`catch`, logs `media_resolve_failed`, and continues with what the page and the account's feed
  can supply — the policy `planForDelivery` already had. A post whose media nobody can read still
  ships as its words and its header link; that is what the schedule does, and what
  `err.E_NO_MEDIA` has always claimed to do.
- **ADR-030's feed fallback reaches the paste door.** `feedItemOf` reads the account's own feed once,
  only when it can add something (the engine walls, or neither the page nor the engine states a
  date), and the paste door applies the same rule the schedule does: an Instagram post's media is the
  feed's photos. A short `/p/<id>` permalink names no account, so `pageMeta` also reads `og:url`; its
  canonical `<user>/p/<id>` URL supplies the profile only when the pasted link cannot. If RSSHub's
  signed photo URL is refused by the CDN, stage 5 falls back to the page's accessible `og:image`, but
  only after the feed or extractor proved the post had photo media. It also supplies the date and the
  account title the feed prints, so the two doors render the same header for the same post (ADR-028's
  parity, extended to a *failed* resolve).
- **A one-segment listing word is a source.** `isListingUrl` adds `popular`, `trending`, `latest`,
  `top`, `hot`, `breaking`, `most-read`, `most-popular`, `top-stories` to ADR-018's marker-and-id
  rule. `isSectionUrl` is unchanged on purpose: a navigation word tells the *classifier* it is a
  listing, but it does not promise a category feed, so `fetchPageSource` still falls back to the
  site. `/technology` and every article slug stay ambiguous, decided by their feed.
- **A site that publishes no feed says so, once.** When a page's resolve ends `E_NO_FEED`, the bot
  answers `notice.noFeed` with the one button that can still work (`dl:post`) instead of a Retry that
  must fail again. An article link's Download is untouched: it never needed a feed.
- **`<sitemapindex>` is followed one level.** ADR-021 assumed an index implies the site has a feed;
  tamilwin.com disproves it. `fetchSitemap` reads up to three children inside the same deadline and
  merges their pages, storing the index URL so later checks repeat one known path. A child that
  fails is skipped; an index with no readable child is still the honest `E_NO_FEED`.
- **A feed that names only its host is named by its host and category.** `feedSourceTitle` keeps the
  feed's own `<title>` unless it is the domain, and otherwise builds `Dailymirror · Breaking News`
  from the host and the one path segment a feed URL names (`/rss/breaking_news/108` →
  `Breaking News`), skipping the segments that spell the feed itself (`rss`, `feeds`, `atom`,
  `index`, `*.xml`). A platform source has no category path — its last segment is the account — so
  there the caller's handle is the name. The preview, the stored `sources.title` and the source list
  all read it, so the two Daily Mirror categories can no longer look identical.
- **A Facebook permalink is a post, and its page is the `id` it names.** `permalink.php` and
  `story.php` join `FACEBOOK_POST_PATHS`; `profileOfPost` reads `?id=` (and `?set=pb.<pageId>`) so the
  chooser can still offer the page behind the post.

## Consequences

- A pasted post the extractor cannot read now arrives with its words and its link (or the feed's
  photos, for Instagram) instead of an error message; the paste door and the schedule render the same
  message for cases (g) and (h) of `test/integration/mode-parity.test.ts`.
- A Facebook story post still has no media: no extractor and no cookie reach it. That is the honest
  outcome of ADR-006, and it now reads as the post rather than as a failure.
- The paste door costs one extra feed request only when the engine or the page leaves something out,
  never on a post that resolves fully.
- A site with only a sitemap index is now followable as one source of its article list, which may be
  older than a feed's window: the sitemap window (50 dated, 1000 undated pages) is the source.
- `/popular` on a site with no feed answers the new notice instead of a post chooser; on a site with
  one, it opens the category preview directly.
- A feed whose `<title>` is its own domain now shows a derived name. A site whose feed title is a
  real name is untouched.

## Evidence

- Live probes: `oembed?url=…/p/Df9jCcQAOq8/` → `404 No Media Match`; the signed-in page HTML carries
  `"username"` but no `media_id` and `"viewer": null`; `resolve()` → `E_NO_MEDIA error.fetch.empty`
  with the operator session seeded. `dailymirror.lk/rss/breaking_news/108` answers `<title>www.dailymirror.lk</title>`
  (19,286 B, 12 items); `/rss/top_story/155` answers the same title (20,215 B, 12 items).
  `tamilwin.com` publishes no `rel=alternate`, `404` on `/rss`, `/feed`, `/rss.xml` and
  `/popular/feed/`, and a `<sitemapindex>` at `/sitemap.xml`; its article extracts 853 readable
  characters, its `/popular` page 2,818 of navigation text.
- `test/integration/mode-parity.test.ts` cases (g) and (h); `test/integration/section-source.test.ts`
  (two titles of one domain, and the no-feed notice); `test/unit/source-name.test.ts` (domain
  titles, feed file names, a platform handle); `test/unit/registry.test.ts` (listing word, Facebook
  permalink and the canonical it keeps); `test/unit/feed-parse.test.ts` (sitemap index, newest first).
