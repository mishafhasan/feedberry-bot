# ADR-006: Self-hosted RSSHub, no public instances

**Status:** Accepted (design) · 2026-10-29

## Context

RSSHub supplies routes that no official feed covers (Instagram, X, TikTok, Threads, Pinterest, Facebook,
Telegram). Its documentation publishes a list of public instances, but they are shared, rate-limited and
frequently lack the credentials a route needs: without an Instagram account the public instance answers
401 `[RH-IGISSUE]`. Route credentials differ per namespace and are global to the instance `[RH-CONFIG]`.

## Options

| Option | Availability | Verdict |
|---|---|---|
| Self-host RSSHub next to the bot | owned by us; one container; cookies/tokens under our control | **Chosen** |
| Public instances (rsshub.app and mirrors) | free, but shared rate limits, unpredictable 429/5xx, no Instagram/X without creds | Rejected as primary; kept as a per-source last-resort URL override |
| Re-implement each platform's HTTP calls in the bot | duplicates hundreds of routes, all the anti-bot logic, and its maintenance | Rejected |
| Paid RSS APIs / aggregators | violates C1 | Rejected |

## Decision

`diygod/rsshub:latest` (the **non**-Chromium image) on the same host, reached over
`http://rsshub:1200` on the compose network. Base URL is a config value (`RSSHUB_BASE`), so a source may
carry a full URL to a different instance if it ever needs one.

## Consequences

- Puppeteer-only routes are unavailable in the MVP image; the deploy doc is explicit that Chromium costs
  more resources but widens route coverage `[RH-DEPLOY]`. Switch to `chromium-bundled` only if a specific
  route demands it (Tier 3 in §10.1), and note that on arm64 the image ships without Puppeteer deps.
- Cache is on (`CACHE_TYPE=memory`, `CACHE_EXPIRE=600`) so a manual check 30 s after a scheduled one does
  not hit the platform twice — this is the cheapest rate-limit protection we have `[RH-DEPLOY]`.
- Credentials (`INSTAGRAM_COOKIE`, `FACEBOOK_COOKIE`, `TWITTER_*`, `TELEGRAM_*`) live in RSSHub's env, not
  in the bot DB. That is a deliberate split: instance-wide credentials never leave the container. Since
  ADR-017 no per-user credentials are stored at all, and instance tokens are optional and out of the MVP;
  a login-only route therefore fails cleanly instead of half-working.
- RSSHub is AGPL-3.0; we run it unmodified, so no source-publishing obligation is triggered for it.
- A stuck RSSHub takes down all non-native sources at once; §11 keeps native-RSS sources deliverable, and
  `/status` shows the RSSHub health separately.

## Evidence

`[RH-DEPLOY]`, `[RH-CONFIG]`, `[RH-IGISSUE]`.
