# ADR-017: Owner decisions on all 18 open questions

**Status:** Accepted · 2026-10-31 · **Supersedes:** ADR-010 (host order), ADR-011 (Tier 2)
**Decider:** project owner (beginner-friendly walkthrough; every answer chosen explicitly)

## Context

ARCHITECTURE §15 carried 18 open questions with recommended defaults. The owner reviewed them on 2026-10-31
and decided each one. One answer changes the design (OQ-17, no stored credentials); the separate hosting
choice changes the deployment order; Reddit confirms its default but is time-critical.

## Decisions

| OQ | Decision |
|---|---|
| OQ-1 Snapchat | Single links only, via Download Mode. No profile subscription, no scraping. |
| OQ-2 Reddit | **Removed** from the Add-source list (RSS ends 2026-11-13 `[REDDIT-RSS]`). Matrix row stays D. |
| OQ-3 Telegram | Beta, off by default; when enabled, read the public `t.me/s/<channel>` page. Never ask users for a Telegram session. |
| OQ-4 Threads host | Accept `threads.com` and `threads.net`; normalize to `.com`; pass the bare username to RSSHub `[RH-THREADS]`. |
| OQ-5 Over 50 MB | Preview image + caption + link. No transcoding, no local Bot API server. |
| OQ-6 Fidelity | Media + HTML caption, no signature. State the limit in the README; never claim pixel equality. |
| OQ-7 S1 plan block | Show `Plan: Free`; no trial line. Keep `Sources: N / 250`. |
| OQ-8 Download mode | **Built in the MVP** as pipeline reuse (ADR-013). |
| OQ-9 Forum topics | Pick an existing topic only; never auto-create. |
| OQ-10 Destinations | One subscription per `(source, chat)`; repeat the flow for another chat. |
| OQ-11 Source limit | 250 per user, config-driven. |
| OQ-12 Album tokens | One token per media item against group/global buckets; backfill at 1 msg/s. |
| OQ-13 Instant View | Telegra.ph rewrite for every article; `t.me/iv&rhash` only for domains the operator owns. |
| OQ-14 Wording | Keep "Instant View"; document the Telegra.ph mechanism once in the README. |
| OQ-15 FSM states | Add `error` and `confirming_delete` to the six named states. |
| OQ-16 Rich messages | Not in the MVP. Revisit only when client coverage is confirmed on Desktop, Android, iOS and Web. |
| OQ-17 Credentials | **No credentials are stored.** Login-only sources are refused at add with `E_COOKIE_REQUIRED`; blocked media renders as a link card; single posts still work in Download Mode. |
| OQ-18 Duration | ffprobe, else feed duration, else "unknown" (R9). Engine follow-up stands. |

Hosting (not an OQ, asked separately): **Oracle Cloud Always Free is primary**, home mini-PC / Pi is the
fallback. 250 sources per user confirmed.

## What the decisions change

### 1. No stored credentials (OQ-17)

- The `secrets` table, `sources.auth_ref`, AES-256-GCM encryption, cookie entry UI and cookie deletion path
  are **all removed** from the MVP. Fewer components, smaller attack surface.
- Tier 2 of ADR-011 (per-user session cookie) is deleted. Tiers T0, T1, T3, T4 remain.
- Consequence, stated plainly: for Instagram, Facebook and X the **feed** usually needs a login, so adding
  such a profile will be refused rather than silently broken. X's terms forbid automated scraping `[X-TOS]`,
  so this also removes the clearest legal exposure.
- Reliability grades drop accordingly: X from C to **D**, Instagram/Facebook stay **C** with "public pages
  may work; otherwise refused". Single posts remain downloadable through Download Mode.

### 2. Oracle Cloud primary (ADR-010 superseded)

- Always Free A1: 2 OCPU / 12 GB / 200 GB `[ORACLE]`. No hardware purchase; the operator runs nothing at home.
- Risks become primary-path risks: capacity errors at create time, **idle reclamation** (< 20 % CPU,
  network and memory over 7 days) `[ORACLE]`, and datacenter IPs being throttled sooner `[COBALT-README]`.
- Mitigations are mandatory in the runbook: nightly off-box backup, rebuild from compose in ~10 min, and the
  Pi as the documented fallback.
- This choice makes the no-cookie decision harder: a home IP would have been kinder to Instagram/TikTok. The
  trade was made explicitly: zero cost and zero hardware over maximum platform reach.

### 3. Reddit removed (OQ-2)

- S2 lists 11 platforms; Reddit is gone rather than shown broken two weeks after launch `[REDDIT-RSS]`.
- The feasibility matrix keeps the Reddit row as D so the reasoning survives.

## Consequences

- Schema shrinks: eight tables, no `secrets`; `sources` has no credential column.
- M9 hardening loses the encryption audit; it keeps token/cookie-header redaction, quotas, chat re-verification
  and retention.
- M2 must refuse login-only feeds with a clear message and offer Download Mode, instead of promising a cookie
  flow that does not exist.
- The risk register leads with platform blocking under a datacenter IP plus Oracle idle reclamation.

## Evidence

ARCHITECTURE §1.4, §4.5, §5.5, §6, §10, §11, §12, §13.2, §15; `[ORACLE]`, `[REDDIT-RSS]`, `[X-TOS]`,
`[RH-CONFIG]`, `[COBALT-README]`; ADR-010, ADR-011, ADR-013.
