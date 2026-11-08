# ADR-020: Keyword filter — substring matching on already-parsed text

**Status:** Accepted · 2026-11-08 · **Extends:** ARCHITECTURE §5.1 (stage 7), §6 (data model), §7.2 (callbacks)

## Context

Users follow whole sources, so a site-wide feed or a broad category (`techcrunch.com/category/artificial-intelligence/`)
delivers posts the user does not want. The ask: keep only the posts whose text mentions a word the user
cares about — a list per subscription, with one user-level fallback, and no delivery at all for the rest.

Three facts decided the design:

- Every feed item already carries the words that matter: `FeedItem.title`, `summary` (up to 4 000
  characters, the longest of `description`/`summary`/`content:encoded`/`content`) and `categories`
  (RSS `<category>`, Atom `<term>`, both read by `categoriesOf`). No page fetch and no parser work is
  needed to filter.
- `posts.payload_json` did **not** keep `categories`, so a tag could not be matched at delivery time.
- `deliveries.status` already declared `'skipped'` and nothing wrote it. That is exactly the state a
  filtered post needs: decided, never retried.

## Options

| Option | Effect | Verdict |
|---|---|---|
| **Substring, any-of, case-insensitive, evaluated at stage 7** | One pure function, tags included, no new dependency, nothing downloaded for a dropped post | **Chosen** |
| Word-boundary / token matching | "ai" stops matching "said", but a Sinhala or Tamil keyword, an `#ai`, or "c++" needs a tokenizer per language | Rejected: wrong more often than it is right across the six UI languages |
| External NLP / classifier / embeddings | Semantics ("the story is about AI") without a keyword list | Rejected: a network call per post, a dependency, and an unexplainable drop |
| Filter when the `pending` row is created (stages 4/5) | No `skipped` rows at all | Rejected: two call sites (`persistNew`, `addSource`) instead of one, and a keyword typed later could not apply to a post already queued |
| Filter in stage 2, before the post is recorded | Also saves the `posts` insert | Rejected: a post filtered today stays filtered after the user broadens the list, and the seen-set would forget it |

## Decision

1. **Matching** is `passesFilter(item, keywords)`: build one lowercase haystack from `title`,
   `summary` and every `categories` entry, then test `includes` for each keyword. Any hit passes;
   an empty or blank list passes everything. No tokenising, no stemming, no scoring.
2. **Storage** is `subscriptions.keywords` and `users.default_keywords`, both `TEXT` holding a
   comma-separated list (ADR-009 keeps the schema flat; a join table buys nothing for a list that is
   only ever read whole). NULL or blank means "no list", so the row follows the user default, and a
   user with no default receives every post. Schema v5, `ALTER TABLE` for existing files, applied in
   one transaction so a crash cannot leave a half-migrated file that every later boot rejects.
3. **Resolution order** is row list → user default → nothing (`effectiveKeywords`). There is no
   "explicitly no filter" state: the UI offers a list or the default, which is what the screens promise.
4. **The gate runs in stage 7**, in `deliverSource`, per (post, chat), before `planForDelivery`. A
   filtered post gets `deliveries.status = 'skipped'` and is never revisited; no media is resolved, no
   file is downloaded, no Bot API call is made. `posts` already holds it, so a later keyword change
   applies to the next post, not to the archive.
5. **Tags survive to stage 7**: `payload_json` now carries `categories` alongside `title`, `summary`
   and `media`. This is a JSON blob inside `posts`, so no migration and no reader change beyond
   `payloadOf`.
6. **The UI asks once per add and once per edit.** S5 carries `🔑 Keywords: …` and a `🔑 Keywords`
   button; the typed answer is parsed, echoed back on S5, and written by stage 4 with the subscription.
   `/filter` is the single management screen: the user default, every source with its list, `✏️` to
   set and `🗑` to clear. `/skip` clears a list without hunting for the button. A row with no list of
   its own prints `uses the default: …`, never `every post`, when a fallback exists.
7. **No new config knob and no new dependency.** The filter is a column, not a feature flag.
8. **A prompt owns ordinary text only.** A pasted link, a slash command or a reply-keyboard tap falls
   through to its own handler, and any repaint of the `/filter` list, or a Back, cancels the step. A
   stray message can therefore never become a keyword list that silently mutes a source.

## Consequences

- **A filtered post costs one `deliveries` row** (status `skipped`, `attempts = 1`) per chat. That is
  the audit trail of "we saw it and dropped it"; it is the same order of growth as the `posts` row it
  points at, and it is pruned by the existing retention pass.
- **Substring matching is coarse by design**: `ai` matches `said`, `email` and `chai`. The prompt says
  "keywords or tags", and the upgrade trigger is a real user who needs whole words — then a token
  matcher goes behind the same `passesFilter` signature, with these tests as the regression suite.
- **A Threads post is filtered on its enriched text.** `withThreadText` fetches the permalink once for
  the delivery it may still refuse, so a dropped Threads post costs one page GET. Filtering before the
  enrichment would match against the feed's cut-down preview and silently drop posts whose keyword
  appears later in the thread — the wrong trade.
- **Two chats, two lists**: the filter is per subscription, not per source, so one chat can watch
  "ai" while another takes everything from the same source.
- **Not covered:** the S4 preview lists the newest items unfiltered (the list does not exist yet at
  that point), and a post already delivered is never re-filtered.
