# Expandable Quote Blocks

How Telegram's expandable blockquotes work, and how to build them well —
including the six-quote differentiation pattern and the all-formattings
showcase used by this bot. Everything here was verified live against
Bot API 10.x (`scripts/verify-quotes.mjs`).

## 1. What an expandable quote block is

An expandable blockquote is a shaded, left-bordered quote that the **Telegram
client** renders with a "Show more" / "Show less" control. Tapping it expands
the full quote and shrinks it back, with the native animation.

You create one by wrapping inline rich text in a `blockquote` with the bare
`expandable` attribute, sent in a rich message with HTML mode:

```html
<blockquote expandable>First line<br>Second line<br>Hidden tail line</blockquote>
```

Key facts that follow from where the control lives:

- **All interaction is client-side.** The bot emits the tag once at send time.
  There is no callback, no inline button, and no bot-side state. If the tag is
  correct, the tap behavior comes for free.
- **The client decides the collapsed height.** There is *no* markup knob for
  "show N lines initially". A quote whose content fits the client's collapsed
  height simply renders fully, and `expandable` is ignored.
- **The API is lenient; the client is not.** The Bot API *accepts* block
  elements nested inside `<blockquote expandable>` (tables, pre, details,
  button rows…). But the block type is specified to take inline RichText only —
  a quote with block children **silently loses its collapse control** and
  renders permanently expanded. This is the single most common way to break it.

## 2. The two golden rules

**Rule 1 — inline content only.** Inside `<blockquote expandable>` use only
inline RichText tags: `b i u s tg-spoiler mark sub sup code tg-emoji tg-time
tg-math a br` (plus plain, escaped text). No `pre`, no `h1`–`h6`, no lists, no
`table`, no `details`, no `aside`, no `tg-math-block`, no `tg-button-row`.

**Rule 2 — visible lines live outside the quote.** Because the collapsed
height is not configurable, "show N lines before the fold" is built
structurally: render N lines as plain blocks, then fold the remaining tail
into the expandable quote. This mirrors the official Telegram demo.

## 3. Pattern A — controlled preview lines (quotes 1–5)

To make a sequence of quotes that show 2, 3, 4, 5, 6 lines initially:

```html
<p>line 1</p>
<p>line 2</p>
<blockquote expandable>hidden line<br>another hidden line</blockquote>
```

The preview lines are plain blocks (`p`/`h2`), the tail is the quote. Each
quote needs *enough* tail content to overflow the collapsed height, or it will
render without the toggle. See `collapsedSectionHtml(section, previewCount)`
in `src/long-message.js` and the `PREVIEW_LINES = [2, 3, 4, 5, 6]` table.

## 4. Pattern B — the all-formattings showcase (quote 6)

A quote that "contains everything" must be split into a unit of two parts,
because half of the feature set only exists as block types:

1. **An inline-only expandable quote** — every category demonstrated in
   inline form, one labeled line per category.
2. **A `<details>` block right after it** — the block-only demos. Details
   blocks also expand/shrink on tap, so the whole unit stays interactive.
3. An anchor (`<a name="...">`) before the unit so the quote can jump-link to
   itself.

This is `showcaseSectionHtml()` in `src/showcase.js`; the same unit is reused
by the Long Message, Advanced and All Types screens.

### Category → tag reference

| Category | Inline (inside the quote) | Block-only (inside the details) |
|---|---|---|
| **Text Formatting** | `<b>` `<i>` `<u>` `<s>` `<tg-spoiler>` `<mark>` `<sub>` `<sup>` | — |
| **Code & Pre** | `<code>` inline code | `<pre><code class="language-js">` fenced blocks |
| **Structure** | bolded heading line, ❝ nested quotation ❞ glyph, `•`/`1.` list glyphs | `<h1>`–`<h6>`, `<blockquote>`, `<ul>`/`<ol>`, `<details><summary>`, `<a name>` anchors |
| **Links & Mentions** | `<a href="https://…">`, `mailto:`, `tel:`, `tg://user?id=…`; auto-detected URLs, emails, phones, hashtags, cashtags, commands | — |
| **Emoji, Dates & Math** | `<tg-emoji emoji-id="…">`, `<tg-time unix="…" format="…">`, `<tg-math>` inline math | `<tg-math-block>` block math |
| **Advanced** | — | `<table bordered>` (cells take inline content only), `<tg-reference name="…">` footnotes, `<aside>` pullquotes |
| **Buttons** | — | `<tg-button>` types/styles inside `<tg-button-row align="…">` |

Notes:

- `<tg-emoji>` needs `CUSTOM_EMOJI_IDS` in `.env` (and the bot owner to hold a
  Fragment username or Premium); without it, fall back to the plain emoji.
- `<tg-time format="r">` is relative ("2 months ago") — compute `unix` at
  build time, don't hardcode a drifting timestamp.
- Table cells accept inline formatting only; footnotes are
  `<a href="#name">[1]</a>` plus `<tg-reference name="name">…</tg-reference>`.

## 5. Pitfall checklist

1. **Nested block inside the quote** → API accepts it, client renders the
   quote permanently expanded. Keep quotes inline-only; move blocks to the
   `<details>` unit.
2. **Expecting a collapsed-height knob** → there isn't one; structure the
   preview outside the quote (Pattern A).
3. **Short quote** → if the content fits the collapsed height, no toggle
   appears. Give every expandable quote a real tail.
4. **Unescaped text** → escape every literal `& < > " '` with `escapeHtml`
   before embedding content lines; only the markup tags are real HTML.
5. **Stale bot process** → markup changes need a bot restart to take effect.
   A running bot serves the code loaded at startup.
6. **Verifying "expandable" from the API** → the send succeeding proves
   nothing about the toggle (see pitfall 1). Verify the structure offline
   (inline-only guard test) and visually in a client.

## 6. How this repo implements it

- `src/render/rich-text.ts` — `expandableQuote()` renders a post's whole body as the quote. It emits
  inline tags only and reuses the `inline()` escaper, so a heading, list or fence marker in the post
  can never reach Telegram as a block (pitfall 1).
- `src/pipeline/render-post.ts` — `richPlan()` puts that quote between the slideshow and the
  oversized-video links: nothing of the post is left outside it, and the client's collapsed height
  is the preview. Markup cannot pin it to five lines (pitfall 2).
- `src/render/caption.ts` — the rich header: the `<h3>` source line, and the bold time line whose
  label `relativeTime()` writes and `<tg-time format="r">` keeps current as the message ages.
- `test/unit/rich-render.test.ts` — pins the whole-body-in-the-quote layout, the 50-item list, the
  inline-only guard over the quote's content, and the empty-body case; `test/unit/rich-text.test.ts`
  pins the escaping and the marker flattening.
- `docs/adr/025-expandable-quote-layout.md` — why this replaced ADR-024's "Show more" button.
- After changing any markup: `npm run typecheck`, `npm test`, `npm run build`, then **restart the
  bot** — a running bot serves the code it loaded at startup.
