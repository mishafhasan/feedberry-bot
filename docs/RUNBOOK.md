# FeedBerry runbook

ARCHITECTURE §13.3, made concrete. Primary host: Oracle Cloud Always Free A1 (2 OCPU / 12 GB / 200 GB,
ADR-017). Fallback: any home mini-PC or Raspberry Pi 5 with ≥ 2 GB.

## 1. First start

```bash
git clone <this repo> && cd feedberry-bot
cp .env.example .env
#   BOT_TOKEN=...          from @BotFather
#   ADMIN_CHAT_ID=...      your numeric Telegram id
#   RSSHUB_BASE=http://rsshub:1200
docker compose up -d
docker compose logs -f bot     # wait for {"code":"polling_started"}
```

Then, from the admin account:

1. DM the bot `/status` — it answers only the `ADMIN_CHAT_ID`.
2. Add one source of each kind you actually need; the per-platform reality is ARCHITECTURE §10.
3. Confirm a post arrives in the chosen chat, then check `/status` again for `1 fetches ok`.

## 2. Day-to-day

| Task | Command |
|---|---|
| Logs | `docker compose logs -f bot` (JSON lines, tokens/cookies redacted) |
| Health | `/status` in Telegram; `docker compose ps` for container state |
| Restart | `docker compose restart bot` |
| Update | `git pull && docker compose build bot && docker compose up -d` |
| RSSHub credentials (only if you ever add instance tokens) | edit `.env`, `docker compose up -d rsshub` — the bot needs no restart |

Idle cost is one long-poll request per 25 s plus a 30 s tick; nothing else runs while no source is due.

## 3. Backup

Nightly, off the box (cron on the host):

```bash
mkdir -p backups
sqlite3 data/bot.db ".backup 'backups/bot-$(date +%F).db'"
rclone copy backups/bot-$(date +%F).db remote:feedberry-backups/
find backups -name 'bot-*.db' -mtime +14 -delete
```

`sqlite3 .backup` is safe while the bot runs (it copies a consistent snapshot).

## 4. Restore drill (run it once, on purpose)

```bash
docker compose stop bot
cp backups/bot-YYYY-MM-DD.db data/bot.db
docker compose start bot
# now: /status must report the same source and chat counts as before the restore
```

A restore is a file copy; there is no migration step to forget. `PRAGMA user_version` in the file
records the schema version, and the bot upgrades v1 → v2 on boot if it ever finds an old backup.

The same drill runs in CI without Docker: `test/integration/m9.test.ts` takes a `VACUUM INTO`
snapshot of a live database, copies it back and asserts the schema version and the row counts.

## 5. Oracle caveats (primary host)

- **Capacity errors at create time are normal** for the free A1 shape. Retry in another availability
  domain or at a quieter hour; nothing in this stack depends on it.
- **Idle instances may be reclaimed** (< 20 % CPU, < 20 % network, < 20 % memory over 7 days) — this
  bot is exactly that profile. Mitigation is the nightly off-box backup plus a rebuild from compose in
  ~10 minutes.
- **Datacenter IPs are throttled sooner** by the platforms in §10. Expect more `E_RATE_LIMIT` and
  `E_COOKIE_REQUIRED` events than a home connection would produce.
- A home Pi is the documented fallback: same compose file, same `.env`, copy `data/bot.db`.

## 6. Security posture (verify after every upgrade)

- No credentials are stored: there is no `secrets` table and no `auth_ref` column (ADR-017). Login-only
  sources are refused at add time with `E_COOKIE_REQUIRED`.
- `grep -r "secrets\|auth_ref" src/` must return nothing.
- The bot token never reaches the DB or the logs; `src/obs/log.ts` redacts `bot<id>:<token>`, `Cookie:`
  headers and `access_key=`.
- Quotas: `MAX_SOURCES_PER_USER` (250), `MAX_CHATS_PER_USER` (20), `MAX_DOWNLOADS_PER_DAY` (300).
- A `403` at delivery demotes the chat (`chats.can_post = 0`) instead of retrying forever.
- Retention: posts `MAX_SOURCE_AGE_DAYS` (30), events 30 days, run by the daily `cleanup` job.
- Instant View: set `TELEGRAPH_TOKEN` to pin one Telegra.ph account. Left empty, the bot creates an
  account once and writes `telegraph-token.txt` next to `bot.db`. That token is the bot's own
  publishing credential, not a user login; delete the file to rotate it.

## 7. Platform smoke (operator only)

The agent never runs these; the operator does, once per release, with real links:

| Check | Expected |
|---|---|
| Snapchat single link | Download Mode returns the media (`E_NO_FEED` for a profile) |
| Pinterest `/ideas/…` | `E_PROFILE_ONLY` at add time |
| Instagram profile on a datacenter IP | either S4, `E_COOKIE_REQUIRED` (login wall) or `E_FEED_DOWN` (the route took over 60 s or RSSHub answered 5xx); `check_failed`/`job_retry` log the cause |
| YouTube 4-minute video | thumbnail + link, no upload |
| YouTube link in Download Mode (`watch?v=`, `youtu.be`, `/shorts/`) | the media uploads; never "That link isn't a supported source" — that answer means the post adapter was given a video |
| YouTube channel add | S18 asks Videos / Shorts / Posts before any fetch; the S4 preview shows only the picked kinds, and the card in My Sources prints `receiving: …` |
| YouTube channel with Posts picked | one extra page GET per check; a delivered community post arrives with its words and photos, and its own `/post/…` link |
| YouTube channel whose uploads feed is 404, Posts picked only | the add still succeeds from the Posts tab alone; nothing about the uploads feed is requested |
| YouTube `@handle` add while `feeds/videos.xml` 404s | the add still succeeds through the RSSHub route; `youtube_feed_fallback` in the log names the refused native feed, and `sources.feed_url` stays NULL so the next check retries native |
| YouTube community post `/post/…` | the post's words and album, caption headed by the channel title, plus an `➕ @handle` button offering the channel feed |
| YouTube post that was deleted | `E_NO_FEED`, not `E_NO_MEDIA` — there is no cobalt fallback for a post |
| Threads post link | the whole thread (root + sub-posts) in one message; a shell page falls back to cobalt |
| One Wired/TechCrunch link | the `👇🏼👇🏼👇🏼` row is a `telegra.ph` link, and Instant View opens under the post |

## 8. Diagnosing `E_FEED_DOWN` on an Instagram add

Every Instagram add runs through RSSHub (`/instagram/user/<name>`), so `E_FEED_DOWN` is a timeout or
RSSHub's 5xx — never a cobalt failure: a `/reel/` link only offers "Add source" after cobalt named the
poster, so cobalt already reached Instagram when the error appears.

1. **Read the cause.** `docker compose logs bot | grep -E 'check_failed|job_retry' | tail`
   `aborted due to timeout` → step 2. `feed replied 5xx` → step 3. `fetch failed`/`ENOTFOUND` → step 4.
2. **Time the route from the bot.**
   `docker compose exec bot node -e "const t=Date.now();fetch('http://rsshub:1200/instagram/user/evolving.ai').then(async r=>console.log(r.status,Date.now()-t,'ms',(await r.text()).length)).catch(e=>console.log('ERR',e.message,Date.now()-t,'ms'))"`
   A 200 under 60 s means the route is fine and the wait was the bot's cap.
3. **5xx is the route, not the bot.** `docker compose logs rsshub | tail -40`. A guest scrape that hits
   `/accounts/login/` needs `INSTAGRAM_COOKIE` in `.env` (`sessionid=…; ds_user_id=…`), then
   `docker compose up -d rsshub`. The bot never receives that value; compose clears it there.
4. **DNS and egress.** `docker compose exec bot getent hosts rsshub` must resolve; the rsshub
   container's egress IP is what Instagram throttles, and RSSHub's healthcheck only proves `/` answers.
5. **Clear the cache before retrying.** RSSHub holds a route for `CACHE_EXPIRE` (300 s), so
   `docker compose restart rsshub` is what makes the next attempt a cold one.

## 9. Two operator-only escape hatches

- **`t.me/iv?url=…&rhash=…`** works only for domains you own and have an approved Instant View
template for (OQ-13). The bot never uses it: every article becomes a Telegra.ph page instead.
- **Tier 3 anti-bot** (RSSHub's `chromium-bundled` image) is a per-host choice, not a code path.
  Swap the image in `docker-compose.yml` if a SPA-only route you need stops working; expect
  ~300–600 MB of RSS (ADR-011). The default image deliberately ships without Chromium.
