# ADR-035: A digest part that fails costs its own stories only, and the window retries whole

**Status:** Accepted · 2026-11-25 · amends ADR-029 and ADR-034

## Context

The live digest still arrived with summaries missing. The renderer was not the cause: a probe over the
exact reported shape — 20 Tamil summaries plus 60 "Also today" links — split into two parts with
every headline, description, key point and overflow link appearing in exactly one of them, no part
over any budget, and no item block or list cut across parts (`digest-render`, "the live shape loses
nothing"). The loss was one layer down, in `runDigest`:

```ts
for (const plan of built.plans) await deps.sender.send(plan, target);
```

One refused part threw out of the loop, so **every part after it was never attempted**. Nothing
logged how many parts were planned, and the only trace was the job error, which names no content. A
refusal of part 1 therefore left the reader with part 1's stories missing and no way to tell.

## Decision

- **Every part is attempted.** Each `send` is wrapped; a failure is recorded and the loop continues,
  so one refused part cannot cost the stories after it.
- **A failure names the payload it refused.** `digest_part_failed` carries the part index, the part
  count and the measured `chars` / `htmlChars` / `bytes` of the refused html. Until now the live
  threshold could only be guessed at; this makes the first refusal self-describing, and a constant is
  only lowered when that line proves it must be.
- **Every run reports planned against sent.** `digest_parts_sent` logs `{planned, sent, failed}` on
  success and on failure, so a short digest is visible in the container's stdout without reading
  between job retries.
- **The window is committed only when every part is on Telegram.** A failed part leaves the pin in
  place and the run throws the first failure, so a *transient* failure retries the same window and
  delivers the digest whole. `shortcut:` that retry resends the parts that did arrive; a per-part
  ledger is the upgrade if those duplicates ever matter.
- **A refusal that cannot change is terminal, not retried.** `TelegramSender.retrying` now maps a 400
  that names a size (`RICH_MESSAGE_TEXT_TOO_LONG`, `RICH_MESSAGE_BLOCKS_TOO_MANY`, `message is too
  long`) to `E.TOO_LARGE`, which `retryDelayMs` already treats as final. Without this, the same html
  was refused on all six rungs (1 m, 5 m, 25 m, 2 h, 6 h): the missing part never arrived and the
  parts that did were delivered six times. The digest's own pre-flight guard throws the same code for
  the same reason — a deterministic answer is worth one attempt, not six that also re-run the script,
  the voice and the image downloads.
- **An over-budget part is never sent.** A pre-flight guard measures every rich plan with
  `overBudget` and, when one is over, logs `digest_parts_over_budget` and fails before the first send
  — a loud failure beats a digest the reader can never complete.
- **The budgets stay at their measured values** (`MAX_PART_CHARS` / `MAX_PART_HTML` 30 000,
  `MAX_PART_BYTES` 64 000, ADR-033/034). Nothing observed contradicts them, and lowering a measured
  acceptance without evidence would only add messages.
- **The one unbounded input is bounded.** A feed URL longer than 2 000 characters is dropped, never
  truncated: an href is the only field that reaches a piece without a clamp, and one oversized piece
  is the one thing `pack` cannot split. The story still ships, its label unlinked.

## Consequences

- A refused part leaves a digest that is short by exactly that part, logged with its size, and —
  when the refusal is transient — completed on the retry. The reader may see the digest twice; they
  never see it silently short.
- A part refused for its size fails the run once. The stories in that part stay missing for that
  window, which is why the packer must never produce one: the pre-flight guard catches it before the
  first send, and `digest_parts_over_budget` names the part and its three measurements.
- `digest_parts_sent` is the one line to check in the container for "did the digest arrive whole".
- `pack` remains a pure function: the boundary rule did not change, and the new unit test pins it
  (whole blocks, whole lists, exactly-once content).

## Evidence

- Probe on the reported shape, before any change: 2 parts, `{chars: 18451, html: 23292, bytes: 56343}`
  and `{chars: 5788, html: 9103, bytes: 19552}`; zero missing, zero over budget, zero cut blocks.
- The refusal, simulated through the real sender and the real job runner
  (`fakeBotApi({failRichParts: [1]})`): the container log reads
  `{"code":"digest_part_failed","part":1,"parts":3,"chars":16512,"htmlChars":24758,"bytes":24781,"cause":"Bad Request: RICH_MESSAGE_TEXT_TOO_LONG"}`
  followed by `{"code":"digest_parts_sent","planned":3,"sent":2,"failed":[1]}`; all 401 overflow
  stories rode in the attempted parts, the footer part was reached, `last_window_end` stayed NULL, and
  the job ended `failed` at `attempts: 1` — one attempt, not six.
- `npx tsc --noEmit`: exit 0. `npm test`: **503/503 pass**. `npm run build`: exit 0.
- The tests that pin it: `digest-render` ("the live shape loses nothing…", "an unopenably long link is
  dropped…"), `digest-job` ("a refused part does not cost the parts after it, and a size refusal is
  not retried").
