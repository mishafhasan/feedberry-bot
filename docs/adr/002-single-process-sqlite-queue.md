# ADR-002: One process with a SQLite-backed job queue

**Status:** Accepted (design) · 2026-10-29

## Context

The bot needs: a 30 s scheduler, a worker that runs 1–2 heavy jobs (feed fetch, media download, upload),
a job store with delayed retries, and idempotency. Constraint C2 says nothing heavy runs while idle;
C1 says no paid infrastructure.

## Options

| Option | Cost / risk | Verdict |
|---|---|---|
| In-process loop + `jobs` table in SQLite | 0 extra services; retries via `run_after`; crash recovery via `locked_at` | **Chosen** |
| BullMQ + Redis | +1 always-on service (~30–100 MB), +1 backup target, +1 failure mode | Rejected |
| pg-boss + Postgres | +1 server (~100–200 MB), needs tuning; more than 200 sources need `[assumption]` | Rejected |
| Cloud queue (SQS/Cloud Tasks) | free tiers exist but add credentials, network dependency, and violate "nothing runs while idle" less than they help | Rejected |
| `node-cron` scheduling inside the process | still needs a job store for retries; two sources of truth | Rejected |
| Separate scheduler + worker processes | IPC and two writers on one SQLite file for zero benefit at this scale | Rejected |

## Decision

One process owns: long polling, FSM, scheduler tick, worker pool (concurrency 2), delivery serializer.
A single `jobs` table is claimed with one `UPDATE … RETURNING` statement, so a duplicate claim is
impossible even if the worker loop is later parallelised.

## Consequences

- Whole state is one file: backup = copy, restore = copy (ADR-009).
- A crash mid-job loses at most one attempt; `locked_at` older than 10 min is reset to `queued`.
- Worker concurrency is a config (`WORKER_CONCURRENCY`, default 2) and must stay ≤ CPU cores to keep
  C2 honest; the tick is cheap when nothing is due.
- Scaling out later means moving `jobs` to Postgres and splitting the worker — a contained change
  because the claim statement is already the only coupling.

## Evidence

`[TG-FAQ]` for the delivery-rate ceiling that bounds useful concurrency.
