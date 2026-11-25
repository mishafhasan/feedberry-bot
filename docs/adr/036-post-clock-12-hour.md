# ADR-036: One clock for every delivered post — the reader's zone, a month name, and AM/PM

**Status:** Accepted · 2026-11-25 · amends ADR-023 and ADR-025

## Context

Every delivered post carries a `⏱️ Time` line, and ADR-023/025 fixed its shape as `DD/MM HH:MM`
(rich) and `MM/DD HH:MM` (classic). The reader asked for a time they do not have to convert:
an explicit AM/PM clock such as `Nov 24 02:30 PM`.

The investigation separated two questions that looked like one:

- **Is the zone right?** Yes. A probe over `Date.UTC(2026, 10, 24, 9, 0)` printed `14:30` for
  `Asia/Colombo` (+5:30) and `04:00` for `America/New_York` (UTC-5 in November) — so `users.tz`
  already reaches `postHeader`, and no UTC or server-local time leaks into the message.
- **Is the format right?** No. Both layouts printed a 24-hour clock without a suffix, and the two
  entry points (`mmddhhmm`, `ddmmhhmm`) existed only to pick a day-month order that a month name makes
  irrelevant.

## Decision

- **One helper, one clock.** `postTime(ms, tz)` prints `Nov 24 02:30 PM`: `Intl`'s month name, the
  day, a zero-padded 12-hour hour and the day period, in the reader's zone. `Intl` owns the
  conversion, so a DST change and a half-hour offset stay its business.
- **`mmddhhmm` and `ddmmhhmm` are gone.** They encoded a layout split that no longer exists; both
  `postHeader` layouts, the source preview (`sourceBody`) and the Download renderer now call
  `postTime`. `texts.ts` re-exports it instead of the old pair.
- **The S4/S5 preview carries the reader's zone too.** `sourceBody` already took a `tz`, but no caller
  supplied one, so the preview dated its items in UTC while delivery dated the same instant in
  `users.tz` — the exact conversion this ADR removes. The zone now reaches it from the user row at
  all three doors (resolve, send, back). It is passed **in** rather than re-read: `sendPreview` takes
  the user's row id, not the telegram id, so an `ensureUser(ownerUserId)` there would look up a
  different user.
- **Scheduling is not touched.** `slotAfter` and `digestSlot` already resolve a wall-clock hour in the
  subscriber's zone (`users.tz`, via `wallToUtc` with one DST correction pass), the tick reads that
  column straight from `users`, and changing the zone re-plans every slot and digest. `slots.test.ts`
  pins UTC, Berlin's two DST changes, Colombo's half hour (`08:00` local = `02:30Z`) and the
  unknown-zone fallback, so the behaviour the reader expects already held.
- **The digest's own labels are unchanged.** Its date line is a date, not a clock
  (`Tue, 25 Nov 2026` in the owner's zone), and its window is a pair of absolute instants compared
  against `published_at`; no timezone enters either. Its per-item times come from `postHeader`, so
  they inherit this clock.

## Consequences

- Every time a reader sees — an item in a delivered post, the rich quote layout, the S4 preview list,
  a Download caption, a digest item — is the same string in the same zone.
- A dozen pinned expectations named the old `DD/MM`/`MM/DD` shape and moved with it; the test that
  pins the clock for two zones is `test/unit/post-time.test.ts`.
- `shortcut:` the clock has no seconds and no locale negotiation — the bot speaks English and Tamil
  and the label is English in both (ADR-029). Upgrade if the message ever has to follow the app's
  language.

## Evidence

- Probe, this repo: `09:00Z` → Colombo `Nov 24 02:30 PM`, New York `Nov 24 04:00 AM`, UTC
  `Nov 24 09:00 AM`; `19:30Z` → Colombo `Nov 25 01:00 AM`, New York `Nov 24 02:30 PM`; the dial reads
  `12:05 AM`, `12:00 PM`, `01:00 PM` at its two edges.
- `npx tsc --noEmit`: exit 0. `npm test`: **560/560 pass**. `npm run build`: exit 0.
- `test/unit/post-time.test.ts` pins both zones, both dial edges, the zone-follows-the-day case, and
  both `postHeader` layouts. `test/integration/atom-preview.test.ts` sets its user to `Asia/Colombo`
  and asserts the exact `• [Nov 7 03:45 AM]` for the fixture's `22:15:59Z` entry, so a UTC leak in the
  preview fails. `test/unit/slots.test.ts` is the scheduling evidence and did not change.
- The readers of the old format, updated to the clock rather than to a regex they no longer describe:
  `caption-header`, `oversize-album`, `digest-render`, `rich-render`, `download-caption`,
  `atom-preview`, `link-classify`, `text-only-post`, `m4`, `m5`, `m11`, `m12`, `threads`.
