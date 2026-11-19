# ADR-030: The extractor reads what the post shows, and Instagram needs the operator's session

**Status:** Accepted · 2026-11-19 · implements ADR-027 for X and Instagram, narrows ADR-006

## Context

Five reports of media not arriving traced to the extractors, not to stage 5: `prepareMedia`'s size
gate, the ladder and the poster pass were all correct and simply never received an item.

Measured live on the reported links (2026-11-19):

- `api.x.com/graphql/4Siu98E55GquhG52zHdY5w/TweetDetail` answers **404 for every guest id**, so the
  syndication payload is the only live path without a session. Signed in with the operator's
  `auth_token` the retry answers **200**, and the GraphQL reader is then the one that runs: both
  readers need the same rule, or the quoted clip comes back depending on who asks.
- For `x.com/painn_x/status/2123090972225523986` and `…/2122793289762172998` the payload has **no focal
  `mediaDetails`**: the clip lives in `quoted_tweet.mediaDetails` (syndication) or
  `quoted_status_result.result.legacy.extended_entities.media` (GraphQL). `twitter.js` read the focal
  list only and answered `fetch.empty` — the reader saw "⚠️ Couldn't extract media".
- X writes a rendition as `WxH` in the CDN path. A 9:16 clip's renditions are 320x568, 480x852, 720x1280,
  1080x1920, 2160x3840, so reading the second number made a `1080` request answer **480x852** and a `720`
  request answer **320x568**.
- With the session seeded, the Instagram handler made **seven** requests (oembed, two mobile-API calls,
  two embed pages of 541 KB, a page load, a GraphQL POST) and still answered `fetch.empty`. The mobile host
  says `login_required` without a session and `challenge_required` with one; the embed page no longer
  carries `contextJSON`; the page-load `SiteData` marker is gone, so the GraphQL route is walled.
  `GET www.instagram.com/api/v1/media/<id>/info/` answers **200 with the full item** for that session, and
  **429 without it**.

Two gates stopped the session before any of this mattered: `src/config.ts` never read
`INSTAGRAM_COOKIE`, so `main.ts` never seeded it, and `docker-compose.yml` blanked it for the bot
container (ADR-006: instance-wide credentials live in the RSSHub sidecar).

## Options

| Option | User result | Cost | Verdict |
|---|---|---|---|
| Fix only the Instagram cookie plumbing | still `fetch.empty` | none | Rejected: measured, the handler never asks the one endpoint that works |
| Rewrite both extractors around a shared media normaliser | same layout | a large vendor diff touching retweet/card/visibility branches | Rejected: no user-visible gain |
| **Read every shape the payload states, and add the one Instagram rung that answers** | media and posters arrive | a few lines per handler; one operator credential in the bot | **Chosen** |
| Delete Instagram's dead embed/GraphQL chain | same | large diff, loses the upstream sync surface | Rejected |
| Transcode to fit 50 MB | inline video | CPU per post, quality loss | Rejected (ADR-026) |

## Decision

- **X: the quoted post is part of what the post shows.** Both readers apply one rule: the syndication
  fallback merges the focal `mediaDetails` and then `quoted_tweet.mediaDetails`, and `extractGraphqlMedia`
  merges `extended_entities.media` and then `quoted_status_result.result.legacy.extended_entities.media`
  (unwrapping `TweetWithVisibilityResults`). Focal first; the syndication assignment is conditional so a
  link-card result survives. `photos` and the flat `video` node are not read: measured, `photos[].url`
  repeats `mediaDetails[].media_url_https`, and `mediaDetails[].video_info.variants` is the same list with
  `content_type`/`url`.
- **X: a clip states its poster.** The single-media branch sets `cover: mediaItem.media_url_https`, which
  `normalize()` forwards and `media-engine` maps to `MediaItem.poster`. This is what ADR-027 already
  promised; the field was simply never set, so the og:image fallback answered with X's **link-card**
  image (`pbs.twimg.com/card_img/…`, read off the reported post).
- **X: a rendition's class is its shorter side.** `heightOf()` reads `Math.min(w, h)`, so `720x1280` is a
  720p clip. Landscape and square renditions are unchanged (`min(w, h) === h` when `w ≥ h`); only portrait
  clips move up to the rung their name promised.
- **X: one unusable item never costs the post.** The picker branch reads `video_info?.variants ?? []`,
  drops an item whose rendition list is empty, and tolerates a missing thumbnail. The merged list can now
  carry quote-level items this branch never saw before.
- **Instagram: the web API is asked first when a session exists.** `GET /api/v1/media/<id>/info/` with
  `commonHeaders` + the cookie answers with the same `items[0]` shape `extractNewPost` already reads: two
  requests for a signed-in post instead of seven. A `status: 'fail'` answer becomes
  `content.post.private`, so a challenged session reports as a credential problem instead of a wall.
  Without a cookie the rung is never asked (it answers 429) and behaviour is exactly as before.
- **Instagram: `hasData` means a post can be read.** The predicate is the union of the fields the two
  extractors consume. The old one compared `undefined !== null`, so a `{ gql_data: undefined }` answer
  counted as data and ended the chain.
- **Instagram: a clip states its poster** — `display_url` (old shape) or
  `image_versions2.candidates[0].url` (new shape).
- **The bot may hold the operator's Instagram session.** `INSTAGRAM_COOKIE` is read by `config.ts`, seeded
  through `setCookies`, logged as a boolean at boot, and no longer blanked by compose. ADR-006's rule
  stands for Facebook; the precedent is `TWITTER_AUTH_TOKEN`, which the X extractor has always used. This
  is an operator credential, so ADR-017 holds: no per-user credential is ever stored.
- **A feed's own photos survive a dead extractor.** When an Instagram resolve returns nothing, the feed's
  `payload.media` photos are the media. On any other platform a feed photo is a clip's thumbnail (R14) and
  stays dropped.
- **A post over `MAX_DOWNLOAD_MB` degrades per item.** The largest inline clips become labelled links
  until the total fits, instead of the whole post becoming a bare link; only a post whose photos alone
  exceed the cap is refused (ADR-012's silent-success path stays intact).

## Consequences

- The two reported X quote posts now resolve and attach; the 82.8 s landscape clip ships at 1776x1080
  (21.8 MB), the 113.5 s portrait clip at 1080x1920 (38.2 MB) instead of 480x852 (5.2 MB).
- A photo-plus-quoted-clip post ships as a two-item album rather than a still alone.
- An over-ceiling clip now carries a real poster, and both doors pick the same one.
- Instagram post links resolve again, in two requests. A challenged or expired session is reported as
  `E_COOKIE_REQUIRED` instead of "Couldn't extract media", and an Instagram source still ships the
  pictures its feed carries.
- X portrait clips transfer more bytes per delivery. Under the ceiling the ladder still steps down
  correctly (720 → 720x1280, 10.2 MB on the measured clip).
- A signed-in X request reaches the GraphQL route, so both readers carry the same rule: the quote's
  media never depends on which one answered.

## Evidence

- Live payloads captured from the three reported X links, and the ranked renditions probed by ranged GET
  (1,455,451 / 3,972,521 / 11,815,058 / 21,780,903 B and 2,725,398 / 5,205,395 / 10,169,583 / 38,236,472 /
  134,028,098 B).
- The seven-request Instagram trace, and `resolve()` answering `fetch.empty` with the session seeded
  before the change, versus two requests and a media item after it.
- `test/unit/twitter-syndication.test.ts` (quoted clip, quote beside a focal photo, empty, portrait and
  landscape rungs, a variant-less item), `test/unit/instagram-media.test.ts` (web rung, challenge mapping,
  the `hasData` regression, no cookie), `test/integration/mode-parity.test.ts` (both doors identical),
  `test/integration/m8.test.ts` (the feed's photos when the extractor walls).
