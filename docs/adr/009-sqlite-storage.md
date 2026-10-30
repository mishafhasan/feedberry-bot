# ADR-009: SQLite as the only datastore

**Status:** Accepted (design) · 2026-10-29

## Context

State needed: users, chats, sources, subscriptions, posts/seen, deliveries, jobs, events. Write volume:
bounded by delivery rate (~30/s Telegram-wide `[TG-FAQ]`), realistically < 5 writes/s `[assumption]`.
Host is one machine (ADR-010) and the process is single (ADR-002).

## Options

| Option | Ops cost | Fit | Verdict |
|---|---|---|---|
| SQLite (WAL) file | none; backup = copy | single writer, perfect for this shape | **Chosen** |
| Postgres container | +1 service, +100–200 MB, +backup job, +tuning | multi-writer, HA — unused | Rejected |
| MongoDB Atlas free tier | free 512 MB, but network latency per write and a vendor pause policy `[assumption]` | documents, no joins | Rejected |
| formatbot1's MongoDB (reuse) | inherits its ops surface | same as above | Rejected: we are not deploying formatbot1 |
| JSON files on disk | zero | no atomic claim, no indexes, corruption on crash | Rejected |

## Decision

SQLite in WAL mode, `busy_timeout=5000`, `synchronous=NORMAL`, file at `/data/bot.db` on a mounted volume.
Schema creation is idempotent DDL at boot (`CREATE TABLE IF NOT EXISTS`), no ORM, no migration framework
in the MVP; a `schema_version` row gates future migrations.

## Consequences

- Backup/restore is a file operation (`sqlite3 .backup`), which makes the Oracle "instance may be
  reclaimed" risk `[ORACLE]` survivable in minutes.
- One writer means a long transaction can block delivery inserts; every write is short and the worker
  never holds a transaction across an `await` on the network.
- `jobs` cannot be shared across machines. Scaling out requires Postgres — a deliberate, documented ceiling.
- Free-tier SaaS databases were rejected mainly because they pause or expire, which is exactly the wrong
  failure mode for a bot that must answer a tap at 03:00.

## Evidence

`[TG-FAQ]`, `[ORACLE]`, §6 of ARCHITECTURE.md.
