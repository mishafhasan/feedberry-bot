# Links inside a message: extract, classify, then run the normal flow

**Date:** 2026-11-13 · **Branch:** feat/link-extract

## Problem

Every entry point classifies `ctx.message.text` as if the whole message were one URL. Two real
messages therefore do the wrong thing:

| Message | Today | Cause |
|---|---|---|
| `look at this https://x.com/blue/status/123` | silence | `new URL()` throws; the "looks like a link" test only matches text that *starts* with `http` |
| `https://a.com/x https://b.com/y` | downloads `https://a.com/x%20https://b.com/y` | the URL constructor accepts spaces in the path |
| `(https://instagram.com/p/C1/)` | silence | the bracket travels into the host |

The classifier, the chooser, Download Mode and the add flow are already correct for a single clean
URL. The missing stage is extraction, and it belongs before stage 1, not inside it.

## Design

### Extraction — `src/platform/registry.ts`

`linksIn(text): string[]` — pure, no network:

- matches `https?://…` and bare `www.…` tokens (`www.` is prefix-normalised to `https://`);
- trims the sentence's trailing `.,;:!?…` and any trailing `)`, `]`, `}` that the text opened but
  the URL did not (a balanced `)` — Wikipedia — stays);
- deduplicates, keeping message order.

A `www.` host without a scheme is the only scheme-less form accepted. A bare `instagram.com/p/x`
stays unsupported: the same shape is ordinary prose, so accepting it would guess.

### Routing — `src/bot/callbacks.ts`

`handleFreeText` and `handleSourceLink` both route on `linksIn(text)`:

| Links | Behaviour |
|---|---|
| 1 | today's flow, unchanged: source → preview, post → Download / Add source chooser |
| 2+ | `notice.oneLink` + Help/Home; the FSM state is left untouched, so the next single link still works |
| 0, text names a link (`://`, `www.`) | `notice.linkInvalid` + Help/Home — no Retry, it would fail identically |
| 0, ordinary text | silence, as today |

The "Add source" button keeps its current visibility: it appears only when the parent account is
followable, so a post on X without instance tokens or on Snapchat offers Download alone rather than
a button that can only end in an error.

### One live chooser

A chooser message is deleted the moment another flow takes over (a second link, a source add, a
download). Two prompts read identically, and without this the older message's buttons would act on
whatever link arrived last. The result message after a download keeps its own `add:post` button: it
is not a chooser prompt, so it is never deleted.

## Out of scope

- links in photo/video captions (`message:caption`);
- a picker screen for 2+ links (the user chose one-link-at-a-time feedback);
- scheme-less domains other than `www.`.

## Tests

- `test/unit/registry.test.ts` — `linksIn` cases: words around the URL, two URLs, trailing
  punctuation, balanced/unbalanced brackets, `www.` prefixing, dedupe, no link, `ftp:` ignored.
- `test/integration/link-classify.test.ts` — post with text reaches the chooser; source with text
  reaches the preview (asserted by the fetched feed URL); Add Source with text around the link gets
  the preview, not "Send a source link, not a post"; two links get one notice and the state still
  accepts the next link; `ftp:` gets the notice with no `err:retry`.

## Verification

`npm run typecheck`, `npm test`, `npm run build`. No `package.json` / `Dockerfile` / `cobalt-engine`
/ `schema.sql` change, so the Docker image is not rebuilt (repo rule).
