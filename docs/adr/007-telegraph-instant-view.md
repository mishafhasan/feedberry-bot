# ADR-007: Instant View via Telegra.ph rewrite

**Status:** Accepted (design) · 2026-10-29

## Context

The brief says articles are "converted to Telegram Instant View" and asks to determine how formatbot1
(the owner's earlier Telegram format bot) actually did it rather than assume. Its approach is what we
adopted; its code was studied here as a reference and is **no longer vendored in this repo** — the
ported logic lives in `src/article/`.

What the sources say:

- Telegram decides IV **per domain**: when a link preview is generated, the IV bot checks whether a
  template exists for that domain; if it does, the page is rendered through it `[TG-IVDOCS]`.
- Templates are authored in the IV Editor; they become public for all users only after Telegram approves
  them `[TG-IV]`.
- A bot may force a specific template with `t.me/iv?url=<encoded>&rhash=<hash>` and publish that link
  anywhere `[TG-IV]`. This still requires one template per domain.
- formatbot1 does **not** create templates. It fetches HTML, runs Readability, converts to Telegraph
  nodes and calls `api.telegra.ph/createPage` `[FB-TELEGRAPH]`. Telegra.ph is one of Telegram's own
  sample template domains `[TG-IV]`, so the resulting link opens in IV.

## Options

| Option | Coverage | Maintenance | Verdict |
|---|---|---|---|
| Telegra.ph rewrite (formatbot1's approach) | **any** readable HTML page | one API call per new article | **Chosen** |
| Own IV template per domain + `t.me/iv&rhash` | only domains we write templates for | unbounded, breaks when sites redesign | Rejected for MVP; kept as an optional operator escape hatch |
| Send the raw article link and hope IV exists | depends on Telegram's template catalogue | none | Rejected as the only path |
| Send a text summary instead of IV | always works | none | Fallback R13 only |
| `sendRichMessage` (Bot API 10.3) `[TG-SENDRICH]` | no IV, but rich layout | new, client coverage unknown | Rejected for MVP (OQ-16) |

## Decision

R12 = Readability → sanitize → Telegraph nodes → `createPage` → send `telegra.ph` URL with link preview
enabled. Pages above 64 KB (`createPage` content limit `[TG-TELEGRAPH]`) are split into chained pages with
a "Read Next page" link, reusing the exact algorithm formatbot1 used (ported to `src/article/telegraph.ts`).
No headless browser in the MVP path (`NO_PUPPET` equivalent).

## Consequences

- "Instant View" is truthful from the user's side, but the URL is `telegra.ph/…`, not the publisher's
  domain. That must be stated in the README (OQ-14) and in the post's caption only if asked.
- Ads and clutter disappear because Readability + sanitize remove them — this is how "without ads" is
  achieved, not by an ad-detection feature.
- Telegra.ph is an unauthenticated third party: downtime → R13 fallback; content policy → keep a copy of
  the source link in the message so nothing is lost.
- Images inside articles are hotlinked into Telegraph. formatbot1 already handled the common
  image-URL pathologies; those rules live in `fixImageUrls()` (`src/article/readability.ts`) rather than
  being re-derived.
- Articles behind a login wall produce thin content → R13, and the source is flagged `E_TELEGRAPH` in health.

## Evidence

`[TG-IV]`, `[TG-IVDOCS]`, `[TG-TELEGRAPH]`, `[FB-TELEGRAPH]` (formatbot1, reference only — not vendored).
