# ADR-008: Classic media + caption rendering, not rich messages

**Status:** Accepted (design) · 2026-10-29

## Context

Bot API 10.3 (2026-08-24) added `sendRichMessage`, which accepts HTML, Markdown or a block tree, with
media referenced as `tg://photo?id=…` / `tg://video?id=…` `[TG-CHANGELOG][TG-SENDRICH]`. That is the
closest thing to "looks exactly like the original post" the platform has ever offered.

Against it: the UI screens show ordinary media+caption bubbles (S3, S4), the feature is six weeks old,
and the project's hard constraint is a working free bot, not the most modern API surface.

## Options

| Option | Fidelity | Risk | Verdict |
|---|---|---|---|
| `sendPhoto`/`sendVideo`/`sendMediaGroup` + HTML caption | native bubble, exact media order | none, 10+ years stable | **Chosen** |
| `sendRichMessage` for every post | tables, quotes, collapsible blocks, mixed media | unknown client coverage, unknown rate/edit semantics, new failure modes | Rejected for MVP |
| Mixed: rich for articles, classic for media | marginal | two renderers to test | Rejected |
| Text + links only | poor | none | Rejected: violates the core promise |

## Decision

The renderer emits a `MessagePlan` of classic calls only (R1–R14 in §8.1). `sendRichMessage` is not used
anywhere in the MVP. The renderer is a pure function `(item, files, chat) -> MessagePlan`, so a future
`rich` renderer can be added behind a flag without touching the pipeline.

## Consequences

- Fidelity ceiling: Telegram HTML supports bold/italic/underline/strike/spoiler/code/pre/blockquote/links
  `[TG-API]`; it does not support CSS, custom fonts, grids or carousels. "Exactly like the original" is
  therefore not achievable, and the README must say so (OQ-6).
- Albums are capped at 10 items per call `[TG-MG]`; longer carousels become chained albums (R4).
- Captions cap at 1024 `[TG-MSG]`; overflow becomes a reply chain with `(2/3)` suffixes (§8.2).
- Revisiting rich messages after M7 is a contained experiment: one renderer, one ADR, no schema change.

## Evidence

`[TG-CHANGELOG]`, `[TG-SENDRICH]`, `[TG-API]`, `[TG-MG]`, `[TG-MSG]`, `UI-Refference/4. Add source menu 3*.png`.
