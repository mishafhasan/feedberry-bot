# ADR-015: Feed adapter in M2; scheduling stays in M4

**Status:** Accepted · 2026-10-31 · **Supersedes:** the M2/M4 scope split in ARCHITECTURE §14

## Context

§14 gives M2 the test "add an Instagram profile link, see last 5 titles" but assigns the "RSSHub adapter" to
M4. Pipeline stage 2 (`fetch_feed`, §5.3) is what produces those titles, and S4 is a normative screen that
must show the latest posts.

Two ways out: weaken M2's preview until M4, or move the adapter earlier. Weakening the preview means shipping
a screen that does not match S4 for three milestones.

## Options

| Option | Effect | Verdict |
|---|---|---|
| Preview shows only account metadata until M4 | S4 is half-built; M2's stated test cannot pass | Rejected |
| Duplicate a "preview fetch" in M2 and a "fetch adapter" in M4 | two code paths for the same HTTP+parse work | Rejected |
| **Move stage 2 (feed adapter) into M2; M4 keeps scheduler, jobs, slots, delivery** | one adapter, S4 real from M2, scheduling still its own milestone | **Chosen** |
| Move the whole scheduler into M2 | M2 becomes two milestones; nothing observable is gained | Rejected |

## Decision

M2 owns pipeline stages 1–2 and the read-only preview:

- `native_rss`: the site's own feed URL, or discovery via `<link rel="alternate" type="application/rss+xml">`.
- `rsshub`: `${RSSHUB_BASE}${route}` per the §10 matrix `[RH-DEPLOY]`.
- `bluesky_api`: public `getAuthorFeed` `[BSKY-API]`.
- RSS/Atom parsing into `FeedItem{guid, link, title, published_at, summary, media[]}`.
- S4 renders the last 5 items **oldest → newest**, read live; nothing is persisted in M2.

M4 owns: the 30 s tick, slots, `jobs`, claim/retry plumbing, stage 4 de-duplication against `posts`, R1
rendering, and delivery. M4 reuses the M2 adapter unchanged — it does not rebuild it.

## Consequences

- The adapter is written once and tested against fixtures in M2; M4 tests scheduling with the same fixtures.
- M2 does one HTTP fetch per preview, so a slow source makes S4 slow. Mitigation: 10 s timeout and a 60 s
  in-memory preview cache keyed by source URL (no DB write, so M2 stays stateless).
- Because M2 does not persist posts, "seen" tracking (§5.4) still begins in M4. That is correct: nothing is
  delivered before M4, so nothing can be duplicated.
- The staging boundary in §5.1 is unchanged; only the milestone that first implements stage 2 moves.

## Evidence

ARCHITECTURE §5.1, §5.3, §7.3 S4; `[RH-DEPLOY]`, `[BSKY-API]`; ADR-006.
