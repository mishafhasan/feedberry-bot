# ADR-005: cobalt-engine in-process, no media service

**Status:** Accepted (design) · 2026-10-29

## Context

cobalt-engine was extracted from cobalt's API specifically to run as a library: "no HTTP server, no
database, no Redis, no native binaries … Four small pure-JavaScript dependencies" `[COBALT-README]`.
Upstream cobalt runs as an API service with a tunnel server; in the library the tunnel is a no-op
(`compat.js` returns the origin URL) `[COBALT-GUIDE]`.

## Options

| Option | Cost | Verdict |
|---|---|---|
| Import `resolve`/`download` in the worker | 0 extra services; ~1 s metadata resolve; streamed bytes `[COBALT-README]` | **Chosen** |
| Run upstream cobalt API in a container | +1 service, +1 port, +version drift; needs a tunnel for some sources | Rejected |
| Shell out to the CLI per post | process spawn per post, JSON re-parse, no `AbortSignal` | Rejected: the CLI exists for humans |
| yt-dlp for everything | native binary, Python runtime, per-platform extractor drift | Rejected: the engine already covers the 11 platforms |

## Decision

The worker imports the library. One resolve per item, one download per media URL into `/tmp/media/<job>`,
`AbortSignal` wired to the job timeout. `configure({})` is called once at boot with quality/mode defaults;
no cookie pool is used (ADR-017).

## Consequences

- Media URLs are IP-bound and expire in minutes `[COBALT-README]`; resolve → download → send stays inside
  one job, and a cached resolve is never reused across jobs.
- Datacenter IPs get throttled first `[COBALT-README]`; this is an input to ADR-010, not something the
  code can fix.
- The engine surfaces `status: "error"` with `error.code` (`link.unsupported`, `fetch.rate`,
  `content.too_long`) instead of throwing `[COBALT-README]`; the pipeline maps those codes 1:1 to §11.
- `requiresMux` / HLS need ffmpeg; without it those items fail with a known code rather than hanging.
- AGPL-3.0 is inherited from upstream `[COBALT-README]`. Running it as part of a network service obliges
  publishing that service's source — acceptable for this project, and a licence note must ship in the README.

## Evidence

`[COBALT-README]`, `[COBALT-GUIDE]`, `cobalt-engine/src/engine.js`.
