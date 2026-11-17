# FeedBerry Bot

**Fresh posts from the accounts you follow, re-published into Telegram as if the platform had posted them.**

FeedBerry watches blogs, news sites and social profiles, and for every new post sends one Telegram message:
the post's own words, original-quality media, full articles opened as Instant View — no ads, no watermarks,
no link dump. Everything that thinks lives in one process with one SQLite file, fed by long polling: no webhook,
no inbound port. The only other container is RSSHub, the feed sidecar.

- **Idle costs nothing.** A 30 s tick runs two cheap queries; work starts only from a due source, a user
  tap, or a retry.
- **No user credentials are stored.** Login-gated sources are refused instead of half-working.
- **Deterministic and testable.** 478 tests (unit + integration) run offline against fixtures and a fake
  Bot API.

Screens: [UI-Refference/](UI-Refference/)

**Status:** milestones M1–M12 shipped, including Download Mode, the schedule screen, keyword filters, the
rich-post layout and the daily AI digest. Production deploy and the restore drill are operator steps.

---

## What it does

| Journey | What the user gets |
|---|---|
| **Subscribe to a source** | Paste a profile or site link; the bot checks it, shows its latest posts, and asks where to deliver. |
| **Download Mode** | Paste a single post link and get that post's media and text here, once, without subscribing. |
| **My Sources** | One screen listing every subscription: enable/disable, check now, change cadence, filter by platform, delete. |
| **Keyword filters** | Per-source and default keyword lists; a post only reaches a chat if it mentions one of them. |
| **Content kinds** | A YouTube channel can send Videos, Shorts, Community posts, or any mix of them. |
| **Schedules** | Default 08:00 and 20:00 in the owner's timezone, or a per-source interval from 15 min to 24 h. |
| **Daily AI digest** | One rich message a day at the hour the owner picks: every RSS/blog story of the last 24 h summarized, with pictures, key points, Telegraph links and a Gemini-voiced audio overview (English or Tamil). |
| **Languages** | English, Русский, Español, हिन्दी, தமிழ், Bahasa Indonesia. |
| **Private by default** | A new user is `pending` until the operator approves them in `/admin_panel`. |

---

## Architecture

One host, two containers. Everything that thinks is in the bot process; RSSHub is a sidecar.

```mermaid
flowchart LR
  U[Telegram user] -->|links, taps| B[FeedBerry bot<br/>Node 24, one process]
  B -->|sendMessage / sendRichMessage| TG[Telegram Bot API]
  B -->|RSS / Atom| RH[RSSHub container]
  RH -->|HTTP| P[Social platforms & blogs]
  B -->|resolve + download| CE[cobalt-engine<br/>in-process library]
  CE -->|HTTP| P
  B -->|createPage| TP[Telegra.ph]
  B -->|summaries, script, speech| GM[Gemini API]
  B -.->|public pages only: Threads, YouTube posts, sites| P
  B --> DB[(SQLite WAL<br/>data/bot.db)]
  B --> FS[(tmpfs media dir<br/>purged per job)]
```

| Component | Responsibility | Where |
|---|---|---|
| **Bot process** | grammY long polling, FSM, callback router, screens, access gate, admin panel | `src/bot/` |
| **Scheduler** | Every 30 s: which subscription is due, which job is runnable | `src/scheduler/` |
| **Queue + worker** | SQLite `jobs` table, single-statement claim, backoff ladders, concurrency `WORKER_CONCURRENCY` | `src/jobs/` |
| **Pipeline** | One file per stage; `run.ts` orchestrates stages 2–9 | `src/pipeline/` |
| **Platform layer** | Link detection, host allowlist, SSRF guard, feed adapters | `src/platform/` |
| **Renderer** | Payload → `MessagePlan` (classic rows or one rich post) | `src/render/` |
| **Sender** | The only caller of the Bot API for delivery, with the shared rate limiter | `src/telegram/` |
| **Media** | cobalt wrapper, ffprobe duration probe, thumbnail frames | `src/media/` |
| **Articles** | Readability → sanitize → Telegra.ph page (Instant View); the page URL is cached on the post | `src/article/` |
| **Digest** | Window math, per-post summaries, Telegraph-link cache, script, TTS → MP3, pure split renderer | `src/digest/` |
| **Observability** | JSON-line logs with secret redaction, alerts, `/status` | `src/obs/` |
| **RSSHub** | The locked feed engine for routes without a native feed | `docker-compose.yml` |

Why one process and not three services: the FSM, the scheduler and the worker share the same SQLite file and
the same in-memory rate limiter, so splitting them buys nothing at this scale and only costs IPC.

### The pipeline

```mermaid
flowchart LR
  S1["1 resolve<br/>(platform)"] --> S2["2 fetch feed<br/>(RSSHub/native)"]
  S2 --> S3["3 classify<br/>(cobalt)"]
  S3 --> S4["4 dedupe<br/>(posts)"]
  S4 --> S5["5 media<br/>(cobalt)"]
  S5 --> S6["6 render<br/>(plan)"]
  S6 --> S7["7 deliver<br/>(rate lim.)"]
  S7 --> S8["8 record<br/>(SQLite)"]
  S8 --> S9["9 cleanup"]
```

1. **resolve** — link → `SourceRef{platform, canonical_url, feed_url, strategy}` or a coded error. Pure, no network.
2. **fetch feed** — native RSS/Atom/RDF with discovery and sitemap fallback, an RSSHub route, the Bluesky
   AppView, or a post's own permalink page.
3. **classify** — `cobalt.resolve()` metadata only (~1 s, no bytes) to pick `album / photo / video / audio / article / link`.
4. **dedupe** — `posts(source_id, guid)` unique; `guid` is the feed's id or `sha256(link)`.
5. **prepare media** — size gate, duration probe, poster fetch, then the download inside one job (CDN URLs are
   IP-bound and expire in minutes).
6. **render** — a `MessagePlan`: classic text/album/article rows, or one rich post (see below).
7. **deliver** — `TelegramSender`, serialized per chat, rate limited.
8. **record** — `deliveries`, `posts`, source health, `events`.
9. **cleanup** — the temp dir is purged on every path, including failures.

A scheduled check is stages 2–9 for every subscriber. A pasted link (Download Mode) is stages 3–7 into the
current chat — the same code, the same decisions; a parity test compares both doors' output byte for byte.

### Scheduling, queue and retries

- **Slots.** `subscriptions.next_slot_at` is 08:00/20:00 in the subscription owner's timezone, or
  `now + interval_minutes` for a per-source override. One fetch per source serves every active subscriber;
  the tick advances the slot **before** the job runs, so a crash cannot produce a hot loop.
- **Queue.** `fetch_source | deliver_post | manual_check | cleanup | digest`. Priority: manual 100, scheduled 50,
  backfill 40, retry 10. A claim is one `UPDATE … RETURNING` statement, so two workers can never take the
  same job; a `running` row older than 10 min is reset to `queued`.
- **Retries.** Network/5xx: 1 m, 5 m, 25 m, 2 h, 6 h (5 attempts). Platform rate limit: 30 m, 2 h, 8 h (3).
  Login wall: no retry, the source is marked and the owner told once. A failed delivery retries without
  re-downloading media. After the last attempt the owner gets one message per source per 24 h.

### Storage

SQLite in WAL mode, `busy_timeout=5000`, one writer, schema version in `PRAGMA user_version` with in-place
migrations (currently **v7**). Eleven tables: `users`, `chats`, `sources`, `subscriptions`, `posts`,
`deliveries`, `jobs`, `events`, and the digest's `digests`, `digest_sources`, `post_summaries`. Posts are
retained `MAX_SOURCE_AGE_DAYS` days, events 30 days, both pruned by the daily `cleanup` job. `posts`
carries `telegraph_url`, the Instant View page a post got — written once, reused by delivery and the
digest, and pruned with the row. There is no credential table and no credential column — that is a design
decision, not an omission.

---

## User journeys and screens

The FSM (in-memory, keyed by Telegram user id) lives in [src/bot/session.ts](src/bot/session.ts). A restart
forgets where a user was, which is safe because every screen can be re-rendered from the database. States:

```
idle · awaiting_source_link · checking · preview · add_mode · done · error · confirming_delete
choosing · choosing_types · awaiting_keywords · awaiting_admin_* · confirming_admin_*
```

Screens S1–S11 map 1:1 to the normative screenshots in [UI-Refference/](UI-Refference/); S16 (schedule),
S18 (content kinds) and the digest screens (status, sources, language, time) were added afterwards.

### Add a source

1. `➕ Add Source`, `/addsource`, or simply paste a link → state `awaiting_source_link`. One link per message.
2. `⚪ Checking source:` — stage 1 detects the platform, stage 2 fetches the feed. A category page resolves
   to its own section feed; a page with no feed is offered as an article source.
3. **Preview** — the source's last 5 items, plus the destination list: the personal chat first, then every
   chat or channel where the bot's posting rights were verified. A forum topic is its own row.
4. **How to add** — `🚀 Add and send latest posts` (sends `BACKFILL_COUNT` newest, oldest → newest),
   `➕ Add without sending` (records everything as seen), or `🔑 Keywords` to filter before saving.
   A YouTube channel asks for its content kinds first.
5. **Confirmation.** Everything already in the feed is recorded as seen, so only genuinely new posts arrive.

### Download Mode

Paste a post link and the bot answers with one prompt: `⬇️ Download`, and `➕ Add source` when the account
behind the link is known. The download reuses stages 3–7, is capped by `MAX_DOWNLOADS_PER_DAY`, and
ends with `⬇️ Download more` and `➕ @handle` when the account is known. A YouTube community post and a
Threads thread are read from their own page, so the whole text, every photo of an album and the author
survive; any other platform's post goes through cobalt. Inside Download Mode a profile link is answered with
`Send a post link, not a profile.`

### My Sources

One message, edited in place, 5 cards per page, platform filter chips. Each card carries the source title,
`id: #<id>`, its last check, its health, and its own action row: **On/Off**, **Check now** (a `manual_check`
job at priority 100), **content kinds** (YouTube), and **Delete** behind a confirm. Toasts report the result
without touching the list.

### Keyword filters, schedule, language

- `/filter` (or `📇 Filter`): a default list plus a per-source list. Matching runs on the parsed payload
  **before** any media download, so a skipped post costs nothing.
- `/schedule` (or `⏰ Schedule`): pick a source (or all sources) and choose default 08:00/20:00, or every
  15 min / 30 min / 1 h / 3 h / 6 h / 12 h / 24 h. A source keeps one schedule for all its subscribers.
- `/language`: six interface languages; a partial translation falls back to English, never to a blank screen.

### Access gate and admin panel

The bot is private. A stranger's first update is denied once, logged as `access_requested`, and surfaced in
`/admin_panel`; the operator approves or blocks, and can message one user or all of them. `ADMIN_CHAT_ID`
bypasses the table and is the only id that `/status` answers.

---

## Supported platforms

Legend — the bot prefers the cheapest route that works: a native feed, then RSSHub, then the platform's own
post page, then cobalt for the media.

| Platform | Profile source | Single post |
|---|---|---|
| Websites, blogs, news | native RSS/Atom/RDF, `<link rel=alternate>` discovery, then `/sitemap.xml` as a page list | article → Telegra.ph |
| Substack | always `<origin>/feed` — no fetch needed | same |
| YouTube | keyless `feeds/videos.xml` per channel; Posts tab read as a second feed | `/post/…` page adapter, or cobalt for video/Shorts |
| Tumblr | the blog's own `/rss` | cobalt |
| Bluesky | public AppView `getAuthorFeed`, no key | cobalt |
| TikTok | RSSHub `/tiktok/user/…` | cobalt (short links, photo carousels) |
| Threads | RSSHub `/threads/…` | the permalink page renders the whole thread |
| Instagram | RSSHub `/instagram/user/…` | `/p/`, `/reel/`, `/tv/` via cobalt |
| Facebook | RSSHub `/facebook/page/…` (needs a cookie on a datacenter IP) | videos, reels, photos, `fb.watch` |
| Pinterest | RSSHub user route; `/ideas/` and `/search/` are rejected as browse pages | pins, `pin.it` |
| X / Twitter | only with an operator-supplied `TWITTER_AUTH_TOKEN` | posts via cobalt |
| Snapchat | not subscribable (no feed exists) | Download Mode only |
| Telegram channels | beta, opt-in (`TELEGRAM_BETA`), public `t.me/s` page | cobalt |
| Reddit | removed: RSS ends 2026-11-13, public API by March 2027 | — |

---

## Message layout and delivery limits

Two layouts, chosen by platform:

- **Social posts (non-RSS)** ship as **one rich message** (Bot API 10.x `sendRichMessage`): an `<h5>` source
  line, `⏱️` bold `DD/MM HH:MM` in the reader's timezone, an in-message `<tg-slideshow>` of up to 50 media,
  then the whole body inside a `<blockquote expandable>` framed by two rules — one native tap expands it, with
  no stored payload and no callback. A clip that cannot upload is one `🎬 Video n` link.
- **RSS/blog posts** use the classic rows: text split on word boundaries at 4096 chars (captions at 1024 with
  `(i/n)`), albums of 2–10 via `sendMediaGroup` with sequential messages past 10, mixed kinds sent one by one,
  and articles as a Telegra.ph page opened in Instant View.
- **The daily digest** has its own rich layout with an audio player, numbered stories and an overflow list.

Hard limits, all enforced:

| Limit | Behavior |
|---|---|
| 50 MB upload | above it: poster/thumbnail + caption + link. Nothing is transcoded |
| 3 minutes of video | same thumbnail route, whatever the size |
| Over-sized clip inside an album | an ffmpeg frame takes its slot, the caption gains one labelled `🎬` link; the clip is never uploaded and never silently dropped |
| 100 MB per post | `MAX_DOWNLOAD_MB` pre-check before any transfer |
| 30 s / 300 s budgets | extraction (resolve, probes, posters) vs. transfer — one budget per kind of operation, shared by both doors |
| 1 msg/s per chat, 20/min per group, 30/s global | token buckets in a shared limiter; `429` honors `retry_after` + 1 s, and a `retry_after` over 300 s requeues the job |
| 4096 / 1024 characters | split on a word boundary, never inside an HTML tag; a client that rejects the entities gets plain text instead |

---

## Daily AI digest

One message a day, at the hour the owner picks, covering every story the selected RSS/blog sources delivered
in the last 24 h: summarized, illustrated, linked and read aloud. It is **extra** — per-post delivery keeps
working exactly as before; the digest only reads `posts` and never marks a delivery.

### Turning it on

1. Set `GEMINI_API_KEY` (one key for text and speech). Without it the feature is off: the menu button is
   hidden and the tick never queues a digest.
2. Open `🎧 Daily digest` from the main menu — it is a menu button, not a slash command — and pick the
   destination chat: the personal chat, a group, a channel, or a forum topic.
3. Choose **📰 Sources** (RSS and blog sources only), **🌐 Language** (English or தமிழ்), **🕗 Time** (hour
   `0–23`, wall clock in the owner's timezone, DST-safe).
4. **Enable.** Disabling clears the scheduled slot; enabling with no source is refused.

### The pipeline

1. **Window.** After one last check per source, the run pins `window_end` at the run instant and selects
   `first_seen_at ∈ [previous end, window_end)`, clamped to 24 h. `last_window_end` commits only after the
   last part is sent, so windows tile with no overlap and no gap; a retry reuses the same pin.
2. **Page.** Each post is read from its stored Instant View link (`posts.telegraph_url`). No page yet? The
   digest publishes one, stores it, and reads that — a post is never published twice. Only when no page can
   be produced does the original URL stand in, for both text and link.
3. **Summary.** One Gemini JSON call per post (cached per post + language): translated headline, a
   2–3-sentence description and up to 6 key points. Model output is untrusted — empty strings dropped,
   headline/description/point clamped to 120/600/240 characters, everything escaped, and only our own
   Telegraph link becomes an anchor.
4. **Pictures.** The page's own figures lead, the feed's photos fill the remaining slots, at most 3 per
   story. They are downloaded one at a time into the post's own folder, with the post as `referer` and a
   browser user-agent so hotlink-protected CDNs serve them; one failed picture costs that picture only.
5. **Script and voice.** One text call writes the spoken script from the summaries; TTS renders it in
   ≤2 500-character chunks as raw 24 kHz PCM, and ffmpeg writes one 64 kbps MP3 (ID3 title) at **1.1×
   speech rate** via `atempo`, so the pitch holds. A failed script or voice costs the player, never the
   digest.
6. **Layout.** One rich message per part:
   `<h2>🫐 Daily Digest</h2>` · `📅 date · 🗞 N posts · M sources` · the audio player · then numbered
   stories: `<h3>1. headline</h3>`, the original title in italics under a Tamil headline, the `📰 Source |
   RSS` line with its `⏱️` time, a photo or `<tg-slideshow>` of up to 3, the description, up to 6 key
   points, and `📖 Read full article` pointing at the Telegraph page. Stories past `DIGEST_MAX_POSTS`
   become numbered links under **Also today**, and the last part closes with a
   `<b><i>By FeedBerry Bot</i></b>` footer. Parts split greedily under 49 media (the audio takes the 50th
   slot in Part 1), 30 000 characters of HTML and 480 blocks; numbering continues across parts.

### Languages

English and Tamil. The **content** — headline, description, key points, overflow headlines and the audio —
is written in the chosen language, with names, brands and technical terms kept in English and the original
headline shown in italics under a Tamil one. The **structural labels** (digest title, date line, audio line,
key points, read-full link, “Also today”, part label, footer) stay English in every language, and the date
is formatted `en-GB`. Screens follow the interface language, which is separate from the digest language.

### The Instant View cache (schema v7)

`posts.telegraph_url` stores the Telegra.ph page a post got, whoever wrote it: delivery (an article page or
a long-caption page) or the digest itself. The column is written **once** and kept for the life of the post,
so a retry, the other digest language, or another user following the same source reuses the same page
instead of asking Telegra.ph again. It is pruned with the post (`MAX_SOURCE_AGE_DAYS`). A dead page falls
back to the original URL for text and pictures; a failed publish leaves the item on its post URL.

### Failure behaviour

| Where | What happens |
|---|---|
| Window | A run that dies leaves its pin; a retry selects the same posts. A pin older than 24 h is dropped. |
| Gemini | `429`/`4xx`/`5xx` or the 120 s per-call cap moves to the next model in the configured ladder, for summaries, the script and the voice. Aborting the job's 8-minute budget is fatal and the run retries. |
| Summaries | One retry per post, then the feed's own words ship. If **every** story fell back, Gemini itself is down: nothing is sent and the job retries on the pinned window. |
| Audio | `digest_audio_failed` is logged; the digest ships without a player. |
| Telegraph | `FLOOD_WAIT_n` is retried after the wait the API names (up to three waits); then the item keeps its post URL. |
| Delivery | A crash between parts resends the whole digest on retry — no per-part ledger yet. |

Logs use the usual JSON lines: `digest_sent`, `digest_item_fallback`, `digest_audio_failed`, `digest_page`,
`gemini_model_fallback`, `telegraph_flood_wait`.

---

## Tech stack

| Layer | Choice | Note |
|---|---|---|
| Runtime | Node.js **≥ 24**, ESM | `node:sqlite` needs 24; TypeScript is type-stripped, no build step for `dev` |
| Language | TypeScript 7 (`tsc` for typecheck + `dist/`) | ~10 typed boundary objects justify it |
| Bot framework | grammY 1.46 | Long polling, `allowed_updates: message, callback_query, my_chat_member` |
| Storage | SQLite (WAL) via the built-in `node:sqlite` | No native build step; migrations on boot |
| Queue | Own `jobs` table | One writer, atomic claim, backoff in `run_after` |
| Feeds | RSSHub (sidecar), native RSS/Atom/RDF, Bluesky AppView | No public RSSHub instance |
| Media | `cobalt-engine` vendored and imported as a library | In-process, no media service |
| Video | ffmpeg / ffprobe | In the image; muxing and the 1 s thumbnail frame |
| Articles | `@mozilla/readability`, `jsdom`, `sanitize-html` → Telegra.ph | The ported formatbot1 path |
| AI | Gemini REST through `fetch` and `AbortSignal` | No SDK, no extra process; one key for summaries, script and speech |
| Logs | JSON lines to stdout, `events` table | Tokens, cookies and access keys redacted |
| Container | `node:24-alpine` + ffmpeg, `diygod/rsshub:latest` | No Chromium in either image |

## Repository layout

```
src/
  main.ts        boot: config → db → bot → worker → tick
  config.ts      env parsing; every limit lives here
  bot/           long polling, FSM, callback router, screens, keyboards, texts, i18n, access gate, admin
  pipeline/      one file per stage; run.ts orchestrates stages 2–9
  platform/      link detection, allowlist, SSRF guard, feed adapters (native, section, Threads, YouTube post)
  render/        payload → MessagePlan (classic rows, rich text, albums, caption splitting, video rules)
  telegram/      the only Bot API caller: sender, shared rate limiter, "Show more"
  media/         cobalt wrapper, video probe, thumbnail frames
  article/       Readability → sanitize → Telegra.ph
  digest/        window math, summaries, script, TTS → MP3, the pure split renderer
  jobs/          SQLite queue (claim, backoff) + worker pool
  scheduler/     per-subscription slots + the 30 s tick
  db/            schema.sql, open/migrate, one repo per table
  obs/           JSON-line logs with redaction, alerts, /status
test/
  unit/          pure functions, fixtures, no network
  integration/   the real handlers over a fake Bot API (test/fake-api.ts)
cobalt-engine/   the locked media engine, imported as a library
UI-Refference/   normative screen screenshots
data/            the SQLite file at runtime (git-ignored)
```

---

## Run it locally

Requires **Node.js 24+**, a bot token from [@BotFather](https://t.me/BotFather), and an RSSHub you control.

```bash
npm install
cp .env.example .env         # BOT_TOKEN, ADMIN_CHAT_ID, RSSHUB_BASE
npm run dev                  # runs src/ directly, no build step
npm test                     # offline: fixtures + a fake Bot API
```

`npm run build && npm start` runs the compiled `dist/`. `npm run typecheck` is the type gate.

Notes for a local run:

- `RSSHUB_BASE` must point at an RSSHub the bot can reach. The sidecar in `docker-compose.yml` publishes no
  port and is reached as `http://rsshub:1200` from inside the compose network; for a host run, start your own
  RSSHub (or add a `ports` mapping) and set `RSSHUB_BASE=http://localhost:1200`.
- `ADMIN_CHAT_ID` is your numeric Telegram id — the admin bypasses the access gate. Anyone else starts as
  `pending` and must be approved in `/admin_panel`.
- ffmpeg/ffprobe on the host improve video handling (duration probe, thumbnails); without it the bot falls
  back to unknown-duration rules. The digest's audio overview also needs ffmpeg (the Docker image ships it).
- `GEMINI_API_KEY` turns the daily digest on — one key for summaries, the spoken script and the voice.
  Without it the `🎧 Daily digest` button is hidden and no digest job is ever queued.
- One bot token can be polled by one process at a time. Running a local copy against the live token while the
  hosted container runs gives both sides `409` conflicts.

## Deploy with Docker

```bash
cp .env.example .env         # fill the three required values
docker compose up -d         # bot + rsshub
docker compose logs -f bot   # wait for {"code":"polling_started"}
```

- `bot` is built from this repo (`node:24-alpine` + ffmpeg), restarts `unless-stopped`, keeps SQLite in
  `./data:/data`, and keeps downloaded media in a 512 MB tmpfs that never touches disk.
- `rsshub` runs without Chromium, caches in `./rsshub-cache`, and gets the instance-wide credentials
  (`TWITTER_AUTH_TOKEN`, `INSTAGRAM_COOKIE`, `FACEBOOK_COOKIE`) that the bot itself must never see —
  compose explicitly clears the two cookies from the bot's environment.
- Update with `git pull && docker compose build bot && docker compose up -d`; a rebuild is only needed when
  `package.json`, `Dockerfile`, `cobalt-engine` or `schema.sql` changed.

---

## Configuration

Everything is env, parsed once at boot ([src/config.ts](src/config.ts)); a malformed value stops the bot with
a readable message instead of guessing.

### Required

| Variable | Meaning |
|---|---|
| `BOT_TOKEN` | Bot token. Never logged, never stored. |
| `ADMIN_CHAT_ID` | Operator's numeric Telegram id: alerts, `/status`, the admin panel. |
| `RSSHUB_BASE` | Your RSSHub, e.g. `http://rsshub:1200`. Public instances are not used. |

### Paths and optional services

| Variable | Default | Meaning |
|---|---|---|
| `DB_PATH` | `data/bot.db` | SQLite file; in Docker it is `/data/bot.db`. |
| `TELEGRAM_API_ROOT` | — | A self-hosted Bot API server, or the fake one in tests. |
| `TELEGRAPH_TOKEN` | — | Pin one Telegra.ph account. Empty: the bot creates one once and stores the token next to the database. |

### Limits and quotas

| Variable | Default | Meaning |
|---|---|---|
| `MAX_SOURCES_PER_USER` | 250 | Per user; rendered as `Sources: N / 250`. |
| `MAX_CHATS_PER_USER` | 20 | Validated on add. |
| `MAX_DOWNLOAD_MB` | 100 | Pre-check before any media download. |
| `BACKFILL_COUNT` | 5 | How many posts "Add and send latest posts" sends. |
| `MAX_SOURCE_AGE_DAYS` | 30 | Retention for `posts`. |
| `WORKER_CONCURRENCY` | 2 | Keep at or below the CPU core count. |
| `MAX_DOWNLOADS_PER_DAY` | 300 | Download Mode quota, per user per day. |
| `CALLBACK_INTERVAL_MS` | 2000 | Per-user tap throttle; `0` disables it. |
| `ADD_INTERVAL_MS` | 10000 | Per-user add throttle; `0` disables it. |
| `CHECKS_PER_HOUR` | 30 | Manual "Check now" ceiling per user; `0` disables it. |

### Feature flags and instance credentials

| Variable | Default | Meaning |
|---|---|---|
| `TRIAL_ENABLED` | false | Shows the cosmetic trial line on the main menu. |
| `TELEGRAM_BETA` | false | Telegram channel sources through the public `t.me/s` page. |
| `TWITTER_AUTH_TOKEN` | — | The `auth_token` of a logged-in X account. Present: X profiles become subscribable and gated X media downloads work. Absent: only public X posts. Also passed to the RSSHub sidecar. |
| `INSTAGRAM_COOKIE` | — | `sessionid=…; ds_user_id=…`. **RSSHub container only** — compose clears it from the bot. |
| `FACEBOOK_COOKIE` | — | The whole `Cookie` header of a logged-in Facebook session. **RSSHub container only.** |

### Daily digest

| Variable | Default | Meaning |
|---|---|---|
| `GEMINI_API_KEY` | — | One key for summaries, the spoken script and speech. Empty: the feature is off (button hidden, no `digest` jobs). |
| `GEMINI_TEXT_MODEL` | `gemini-3.8-flash` | Summaries and the script. |
| `GEMINI_TTS_MODEL` | `gemini-3.8-flash-tts` | The audio overview; the voice is fixed (`Kore`). |
| `GEMINI_TEXT_FALLBACKS` | `gemini-3.6-flash,gemini-4-hydrogen,gemini-3-flash-preview,gemini-3.1-pro-preview,gemini-3.5-flash-lite` | Tried in order after the primary on `429`/`4xx`/`5xx` or a per-call timeout. |
| `GEMINI_TTS_FALLBACKS` | `gemini-3.8-flash-lite-tts,gemini-3.1-flash-tts-preview,gemini-2.5-flash-preview-tts` | The same ladder for the voice; the two legacy previews speak through `generateContent`. |
| `DIGEST_MAX_POSTS` | `20` | Full summaries per run; posts past it become numbered “Also today” links instead. |

Model quotas are per model (a free-tier key allows ~5 requests a minute and, for `gemini-3.8-flash`, ~20 a
day), which is why the ladders exist: a spent rung simply hands the call to the next model. A paid key
removes the limits; no code changes.

---

## Operating it

| Task | How |
|---|---|
| Health | `/status` in the admin DM: queued/running/failed jobs, failing sources, 24 h fetch and send counters |
| Logs | `docker compose logs -f bot` — one JSON line per job with job, source, stage, ms, code |
| Backup | `sqlite3 data/bot.db ".backup 'backups/bot-$(date +%F).db'"`, then copy it off the box |
| Restore | stop the bot, replace `data/bot.db`, start — a file copy, with no migration step to forget |
| Users | `/admin_panel`: approve, block, inspect a user's sources, message one user or all of them |
| Alerts | 3 consecutive failures on one source, more than 100 queued jobs, or no successful fetch in 26 h |

Scheduled failures are quiet for readers: the source's health fields and the `events` trail are updated, and
the operator gets at most one DM per source per 24 h. Users only see error screens for actions they started.

## Tests

```bash
npm run typecheck   # tsc --noEmit
npm test            # node:test, unit + integration, 478 tests, no network
npm run build       # dist/ + schema.sql
```

Integration tests drive the real handlers and the real pipeline against `test/fake-api.ts` — a local server
that speaks the Telegram API shape — with fixture feeds and a fixture media engine. No token, no network, no
live social URLs. The restore drill is covered the same way by taking a `VACUUM INTO` snapshot of a live
database and reading it back.

## Known limits

- **Fidelity.** Telegram HTML supports text formatting and links: no custom fonts, CSS, image grids or
  carousel chrome. Media order + the post's words + the author line is the maximum, and this project never
  claims a pixel-identical copy.
- **"Instant View" is a Telegra.ph rewrite.** Telegram's IV works per domain and a bot cannot register a
  template, so articles become a Telegra.ph page (which already has one) and the link is sent. On failure the
  original link goes instead. The Cocoon AI summary above such a page is Telegram's, not the bot's.
- **No credentials, ever.** A login-gated profile is refused at add time (`E_COOKIE_REQUIRED`) or fails its
  fetch; single posts still work in Download Mode. Instance-wide RSSHub cookies belong to the sidecar.
- **No transcoding, no CAPTCHA solving, no proxy pools.** Above 50 MB, or on a clipping 3-minute video, the
  post arrives as poster + caption + link.
- **A datacenter IP is throttled first** by the platforms. Expect more `E_RATE_LIMIT` and
  `E_COOKIE_REQUIRED` on a cloud host than on a home connection.
- **One host, one writer.** SQLite and a single process are the design; the queue is meant for
  hundreds of sources, not for horizontal scaling.
- **The digest is a summary, not a rewrite.** Model output is clamped and escaped; a summary that fails
  twice falls back to the feed's own words, and the message always says who wrote it.
- **Telegraph throttles bulk publishing.** Roughly forty rapid pages earn a ~9-minute IP block
  (`FLOOD_WAIT_525`), so a first digest over a large backlog can leave some “Also today” entries on their
  post URL until a later run. Pages are cached per post, so this is a first-run cost, not a recurring one.
- **The digest is a cost guard, not a feed reader.** `DIGEST_MAX_POSTS` full summaries per day; everything
  beyond it is a link.
- **Audio is optional.** Without ffmpeg, or when TTS fails, the digest ships without the player and logs why.

## Legal

FeedBerry prefers official feeds, stores no user credentials, and never resells or shares content. Some
platforms (notably X) forbid automated scraping without written permission. Read the current terms of a
platform before enabling it. This is a risk statement, not legal advice.

## License

Not chosen yet (intentionally deferred).
