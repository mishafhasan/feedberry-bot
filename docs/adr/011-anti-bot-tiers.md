# ADR-011: Tiered anti-bot strategy (Tier 2 removed by ADR-017)

**Status:** Accepted (design) · 2026-10-29 · **Partially superseded by ADR-017:** Tier 2 (per-user cookies) is removed; no credentials are stored.

## Context

Several target platforms actively block automated access. The constraint is free and legitimate: no paid
CAPTCHA solving, no proxy pools, no account farms. Meanwhile the product promise is "it just works".

Verified reality per platform: Instagram needs a session cookie at the RSSHub level
(`INSTAGRAM_COOKIE`/`IG_COOKIE`) `[RH-CONFIG]` and the public instance answers 401 without an account
`[RH-IGISSUE]`; Facebook needs `FACEBOOK_COOKIE` `[RH-CONFIG]`; X requires OAuth tokens or an auth token
`[RH-CONFIG]` and its ToS forbid scraping without written permission `[X-TOS]`; TikTok's route is marked
`antiCrawler: true` and solves a WAF challenge itself `[RH-TIKTOK]`; cobalt warns that datacenter IPs are
throttled first and that story links need cookies `[COBALT-README]`.

## Options

| Option | Free | Legitimate | Reliability | Verdict |
|---|---|---|---|---|
| Official feeds/APIs only | yes | yes | high where they exist | **Tier 0** |
| Self-hosted RSSHub | yes | grey but unauthenticated retrieval only | medium | **Tier 1** |
| ~~Per-user session cookie~~ | *Removed by ADR-017.* | — | — |
| RSSHub `chromium-bundled` (Puppeteer) | yes (RAM) | grey | adds SPA coverage | **Tier 3**, off by default |
| Paid CAPTCHA solving / residential proxy pool | no | no | — | **Forbidden** |
| Browser-cookie reuse from the operator's personal account for all users | yes | no (credential sharing) | — | **Forbidden** |

## Decision

Four tiers, always tried in order, with the tier that succeeded recorded on the source:

1. **T0 native**: site RSS/Atom, YouTube channel feed, Bluesky AppView, Tumblr `/rss`.
2. **T1 RSSHub** with memory cache (600 s) so duplicate checks do not re-hit the platform `[RH-DEPLOY]`.
3. ~~**T2 cookie**~~ — **removed by ADR-017.** No user credentials are stored; a login-only source is refused
   at add time instead.
4. **T3 browser**: RSSHub Chromium image, operator-level flag, only when a specific route requires JS.
   Everything else keeps the lighter image `[RH-DEPLOY]`.

Plus a hard cap: on `error.fetch.rate` the source backs off 30 m → 2 h → 8 h; after three consecutive
failures the user gets one notice per 24 h with `[🔁 Retry] [← Back]`.

## Consequences

- Honest per-platform reliability is published (§10), not hidden behind "supported".
- Instagram/X/Facebook will still break: their feeds need a login we no longer have, X changes its front end, Meta tightens. The bot's
  job is to *report* that precisely (`E_COOKIE_REQUIRED` vs `E_RATE_LIMIT` vs `E_FEED_DOWN`), not to hide it.
- ~~Storing user cookies is a real liability~~ — removed by ADR-017: nothing is stored, so this liability is
  gone; the cost is that login-only feeds cannot be subscribed at all.
- Legal exposure differs per platform and is documented, not resolved, here (§12.5). X is the clearest
  prohibition `[X-TOS]`; the operator decides whether to enable that platform.
- T3 is intentionally not the default: it costs RAM and makes the whole instance heavier for one route.

## Evidence

`[RH-CONFIG]`, `[RH-IGISSUE]`, `[RH-TIKTOK]`, `[RH-DEPLOY]`, `[X-TOS]`, `[COBALT-README]`.
