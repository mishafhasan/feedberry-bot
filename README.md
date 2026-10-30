# FeedBerry Bot

**Fresh posts from your favorite accounts, delivered to Telegram.**

FeedBerry watches the profiles and blogs you care about and re-publishes each new post into a Telegram
chat — your DM, a group, a channel, or a forum topic — as a normal Telegram post: original-quality media,
readable article text, no watermarks, no ads.

- Design: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · Plan: [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) · Decisions: [docs/adr/](docs/adr/)
- Status: **M8 of 9** (reliability: retries, 429 policy, health, alerts, `/status`). Nothing here pretends to work before it does.

## How it works

```
link ──► resolve ──► feed fetch ──► classify ──► dedupe ──► media ──► render ──► deliver ──► record ──► cleanup
        (platform)   (RSSHub/RSS)   (cobalt)     (posts)     (cobalt)   (§8)      (rate lim.)  (SQLite)
```

- **One process, one SQLite file, long polling.** No webhook, no inbound port, no second service (ADR-002, ADR-003, ADR-009).
- **Idle costs nothing.** A 30 s tick runs two cheap queries; heavy work starts only from a due source, a user tap, or a retry.
- **Engines:** [RSSHub](https://docs.rsshub.app/) for feeds, [cobalt](cobalt-engine/) in-process for media, Readability + Telegra.ph for articles.

## Quick start

Requires **Node.js 24+** and a Telegram bot token from [@BotFather](https://t.me/BotFather).

```bash
npm install
cp .env.example .env      # set BOT_TOKEN, ADMIN_CHAT_ID, RSSHUB_BASE
npm run dev               # runs src/ directly, no build step
npm test                  # node:test, fixtures only, no network
```

`npm start` runs the compiled build (`npm run build` first). Docker Compose arrives in M9.

## Configuration

All limits are config, never hard-coded (ARCHITECTURE §6). Defaults in `.env.example`:

| Variable | Default | Meaning |
|---|---|---|
| `BOT_TOKEN` | — | Bot token. Required, never logged, never stored. |
| `ADMIN_CHAT_ID` | — | Operator DM for alerts and `/status`. Required. |
| `RSSHUB_BASE` | — | Your self-hosted RSSHub. Public instances are not used (ADR-006). |
| `MAX_SOURCES_PER_USER` | 250 | Shown as `Sources: N / 250`. |
| `MAX_CHATS_PER_USER` | 20 | Validated on add. |
| `MAX_DOWNLOAD_MB` | 100 | Pre-check before any media download. |
| `BACKFILL_COUNT` | 5 | "Add and send latest posts" sends this many. |
| `MAX_SOURCE_AGE_DAYS` | 30 | Retention for `posts`. |
| `WORKER_CONCURRENCY` | 2 | Keep ≤ CPU cores. |
| `MAX_DOWNLOADS_PER_DAY` | 30 | Download Mode quota. |
| `TRIAL_ENABLED` | false | Shows the S1 trial line (OQ-7: off). |
| `TELEGRAM_BETA` | false | Telegram channel sources via the public `t.me/s` page (OQ-3). |

## Things worth knowing before you deploy

- **No credentials are stored.** Login-only feeds (Instagram, Facebook, X, and Telegram profiles) are **refused
  at add time** with a clear message instead of failing silently; single posts still work in Download Mode.
  There is no cookie table, no encryption, no per-user secret (ADR-017).
- **50 MB is a hard Bot API ceiling.** Bigger videos arrive as a thumbnail + caption + link; nothing is
  transcoded. Any clip 3 minutes or longer goes the thumbnail route too (ADR-012).
- **"Instant View" is a Telegra.ph rewrite.** Telegram's IV works per domain and a bot cannot register a
  template, so articles are converted to a Telegra.ph page (which already has an IV template) and the link is
  sent. On failure the original link is sent instead (ADR-007).
- **Fidelity limit.** Telegram HTML supports text formatting and links only: no custom fonts, CSS, image
  grids or carousel chrome. Media order + caption + author name is the maximum achievable; this project never
  claims pixel-identical reproduction (OQ-6).
- **Rate limits are respected**, not retried around: 1 msg/s per chat, 20/min per group, 30/s globally,
  `retry_after` honoured on 429.

## Repository layout

```
src/
  main.ts        boot: config → db → bot → worker → tick
  config.ts      env + limits
  db/            schema.sql, open/migrate, one repo per table
  bot/           long polling, FSM, callback router, screens, keyboards, texts
  pipeline/      one file per stage (s1 resolve, s2 feed)
  platform/      link detection, host allowlist, SSRF guard, feed adapters
  obs/           JSON-line logs with token/cookie redaction
test/            unit + integration on fixtures, fake Bot API (never live social URLs)
cobalt-engine/   locked media engine, imported as a library
formatbot1/      reference for the Readability → Telegra.ph path
docs/            architecture, implementation plan, ADRs
UI-Refference/   normative screen screenshots
```

## Implementation notes

- **TypeScript is run directly by Node** (type stripping); `tsc` is only a type checker and the `dist/` build.
- **SQLite uses the built-in `node:sqlite`** synchronous driver, which is the "better-sqlite3-class"
  dependency named in ADR-001 without a native build step. That is why Node 24+ is required.
- Tests use the Telegram API shape through a fake local server (`test/integration`), so no token or network is needed.
- **`sendRichMessage` (Bot API 10.3) stays unused** (OQ-16). Revisit only when clients confirm coverage across
  Desktop, Android, iOS and Web; classic media + caption is the MVP contract (ADR-008).
- **Failures are quiet for readers.** A scheduled fetch failure updates `sources` health and the `events`
  trail, and the operator gets at most one DM per source per 24 h. Users only see the error screens when they
  tapped something.

## Legal

FeedBerry prefers official feeds, stores no user credentials, and never resells or shares content. Some
platforms (notably X) forbid automated scraping without written permission; per-platform risk is documented in
ARCHITECTURE §10. Read the current terms of a platform before enabling it. This is a risk statement, not legal advice.

## License

Not chosen yet (intentionally deferred).
