# Hosting guide: laptop → free cloud server

This guide moves FeedBerry from "runs on my laptop with Docker" to "runs on a free server, 24/7".
It is written for someone who has never used a server. Every command is meant to be copied as-is.
The chosen host is **Oracle Cloud Always Free**. Section 3 shows why every other free host fails.

Nothing in this guide changes the code. The server runs the same `Dockerfile` and
`docker-compose.yml` you already use at home.

---

## 1. What the bot needs to run

| # | Requirement | Why this bot needs it | What breaks without it |
|---|---|---|---|
| 1 | A computer that stays on 24/7 | The bot uses **long polling**: it asks Telegram "any new messages?" every 25 seconds (`getUpdates`). There is no webhook and no inbound port (ADR-003). | A host that "sleeps" or stops after a while stops asking. The bot goes silent even though the process may look alive. |
| 2 | A disk that survives restarts | The database `bot.db` holds sources, chats and the job queue. `docker-compose.yml` mounts `./data` to `/data`, and the `Dockerfile` sets `DB_PATH=/data/bot.db`. | On a host with a temporary disk, every restart or redeploy wipes every source the user added. |
| 3 | **ffmpeg** inside the container | YouTube audio+video muxing, and the 1-second thumbnail frame for long videos (`Dockerfile` line 13, `src/media/thumb.ts`). | Long videos fall back to a plain link card; no thumbnail. |
| 4 | Outbound internet | `api.telegram.org` (delivery), `http://rsshub:1200` (feeds), the source sites and media CDNs (cobalt downloads). | Nothing can be fetched or delivered. |
| 5 | **2 GB RAM** minimum | Peak is about 1 GB (section 2). | A 1 GB machine swaps or kills Node/ffmpeg at the worst moment. |
| 6 | **10 GB disk** minimum | Two Docker images = 1.14 GB, build cache ≈ 1.2 GB while building, database grows with posts and a 30-day retention. | `docker build` dies with "no space left on device". |
| 7 | Docker + Docker Compose | The stack is two containers: `bot` and `rsshub` (`docker-compose.yml`). | — |
| 8 | **No** open ports, **no** domain, **no** HTTPS certificate | Long polling only. The bot dials out; nothing dials in. | If a host only allows "web services with a URL", this design does not fit it. |

Note on requirement 1: it is the reason several popular free hosts are out. They sleep when no one
sends them **inbound** traffic, and a polling bot receives none.

---

## 2. Peak resource usage

Measured on the owner's laptop on **2026-11-02** with the real containers running
(Windows, Docker Desktop, 8 CPU cores): `docker stats`, `docker system df`, and folder sizes.
Anything not measured is marked *(estimate)*.

| Resource | Idle | Peak | How I got this |
|---|---|---|---|
| CPU | 0.05–0.11 % of an 8-core machine (≈ 0.01 core) | 6.9 % of 8 cores ≈ **0.55 core**, during one download + delivery job | `docker stats` sampled every 4 s for 2 min while a Download Mode job ran. One core is enough; two leave room for ffmpeg. |
| RAM | bot **70–81 MB**, RSSHub **323 MB** (RSS here means resident memory: the RAM the process actually holds) | about **1.0 GB**: 400 MB baseline + up to 512 MB of downloaded media + ~100 MB ffmpeg *(estimate)* | `docker stats` before and after a job. Media lives in a RAM disk: `tmpfs: /tmp/feedberry-media:size=512m` in `docker-compose.yml`, so it counts as RAM. ffmpeg only copies streams (`-c copy` in `cobalt-engine/src/download.js`), so it stays small. |
| Disk | images **474 MB** (bot) + **667 MB** (RSSHub) = 1.14 GB; repo 114 MB with `node_modules`; database 0.2 MB today | build cache **1.19 GB** during `docker build` (safe to delete later) | `docker images`, `docker system df`, folder sizes on disk. |
| Bandwidth | one long-poll request per 25 s: **≈ 0.5 MB out per 50 min** | one real Download Mode job moved **4.7 MB in / 4.3 MB out** in 60 s. A 50 MB video is 50 MB out (Telegram Bot API cap) | `docker stats` NetIO deltas across 60 s while a job ran. |

**What that means for a host:** 2 CPU cores, 2 GB RAM and 10 GB disk are comfortable.
1 GB RAM is not: 400 MB baseline + 512 MB media + ffmpeg already crosses it.

**Bandwidth is the hidden trap.** A modest workload — 30 sources with 5 new posts each per day
(≈150 downloads), 5 MB per post — is about 750 MB in + 750 MB out **per day**, ≈ 45 GB per month.
Oracle gives 10 TB/month. Google Cloud's free tier gives **1 GB/month**, which that workload eats in
under two days.

---

## 3. Free platform comparison

Every row was checked on **2026-11-02** against the vendor page linked in the row.
`[uncertain]` marks a number I could not confirm on that page.

| Platform | What "free" actually gives you | Limits that matter for this bot | Verdict |
|---|---|---|---|
| **Oracle Cloud** — Always Free | 2 OCPU + 12 GB Ampere A1 VM, 200 GB block storage, **10 TB/month outbound** — Source: docs.oracle.com "Always Free Resources", checked 2026-11-02 | Idle instances may be reclaimed (CPU p95 < 20 %, network < 20 %, memory < 20 % over 7 days) *[ORACLE 2026-11-02]*; "out of host capacity" errors at create time are normal. 47 GB minimum boot volume. | **Passes.** Always on, real disk, ffmpeg in your own image, huge egress. |
| **Google Cloud** — Always Free | 1 × `e2-micro` VM (2 vCPU shared, **1 GB RAM**), 30 GB standard disk, **1 GB/month outbound** from North America — Source: cloud.google.com/products/compute, checked 2026-11-02; the three free regions (us-west1, us-central1, us-east1) are `[uncertain]` | 1 GB RAM is below the ~1 GB peak; 1 GB/month egress is the real killer (about 20 max-size videos). 0.25 shared core makes `docker build` slow. | **Fails** on bandwidth and RAM. |
| **AWS** — Free plan | $100 in credits at signup, up to $100 more, for **6 months**; the account closes at 6 months or when credits run out — Source: aws.amazon.com/free, checked 2026-11-02 | Not "forever". No 12-month EC2 allowance on new accounts. | **Fails**: expires. |
| **Azure** — free account | 750 h/month of a B1s VM **for 12 months**, $200 credit for 30 days; 65+ always-free services, but **no always-free VM** — Source: azure.microsoft.com/free + /pricing/free-services, checked 2026-11-02 | VM is free only for the first year, then billed. | **Fails**: expires. |
| **Render** — free web service | 0.1 CPU / 512 MB, 750 instance hours/month — Source: render.com/docs/free, checked 2026-11-02 | Spins down after **15 min without inbound traffic** (outbound polling does not count), ephemeral filesystem, **no persistent disk on free**, Postgres expires after 30 days, may suspend services that make lots of outbound calls. | **Fails** on all three: sleeps, no disk, 512 MB. |
| **Fly.io** | **No free tier** for new organisations; free trial = 2 h of Machine time or 7 days — Source: docs.fly.io/about/pricing, checked 2026-11-02 | Cheapest always-on machine is $2.19/month. | **Fails**: not free. |
| **Koyeb** | No free compute plan on the pricing page; only "free 5 h" of Postgres — Source: koyeb.com/pricing, checked 2026-11-02 | Legacy free organisations may still exist `[uncertain]`. | **Fails**: not free for a new account. |

Two more that are free but not servers, so they cannot host this stack: **GitHub Actions** (6-hour job
cap, no long-running process, no persistent disk — ADR-010) and **Cloudflare Workers** (no filesystem,
no ffmpeg, 10 ms CPU — ADR-010).

---

## 4. The chosen host: Oracle Cloud Always Free

**Choice: one Oracle Cloud Always Free Ampere A1 VM, Ubuntu 24.04, Docker Compose, same repo.**
This keeps ADR-017 unchanged; the comparison above re-checked it rather than re-deciding it.

Why it wins for *this* bot, requirement by requirement:

1. **Always on.** A normal VM. Nothing sleeps. Long polling keeps working with no inbound port.
2. **Persistent disk.** 200 GB of real block storage, 47 GB minimum boot volume. `./data` survives
   reboots, rebuilds and container restarts.
3. **ffmpeg.** Your `Dockerfile` installs it; you run your own image, so nothing is stripped.
4. **Network.** 10 TB/month outbound. Media uploads never hit a quota.
5. **Enough RAM.** 12 GB against a ~1 GB peak, so ffmpeg and Node never compete.

Costs and risks, stated plainly (all from the pages checked in section 3):

- **You need a bank card to sign up** for identity checks. A small temporary hold may appear; the
  Always Free resources themselves cost $0. `[uncertain]` on the exact hold amount.
- **"Out of host capacity".** Oracle's free A1 shape is popular. Retry, try another availability
  domain, or come back at a quieter hour. If you upgrade to Pay As You Go for easier capacity, stay
  inside 2 OCPU / 12 GB / 200 GB and the Always Free parts stay free (Oracle's own doc says so).
- **Idle reclamation.** Oracle may reclaim Always Free instances that stay under 20 % CPU, network
  and memory for 7 days. This bot is deliberately idle, so it is exactly that profile. Do not burn
  CPU to fake activity. Keep the nightly backup (section 5.10) and accept that a rebuild takes about
  10 minutes. `[uncertain]` whether upgrading to Pay As You Go stops reclamation.
- **Datacenter IPs are throttled sooner** by Instagram/TikTok/X than a home connection
  (`RUNBOOK.md` §5). Expect more `E_COOKIE_REQUIRED` and `E_RATE_LIMIT` events than on your laptop.

---

## 5. Setup, top to bottom

Time needed: about 45 minutes of work, plus whatever time Oracle takes to approve the account.

### 5.1 Create the Oracle account

1. Open <https://www.oracle.com/cloud/free/> and click **Start for free**.
2. Enter your country, name, email. Verify the email.
3. Choose a **home region** — the datacenter closest to you.
   **This cannot be changed later**, and Always Free resources only exist in the home region.
4. Add a card for identity verification, then wait for the "account ready" email (minutes to hours).

You are on the **Always Free** plan. Everything below uses only Always Free resources, which stay
free after any trial credit expires. Do not add paid services anywhere in this guide.

### 5.2 Create the server (VM)

A VM (virtual machine) is a computer in Oracle's datacenter that you control over SSH (a remote
terminal connection).

1. Menu → **Compute → Instances → Create instance**.
2. **Name**: `feedberry`. **Compartment**: stay in the `(root)` compartment of your home region.
3. **Image and shape** → *Edit*:
   - **Read this before you click anything else:** the console opens on `VM.Standard.E2.1.Micro`
     (1 OCPU / 1 GB) and often on an Oracle Linux image. Both are wrong for this bot — 1 GB is under
     the ~1 GB peak, and the commands in this guide are written for Ubuntu. Change both.
   - Image: **Canonical Ubuntu 24.04** (must say "Always Free-eligible").
   - Shape: **Ampere → VM.Standard.A1.Flex**.
   - OCPUs: **1**, Memory: **6 GB** — enough (measured peak is ~1 GB) and it uses half of the free
     monthly hours. **2 OCPU / 12 GB** is also free, but running it 24/7 burns 1,440 of the 1,500
     free OCPU-hours, leaving almost no room for a second instance. Resize later if the build or the
     jobs feel slow; both sizes are inside the free allowance.
   - Availability domain: any (A1 works in all three). Keep **Capacity type: On-demand**; never
     *Preemptible*, which Oracle can reclaim at any time.
4. **Boot volume**: tick *Specify a custom boot volume size* and enter **50** GB (47 is the minimum).
5. **SSH keys**: choose *Paste public keys*. On your laptop, create a key if you do not have one:

   ```bash
   ssh-keygen -t ed25519 -C "feedberry"
   ```

   Press Enter through the prompts, then paste the contents of the `.pub` file
   (Windows: `C:\Users\<you>\.ssh\id_ed25519.pub`).
6. Networking: keep the default VCN and subnet (a "public subnet" with a public IP). **Do not open
   any extra ports** — the bot needs none.
7. Click **Create**. If you see **"Out of host capacity"**, wait 15 minutes and retry, or pick the
   other availability domain.

When it is running, note the **Public IP address**.

### 5.3 Connect to it

```bash
ssh ubuntu@<PUBLIC_IP>
```

The default user on Oracle's Ubuntu image is `ubuntu`. Type `yes` at the fingerprint question.

### 5.4 Install Docker

```bash
sudo apt update && sudo apt install -y git
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
exit
```

`exit` closes the session; the group change only applies to a new one. Log back in:

```bash
ssh ubuntu@<PUBLIC_IP>
docker compose version
```

You should see a version line (v2.x). If you see "permission denied" on the next commands, the
`usermod` step did not take effect — log out and in again.

### 5.5 Get the code

```bash
git clone https://github.com/mishafhasan/feedberry-bot.git
cd feedberry-bot
```

### 5.6 Fill in `.env`

```bash
cp .env.example .env
nano .env
```

Set these two lines and leave everything else as it is:

```text
BOT_TOKEN=<from @BotFather>
ADMIN_CHAT_ID=<your numeric Telegram id>
```

- `BOT_TOKEN`: in Telegram, open **@BotFather** → `/mybots` → your bot → *API Token*. If you have no
  bot yet: `/newbot`. The token looks like `123456789:AA...`.
- `ADMIN_CHAT_ID`: your own numeric id. Send `/start` to **@userinfobot** and copy the number.

Two lines in `.env` are overridden by `docker-compose.yml` and need no editing:

- `RSSHUB_BASE=http://rsshub:1200` — that hostname is the RSSHub container inside Docker's network.
  Never change it to `localhost`, which would mean "the bot container itself".
- `DB_PATH` — Compose sets `/data/bot.db`, matching the `./data:/data` mount.

Save in nano with `Ctrl+O`, `Enter`, then `Ctrl+X`.

`TELEGRAPH_TOKEN` may stay empty: on first use the bot creates its own Telegra.ph account and writes
`data/telegraph-token.txt` next to the database.

### 5.7 Start it

```bash
mkdir -p data rsshub-cache
docker compose up -d
docker compose logs -f bot
```

The first `up` builds the bot image (a few minutes on the VM). Wait for this log line:

```json
{"code":"polling_started","bot":"..."}
```

Press `Ctrl+C` to stop watching logs (the bot keeps running). Check both containers:

```bash
docker compose ps
```

Both `bot` and `rsshub` must say `Up` / `healthy`. The first RSSHub start can take ~30 s.

### 5.8 Confirm the bot replies

1. In Telegram, open your bot and send `/start`. The main menu appears.
2. Send `/status`. It answers **only** from the `ADMIN_CHAT_ID` account.
3. Add one source you use every day, then wait for one post to arrive in your chat.

If `/start` says nothing: `docker compose logs --tail 50 bot` and read the last error.

### 5.9 Keep it running (autostart)

Nothing extra to install. Two things keep it alive:

- `restart: unless-stopped` on both services in `docker-compose.yml` — Docker restarts a crashed
  container.
- The Docker service itself starts on boot. Check it once:

  ```bash
  systemctl is-enabled docker
  ```

  It must print `enabled`. If it prints `disabled`: `sudo systemctl enable docker`.

Test it for real once (this is the step most people skip):

```bash
sudo reboot
```

Wait a minute, reconnect with `ssh ubuntu@<PUBLIC_IP>`, and run `docker compose ps` in
`~/feedberry-bot`. Both containers must be up again without you touching anything.

Oracle's idle-reclaim rule (section 4) is the remaining risk. Nothing in this stack can honestly
prevent it; the backup in 5.10 is the answer.

### 5.10 Nightly backup

Only one file really matters: the database `data/bot.db`. (`data/telegraph-token.txt` is worth
copying once too, if it exists.)

The database is written by a container that runs as **root**, and it runs in WAL mode, so a backup as
`ubuntu` fails with a permission error (`attempt to write a readonly database` or `unable to open
database file`). Run the copy step with `sudo`; that is already in the script.

```bash
sudo apt install -y sqlite3
nano ~/feedberry-bot/backup.sh
```

```bash
#!/usr/bin/env bash
set -euo pipefail
cd /home/ubuntu/feedberry-bot
mkdir -p backups
sudo sqlite3 data/bot.db ".backup 'backups/bot-$(date +%F).db'"
sudo chown ubuntu:ubuntu "backups/bot-$(date +%F).db"
# Docker Compose may still be writing; .backup is a consistent snapshot, so this is safe.
# Uncomment the next line once the rclone remote exists (see below):
# rclone copy "backups/bot-$(date +%F).db" gdrive:feedberry-backups/
find backups -name 'bot-*.db' -mtime +14 -delete
```

```bash
chmod +x ~/feedberry-bot/backup.sh
~/feedberry-bot/backup.sh          # run it once by hand
ls -l ~/feedberry-bot/backups      # one file must appear
crontab -e
```

Add one line (daily at 03:15 server time):

```text
15 3 * * * /home/ubuntu/feedberry-bot/backup.sh >> /home/ubuntu/backup.log 2>&1
```

Oracle's `ubuntu` user may run `sudo` without a password, which is what the script relies on. If your
cron job logs `sudo: a password is required`, move the same line into root's crontab
(`sudo crontab -e`) and skip the `sudo` inside the script.

**Getting the copy off the server** (do this within the first week; a backup on the same disk dies
with the server):

```bash
sudo apt install -y rclone
rclone config          # n → name: gdrive → storage: drive → blank id/secret → read-only: no → scope: 1
```

`rclone config` on a machine without a browser prints a link to open on your laptop. After it is set
up, uncomment the `rclone copy` line in `backup.sh`. A weekly manual alternative:
`scp ubuntu@<PUBLIC_IP>:~/feedberry-bot/backups/bot-YYYY-MM-DD.db .` from your laptop.

**Restore** (the full drill is `RUNBOOK.md` §4):

```bash
cd ~/feedberry-bot
docker compose stop bot
sudo cp backups/bot-YYYY-MM-DD.db data/bot.db
# Leftover WAL frames from the old database would be replayed into the restored file:
sudo rm -f data/bot.db-wal data/bot.db-shm
docker compose start bot
# /status must show the same source and chat counts as before the restore
```

### 5.11 Redeploy after a code update

```bash
cd ~/feedberry-bot
git pull
docker compose build bot
docker compose up -d
docker compose logs -f bot     # wait for polling_started again
```

`docker compose up -d` alone does **not** rebuild the image; the `build` line is the one that picks
up new code. Your `data/` folder is untouched by any of this.

---

## 6. Common beginner mistakes

1. **"BOT_TOKEN is missing."** — `.env` was not saved, or you edited `.env.example` instead of
   `.env`. Fix: `cd ~/feedberry-bot && cat .env | grep BOT_TOKEN` must show a value.
2. **Bot answers nothing, logs look fine.** — The bot only speaks to chats that wrote to it first,
   and `/status` only answers `ADMIN_CHAT_ID`. Send `/start` to the bot from the account whose numeric
   id you pasted.
3. **Set `RSSHUB_BASE=http://localhost:1200`.** — Inside Docker that points at the bot container
   itself, and every fetch fails. Keep `http://rsshub:1200`.
4. **The bot starts, then sources disappear after a redeploy.** — You ran it on a host with a
   temporary disk, or outside Compose so `DB_PATH` fell back to `data/bot.db` in a wiped folder.
   Confirm the mount: `docker compose exec bot ls -l /data/bot.db`.
5. **`docker build` fails with "no space left on device".** — The VM's boot volume is too small, or the
   Docker cache grew. Check `df -h /` and `docker system df`; `docker system prune -af` frees the
   build cache (never touch `./data`).
6. **"Out of host capacity" when creating the VM.** — Normal for the free A1 shape. Retry, use the
   other availability domain, or upgrade to Pay As You Go and stay inside 2 OCPU / 12 GB / 200 GB.
7. **Always Free resources in a different region.** — Always Free only applies in the tenancy's home
   region. Creating a VM elsewhere is billed. Keep everything in the home region.
8. **`attempt to write a readonly database` (or `unable to open database file`) during backup.** — The
   container writes `bot.db` as root in WAL mode. Run `sqlite3` with `sudo`, exactly as in `backup.sh`.
9. **`docker compose up -d` after `git pull` changes nothing.** — It reuses the old image. Run
   `docker compose build bot` first (section 5.11).
10. **Committing `.env`.** — Never. `.gitignore` already excludes it; keep the token in a password
    manager. If it ever leaks, `/revoke` in @BotFather and paste the new token into `.env`, then
    `docker compose up -d`.
11. **The bot container never starts.** — `docker-compose.yml` waits for RSSHub
    (`depends_on: condition: service_healthy`). `docker compose ps` then shows `rsshub` as
    `unhealthy` or restarting; read `docker compose logs rsshub`. The first start needs ~30 s and
    some RAM, nothing else.
12. **Deleting the folder `./data` or `./rsshub-cache` "to clean up".** — `./data` is the whole
    database. Nothing else in the repo needs deleting.
13. **A Facebook source says "temporarily unreachable" only on the cloud host.** — RSSHub asks
    `facebook.com/api/graphql` anonymously, and Facebook rate-limits that per IP; a home line is not
    throttled, a datacenter IP usually is. `docker compose logs rsshub` shows `Facebook GraphQL
    failed: Rate limit exceeded`. Fix: log in to facebook.com in a browser, copy the whole `Cookie`
    request header into `FACEBOOK_COOKIE=` in `.env`, then `sudo docker compose up -d rsshub`.

---

## Sources

All checked on 2026-11-02:

- Oracle Always Free limits, idle reclamation, 200 GB storage, 10 TB/month outbound:
  <https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm>
- Google Cloud free tier, `e2-micro`, 30 GB disk, 1 GB/month egress: <https://cloud.google.com/products/compute>
- AWS Free plan (credits, 6 months): <https://aws.amazon.com/free/>
- Azure free account (750 h B1s for 12 months, $200 credit): <https://azure.microsoft.com/en-us/free/>
- Render free web services (15-minute spin-down, no persistent disk, 750 h): <https://render.com/docs/free>
- Fly.io "Is there a free tier? No.": <https://docs.fly.io/about/pricing>
- Koyeb pricing (no free compute plan): <https://www.koyeb.com/pricing>

Repository facts used above: `Dockerfile`, `docker-compose.yml`, `package.json`, `.env.example`,
`src/config.ts`, `docs/adr/010-host-topology.md`, `docs/adr/017-owner-decisions.md`, `docs/RUNBOOK.md`.
