# ADR-004: One fetch per source, per-subscription delivery slots

**Status:** Accepted (design) · 2026-10-29

## Context

Two rules collide: "one fetch per source shared across all subscribers" and "default check at 08:00 and
20:00 **in the user's** time". Ten users in ten timezones following the same Instagram account must not
cause ten fetches, but each must get posts at their own 08:00/20:00.

## Options

| Option | Behaviour | Verdict |
|---|---|---|
| Per-subscription fetch | honours each user's clock; 10× the scraping, 10× ban risk | Rejected |
| Per-source fixed schedule (UTC) | 1 fetch; wrong clock for everyone outside UTC | Rejected |
| Per-source schedule owned by the first subscriber | 1 fetch; later subscribers inherit a foreign clock | Rejected |
| **Per-source fetch at the union of due slots; delivery to all current subscribers** | 1 fetch per due slot; each subscription keeps its own clock | **Chosen** |
| Immediate delivery queue with per-chat quiet hours | 1 fetch; complexity, and "08:00" becomes "not before 08:00" | Rejected for MVP |

## Decision

- `subscriptions.next_slot_at` = next 08:00/20:00 in `users.tz`, or `now + interval` when the source has
  an interval override.
- The tick selects sources where **any** active subscription is due, enqueues one `fetch_source`, then
  advances every due subscription's `next_slot_at` before the job runs.
- Delivery goes to every subscription of that source with `deliver = 1`, not only to the ones whose slot
  fired. A subscriber whose slot is at 20:00 but whose source was fetched at 19:58 receives that fetch's
  new posts immediately; their 20:00 slot finds nothing new and is advanced silently.
- A per-source interval override (`interval_minutes`) replaces the two daily slots for every subscriber
  of that source.

## Consequences

- Fetch count ≈ unique `(source, slot)` pairs, which is the minimum possible.
- Worst case a user sees new posts up to one slot early (if a co-subscriber's clock fires first). This
  is a deliberate, documented trade-off, not a bug.
- `next_slot_at` must be computed with a real tz database; DST is handled by recomputing the wall clock,
  never by adding 12 h.
- Manual checks bypass slots and do not move them.

## Evidence

`[TG-FAQ]` (why fetch amplification is dangerous), §4.3 of ARCHITECTURE.md.
