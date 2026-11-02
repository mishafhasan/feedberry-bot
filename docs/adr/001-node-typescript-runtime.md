# ADR-001: Node.js 22 + TypeScript, grammY

**Status:** Accepted (design) · 2026-10-29 · **Amended 2026-11-02: runtime is Node.js 24, not 22** (see Amendment below) · **Deciders:** architecture

## Context

Three locked engines must run on the same host: cobalt-engine (ESM, Node ≥ 18.17, imports `fetch`
directly), formatbot1's article logic (CommonJS, Node ≥ 21, `undici`, `jsdom`, `@mozilla/readability`),
and RSSHub (Node + optional Chromium, containerised) `[COBALT-README][FB-README][RH-DEPLOY]`.

## Options

| Option | Verdict |
|---|---|
| Node + TypeScript, one process, cobalt imported as a library | **Chosen** |
| Node + JavaScript | Rejected: ~10 typed boundaries (feed item, resolve result, render plan, delivery) where a typo becomes a bad user-visible message |
| JVM (Kotlin/Java) + shelling out to Node for cobalt | Rejected: a process spawn per post, plus 150–300 MB JVM baseline for no gain `[assumption]` |
| Python + a Node sidecar service | Rejected: second runtime, second failure domain, an HTTP hop for every media resolve |
| Go | Rejected: cobalt cannot be imported; same sidecar problem |

Bot framework: **grammY**. Telegraf 4.16.3 is what formatbot1 uses `[FB-README]` and is a valid
alternative; grammY wins on typed context, built-in long-polling runner, session/FSM plugin, and ESM
parity with cobalt-engine. Raw Bot API over `fetch` would mean hand-writing the callback router and
FSM, i.e. more code for the same result.

## Decision

Node.js 22 LTS, TypeScript, `"type": "module"`, one process, grammY, `better-sqlite3`-class synchronous
SQLite driver (single writer, no pool).

## Consequences

- One runtime, one lockfile, one container. cobalt is `import { resolve, download }` — no HTTP, no
  serialisation of the resolve result.
- TypeScript adds a build step; run `tsc` in the image build, ship `dist/`.
- CommonJS helpers copied from formatbot1 (`readability`, `sanitize-html`, `dom`) need ESM interop or a
  small adapter; keep them behind the article module so the rest of the pipeline stays ESM.
- The Java component mentioned in the brief is dropped; that is intentional and justified above.

## Evidence

`cobalt-engine/package.json`, `cobalt-engine/README.md`, `[FB-README]` (formatbot1, design reference only —
not vendored), `[RH-DEPLOY]`.

## Amendment (2026-11-02)

Implementation runs on **Node.js 24**, not 22. The `better-sqlite3`-class synchronous driver chosen above is
the built-in **`node:sqlite`** (`DatabaseSync`), which is stable only from Node 24; Node 22 would need
`--experimental-sqlite`, and 24 also removes the native-build step the original plan assumed. Node ≥ 24 is
enforced in `package.json` `engines` and the `Dockerfile` (`node:24-alpine`). Everything else in this
decision — one process, ESM, TypeScript, grammY, single-writer synchronous SQLite — is unchanged.
