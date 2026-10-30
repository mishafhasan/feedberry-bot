# ADR-016: Source-list actions in M3, not M8

**Status:** Accepted · 2026-10-31 · **Supersedes:** the S8/S9/S10/S11 scope in ARCHITECTURE §14

## Context

§14 puts S8 (disable toast), S9 (queued toast), S10 (delete confirm) and S11 (deleted toast) in M8, while M3
builds S7 — the screen whose cards carry those three buttons. Between M3 and M8 the UI shows controls that do
nothing, on a screen the brief declares normative.

They are also not reliability features. S8 and S10/S11 are pure CRUD on `sources`/`subscriptions` (§6), and
S9 is a single insert into `jobs` — which does not exist until M4.

## Options

| Option | Effect | Verdict |
|---|---|---|
| Leave all four in M8 | five milestones of dead buttons; the M3 screen is not shippable even as a preview | Rejected |
| Move all four to M3 | S9 has no `jobs` table to write and no worker to honour it | Rejected |
| **S8/S10/S11 in M3; S9 in M4; M8 keeps backoff, full 429, health, alerts** | each control lands with the thing it depends on | **Chosen** |
| Build S7 without its buttons until M8 | violates the normative screen | Rejected |

## Decision

- **M3:** `src:on` / `src:off` (S8), `src:del` / `src:delok` / `src:delno` (S10/S11), including cascade delete of
  subscriptions, orphan-source cleanup, `posts` cleanup, and secret deletion (OQ-17 mechanics).
- **M4:** `src:check` (S9) — priority-100 `manual_check` job, toast, and the rule that a manual check never
  moves `next_slot_at` (§4.6).
- **M8:** retries/backoff, complete 429 policy, per-source health display, alerts, and an audit that every
  failure path ends in `[🔁 Retry] [← Back]`.

## Consequences

- M3 must answer `answerCallbackQuery` and re-render S7 in place, so deletion never leaves a stale card.
- Because delete is live from M3, the cookie-deletion path (OQ-17) must be correct before any cookie can be
  stored in M8/M9 — which is the safe order anyway.
- M8 loses four UI items and keeps only behaviour that cannot be observed without failures; its verification
  (kill RSSHub mid-fetch) is unchanged and still proves the milestone.
- S9's toast text comes from the screenshot; M4 owns it verbatim.

## Evidence

ARCHITECTURE §7.1, §7.2, §7.3, §11; `UI-Refference/8..11*.png`; `[TG-FAQ]`; ADR-013.
