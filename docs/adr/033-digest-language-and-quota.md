# ADR-033: Strict digest language, the measured rich-message cap, and a free-tier quota ledger

**Status:** Accepted · 2026-11-22 · amends ADR-029, schema v8

## Context

Four reports came from the live bot, and each one traced to a different layer:

1. **Tanglish summaries.** The Tamil prompt only said "keep names in English"; nothing said *Tamil
   letters*, and nothing checked the answer. A model that romanises Tamil passes every existing
   test: `cleanSummary` flattens and clamps, it does not judge a script.
2. **Missing digest content.** The renderer packed parts by `html.length` against an assumed
   32 768-character cap, and the one piece whose size no clamp bounds — the "Also today" list — was
   emitted whole. A refused part throws out of `runDigest`, so every part after it is never sent.
3. **"🎧 Audio unavailable today".** The TTS ladder is four models × 10 requests a day, the script
   was cut into 2 500-character pieces (3-4 calls per digest), and `plansFor` writes the script
   **after** every summary, so a spent text ladder cost the audio first. Any failure was swallowed
   into one stdout line.
4. **Free-limit failures.** Nothing remembered that a model answered 429 ten minutes ago, and a
   "payload too long" 400 walked all eight text rungs (and, before the fix, would have done the same
   to four voices).

## Decision

- **The cap is measured, not assumed.** A probe against the real Bot API (throwaway chat, messages
  deleted after each case) settled both the unit and the ceiling:

  | Payload | Result |
  |---|---|
  | 30 000 ASCII characters | accepted |
  | 33 000 ASCII characters | `400 RICH_MESSAGE_TEXT_TOO_LONG` |
  | 24 000 Tamil characters / **64 000 UTF-8 bytes** | **accepted** |
  | 501 list items | `400 RICH_MESSAGE_BLOCKS_TOO_MANY` |
  | a real rendered part: 48 photos + the player, 24 224 Tamil characters | accepted |
  | a real rendered part: 33 media, 24 224 characters | accepted |

  So the cap counts **characters of the visible text**, not UTF-8 bytes and not markup. A byte
  budget would have tripled Tamil part counts for nothing; the budget stays 30 000 characters, is
  measured with `visibleChars`, and keeps its 2 768-character margin.
- **The one unbounded piece is bounded at source.** "Also today" is emitted in chunks of at most 50
  links and 8 000 characters, numbering runs across chunks, and only the first chunk carries the
  heading. `itemPiece` was already bounded by the clamps; `originalTitle` was the one input with no
  clamp at all (a feed can hand over a whole paragraph), so it now clamps to 400 characters.
- **TTS pieces are 5 000 characters, and a refused piece is retried at 2 500.** Measured with the
  real client: 3 929 Tamil characters came back as 12.5 MB of PCM (260 s) in 31 s; 9 169 characters
  failed at the transport level after 61 s, and 26 199 failed outright. One call for the whole script
  is therefore not reliable, and the digest now spends 1-2 calls instead of 3-4. The retry only
  applies to a payload the voice could not swallow (a `400 … too long`) or a transport failure —
  never to a 429, whose ladder has already been walked.
- **The quota ledger is a table.** `gemini_quota` (one row per model) holds a UTC day bucket, a
  minute bucket and a `blocked_until`. `attempt` in `gemini.ts` skips a spent rung **before** any
  request, counts the request before sending it (three summaries run at once, so the last slot must
  go to exactly one), and on a 429 blocks that rung until the provider's own deadline: end of the
  UTC day when the message says "per day", else 60 seconds. A per-day 429 must not disable a
  500-a-day rung for 24 hours, which is why the block is not simply "spent for today".
- **The summaries reserve the script's slots.** Every summary call leaves two slots free on whichever
  rung it uses (`SUMMARY_RESERVE`), so the script and its own language re-ask always find one; a busy
  day costs the voice its preferred timbre before it costs it existence. TTS capacity cannot be eaten
  by text at all, because the ladders are disjoint model sets.
- **The ladders are the published free-tier table, latest to oldest** (`gemini-4-hydrogen` →
  `3.8-flash` → `3.6-flash` → `3.5-flash-lite` → `3.1-flash-lite` → `3-flash-preview` →
  `2.5-flash-lite` → `2.5-flash`; the voice's four are unchanged). `gemini-3.1-pro-preview` is gone:
  the table gives it no free quota. The caps live in `FREE_TIER` in `src/config.ts`, next to the
  ladders, and an id the table does not know gets the tightest rung (5 a minute, 20 a day) rather
  than running uncapped.
- **Language is a rule and a check.** The prompts now name the script ("every Tamil word in Tamil
  letters, never romanised"; English "in English letters only"), and `offLanguage` enforces it: a
  Tamil answer with no Tamil script, or under 20% Tamil letters, and an English answer carrying any
  Tamil at all, are asked again — at most twice. A still-mixed answer **ships as it is**: a summary
  in the wrong style is worth more than a missing story, and a re-ask that never converges must not
  loop. The spoken script follows the same rule with the same bound.
- **The delivery destination has one door.** The settings screen's "📍 Deliver to" row was removed
  with its route, handler and both locale strings. The picker ("Where should the digest arrive?")
  is reached from the main-menu button, which already shows it whenever the user has more than one
  chat; the screen still prints the destination it will use, and a stale button on an old message
  answers "no longer available" like every other removed shortcut.

## Consequences

- A Tamil digest is one or two messages shorter than a byte budget would have made it, and no part
  can be refused for size: the budget is measured in the unit the server counts.
- A mixed-language answer can reach the chat after two re-asks. The log carries `reasks` and `lang`
  (`digest_language_mixed`, `digest_script_language_mixed`) so a prompt regression is visible.
- Quotas are remembered across restarts; a restart no longer re-earns the same 429s. The counters are
  conservative in one direction only: a 429 still increments the day bucket, so a rung is skipped
  slightly early rather than asked once more.
- `shortcut:` the ledger's day is UTC while the provider's resets at Pacific midnight, so for a few
  hours the counters reset early; the block from a real 429 covers the gap. Upgrade if a rung is
  ever skipped while it still answers.
- `shortcut:` the language check is a share test, not a tokenizer. It catches Tanglish (no Tamil
  script) and English sentences inside Tamil, but a Tamil sentence with a romanised verb inside an
  otherwise Tamil paragraph passes.
- Not fixed here, named for a later ADR: `render-post.ts` clamps the per-post body by `html.length`
  against the same 32 768 figure; the page it renders is far smaller, but the unit is equally wrong
  there.

## Evidence

- Probe, real Bot API, 2026-11-22, messages deleted after each case: the five rich-message rows above,
  plus two real rendered parts accepted end to end through `TelegramSender` (48 photos + player; and
  33 media with 24 224 Tamil characters of text in 28 632 characters of HTML).
- Probe, real TTS through `geminiClient`: `{"chars":3929,"words":405,"pcmBytes":12462720,"seconds":260,"ms":31650}`;
  `{"chars":9169,"words":945,"ok":false,"error":"fetch failed","ms":61532}`.
- `npm run typecheck`: exit 0. `npm test`: 545/545 pass. `npm run build`: exit 0.
- The unit tests that pin this decision: `digest-lang` (a real Tamil headline passes, Tanglish does
  not), `digest-quota` (day, minute, reserve and block buckets), `digest-gemini` (a spent rung costs
  no request, a per-day 429 blocks every rung that answered, a too-long payload blocks none),
  `digest-audio` (a refused piece is split, a rate-limited one is not), `digest-summary` (Tanglish
  ships after three calls and is cached), `digest-render` (a 400-story list is split and no story is
  lost), `digest-menu` (the screen has no second destination row and the old callback is dead).
