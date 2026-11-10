# ADR-021: A feed that ships no pictures, and a site that ships no feed

**Status:** Accepted · 2026-11-10 · **Extends:** ARCHITECTURE §5.3 (fetch adapters), §8.5 (Instant View)

## Context

Two reports, both reproduced live on 2026-11-10:

| Observed | Cause |
|---|---|
| `medium.com/@visrow/what-is-laya-…` extracted as 12 000 readable characters with **one** picture (the author avatar) | Medium puts each post picture in `<picture><source srcset>` and leaves the `<img>` without a `src`. Readability deletes a srcless `<img>` — and its `<picture>` — before `fixImageUrls` ever sees them, so every body picture was gone. |
| `medium.com/feed/@visrow` items carry 5–25 `<img>` inside `content:encoded`, yet `FeedItem.media` was empty for all ten | the parser only read `enclosure`, `media:content` and `media:thumbnail`. |
| `newsletter.evolvingai.io` and one of its `/p/…` posts answer **"Couldn't find a feed for this page"** | the publication is **beehiiv**, not Substack, and its RSS is off (`customization.rss_feed_map: null`): no `rel=alternate`, and `/feed`, `/rss`, `/feed.xml`, `/rss.xml`, `/atom.xml` all 404. beehiiv's feed URL is generated per publication and private, so there is nothing to derive. |
| a real Substack (`noahpinion.blog`, `slowboring.com`) already resolved before this ADR | every Substack publication answers at `<origin>/feed`, custom domains included, and `/feed` is the first guessed path. |

A rendered page cannot be fetched without a browser, and ADR-011 keeps the bot browser-free (C2). The
sitemap is the one machine-readable list a site publishes without opting in.

## Options

| Option | Effect | Verdict |
|---|---|---|
| Headless browser for JS-only pages | Would render Medium like a reader does | Rejected: memory and C2, and ADR-011 already refuses a browser tier |
| Scrape the beehiiv archive page | Fixed for this publication | Rejected: a per-host HTML scrape that breaks on the next newsletter platform |
| Follow the site's sitemap | Works for beehiiv, Ghost, WordPress and any site that publishes one | **Chosen** |
| Media RSS only | Leaves the reported Medium post with no pictures | Rejected |

## Decision

1. **Images are materialised before anything reads the page.** `resolveMedia(document, baseUrl)` runs on the
   raw DOM *and* on Readability's HTML: `srcset` picks the widest usable candidate, a `<picture><source srcset>`
   supplies the picture when the `<img>` has no source, `data-src` supplies a lazy one, and a CSS
   `background-image` becomes an `<img>`. The ranking lives once, in `src/platform/media-urls.ts`, and both
   readers call it.
2. **A feed item's pictures are its media.** The parser collects every `<img>`, `<source>` and CSS background in
   the item's own HTML — decoding a body that was escaped instead of CDATA-wrapped — into `FeedItem.media[]`, in
   post order and de-duplicated, at most 50 per post. A broken URL, a `data:` URI and an image that points back
   at the post are dropped rather than shipped. Each embedded video and each `.gif` also earns a line at the end
   of the item's body (`🎬 <url>`, `🎞️ <url>`), because a caption can play neither; the lines are added after the
   body is capped, so a long post can never lose them. Where the feed or the tag declares a size
   (`media:content width/height`, `<img width height>`), `FeedMedia` carries it; an undeclared size stays absent.
3. **The sitemap is the last resort of discovery.** After the conventional paths are refused, `/sitemap.xml` is
   read as a page list: at most 50 pages, newest `<lastmod>` first, and only the first path segment that holds at
   least half of the sitemap (`/p/…`, `/blog/…`, `/2026/…`) is followed — `/about` and `/subscribe` are the site,
   not its posts. A sitemap without `<lastmod>` cannot be ordered, so all of it counts (bounded at 1000 pages):
   freezing on the first 50 would let a source report success forever and never deliver again. The URL is stored in
   `sources.feed_url` exactly like a discovered feed, so every later check reads one URL.
4. **A Substack URL needs no fetch at all.** Stage 1 maps `<publication>.substack.com` to `<origin>/feed`, so the
   root and any post link both add the publication. A custom-domain Substack keeps working through the `/feed`
   guess.

Every rule added here is local and deterministic: no external NLP, classifier or browser service. An image is a
URL the HTML spells as one (tag attribute or CSS `url()`) that parses as `http(s)` and is not a spacer, a `data:`
URI or the page itself; a player is a host or file extension matched as a substring of the URL. All matching is
case-insensitive, and nothing guesses a picture the markup does not name.

## Consequences

- No schema change and no new strategy: a sitemap source is `native_rss`, and `feed_url` may name a sitemap.
  `fetchNativeFeed` tells a stored sitemap from a stored feed by the file name discovery gives it (`sitemap…`).
- A sitemap item has no title and no summary. Its slug is the title a list can print and its `<lastmod>` the date;
  the post itself arrives as an Instant View article, which is where the real title, text and pictures come from.
- A sitemap with no dominant directory is followed whole, so a flat blog stays followable and a corporate site
  without a feed becomes addable with its pages. The add screen still shows only the newest five before saving.
- The feed parser now reads the item's body twice (text and HTML). `summary` is unchanged when the post embeds
  nothing playable, so existing rows and previews keep their shape.
- A `.gif` is both a picture in `media` and a `🎞️ <url>` line in the body. Instant View animates it, but a remote
  `.gif` that reaches Telegram through `sendPhoto` is a still frame, so the link is what guarantees playback.
  Videos are not downloaded from feed bodies — the link is the deliverable, the player is the page.
- `FeedMedia` gained optional `width`/`height`, filled only from what the feed declares. Neither field is rendered
  today; they exist because the payload is the only place a writer can put them, and a guessed size is worse than
  none. Rows written before this ADR stay valid: both fields are absent.
