# ADR-010: Host topology — home Pi primary, Oracle fallback (superseded)

**Status:** Superseded by ADR-017 (2026-10-31): Oracle Cloud is now primary, home Pi is the fallback. The comparison below is kept as the original reasoning.
**Original status:** Accepted (design) · 2026-10-29

## Context

The stack needs a real filesystem, ffmpeg, a long-running process and ~0.5–1 GB RAM (RSSHub + bot).
Free tiers must be verified today, not remembered — two of my priors were wrong until I checked:

- Oracle Always Free A1 is now **2 OCPU / 12 GB** ("1,500 OCPU hours and 9,000 GB hours per month …
  equivalent to 2 OCPUs and 12 GB of memory"), with 200 GB block storage total `[ORACLE]` — not 4/24.
- Oracle may **reclaim idle** instances: 95th-percentile CPU < 20 %, network < 20 %, memory < 20 % over
  7 days `[ORACLE]`. A bot that is idle by design is the exact profile that gets reclaimed.

## Options

| Option | Cost | Runtime fit | Blockers | Verdict |
|---|---|---|---|---|
| Home mini-PC / Raspberry Pi 5, Docker Compose | hardware already owned, single-digit-watt class `[assumption]` | full: ffmpeg, volumes, long poll | home IP must reach Telegram/X (it can), uptime depends on the house | **Chosen** |
| Oracle Always Free A1 (2 OCPU/12 GB) | $0 | full | capacity errors at create time; idle reclamation; datacenter IP gets throttled first by cobalt's targets `[COBALT-README]` | Fallback |
| Render free web service | $0 | bot only | spins down after 15 min, ephemeral FS, 750 h/mo, Postgres expires in 30 days `[RENDER]` | Rejected |
| GitHub Actions cron | $0 for public repos | fetch only | 6 h job cap `[GH-LIMITS]`, 5 min minimum interval, delays at peak, disabled after 60 quiet days `[GH-SCHEDULE]`, no long poll, no persistent disk | Rejected |
| Cloudflare Workers | $0 | webhook router only | 10 ms CPU, 50 subrequests, no filesystem, no ffmpeg `[CF-LIMITS]` | Rejected |
| Fly.io / Railway / Koyeb free tier | — | — | terms change frequently; not verified as of 2026-10-29 | Not evaluated |

## Decision

> **Superseded by ADR-017.** The owner chose Oracle Always Free for zero hardware cost; everything below
> explains why the Pi was the original pick and what risks move to the primary path.

**Primary:** one home mini-PC or Pi 5 (≥ 2 GB, 4 GB comfortable), Docker Compose with `bot` + `rsshub`,
long polling (ADR-003), data on a local volume, nightly `sqlite3 .backup`.
**Fallback:** the same `docker-compose.yml` on an Oracle A1 instance, with a documented 10-minute rebuild
path and a nightly off-box backup.

## Consequences

- Residential IP is a material reliability advantage for Instagram/TikTok/Facebook `[COBALT-README]`;
  this is the strongest argument for home hosting, stronger than price.
- No $0 guarantee: the Pi costs money once. If "free" means zero spend, Oracle is the only option and the
  idle-reclamation risk must be accepted.
- Home uptime is the operator's problem: power cuts, ISP changes. Mitigation: `restart: unless-stopped`,
  SQLite durability, and a "missed slot" catch-up rule (a slot more than 12 h late is skipped, not replayed).
- The fallback is not a hot standby; failover is manual and takes minutes. That is acceptable for a bot.

## Evidence

`[ORACLE]`, `[RENDER]`, `[GH-LIMITS]`, `[GH-SCHEDULE]`, `[CF-LIMITS]`, `[COBALT-README]`.
