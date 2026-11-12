# ADR-024: "Show more" for long social posts

**Status:** Superseded by ADR-025 · 2026-11-12 · extended ADR-023

The button and its payload cache were retired one day later: a native `<blockquote expandable>` gives
the same tap-to-expand with no callback, no stored payload and no edit (ADR-025). This record stays
as the reasoning behind the preview budget (`truncateParagraphs`, now `splitPreview`) and the spike
that proved `editMessageText` accepts a rich message.

## Context

ADR-023 delivers every non-RSS post as one rich message with the whole body. That is right for a caption
and wrong for a 5,000-character thread or a 50-item list: the reader gets a wall of text and scrolls past
the media to find where the post starts. The product wants the first paragraphs with a button that
expands the same message in place.

Constraints that decided the design:

- A rich message has no `reply_markup` that clients honour (project's verified fact; the API echoes the
  object, but the in-message `buttons` block is the surface that is part of the content).
- Stage 9 deletes the downloaded media after delivery (`cleanupWorkDir`), so a later edit cannot re-upload
  files; it must reuse the `file_id`s the send returned.
- `callback_data` is 1–64 bytes; the full body cannot travel in it.
- `editMessageText` accepts an `InputRichMessage` and replaces the message's rich content in place.

## Spike (real Bot API, test bot)

| Case | What was tested | Result |
|---|---|---|
| A | `<tg-button-row>` with a callback button in the rich html | rendered as a `buttons` block with the `callback_data` (messages 1636/1638) |
| B | `reply_markup: InlineKeyboardMarkup` on `sendRichMessage` | the API echoed it, but client rendering is unproven and the project's verified fact says it is dropped |
| C | edit with `tg://photo` refs and no `media` | 400 `RICH_MESSAGE_PHOTO_INVALID` |
| D | edit re-uploading the `InputFile` | works, slideshow kept — impossible after stage 9 |
| E | edit without `reply_markup` | clears it |
| F | edit with the `file_id` from the send response | works, slideshow kept — **the delivery design** |

## Options

| Option | User result | Cost | Verdict |
|---|---|---|---|
| `reply_markup` inline keyboard | the exact button type requested | client support contradicted by our verified fact | Rejected |
| **in-message `<tg-button-row>` + `editMessageText` with `file_id`s** | a button that expands the same message, media kept | a process-local payload cache | **Chosen** |
| Native `<details>` expandable block | no callback at all | the button/edit UX the product asked for is missing; collapsed text is not searchable | Rejected |
| Send a second, full message on tap | no edit | two messages per post, violates "same message" | Rejected |
| Re-download the media on tap | same result | network on every tap, CDN URLs expire | Rejected |

## Decision

- Stage 6 returns `rich_more` when the body has more paragraphs than the preview: `{ html, fullHtml, media }`.
  `truncateParagraphs` keeps whole paragraphs only — up to two or about 240 characters, always including
  the paragraph that crosses the budget — so a cut never lands mid-sentence. A post that fits stays `rich`
  and gets no button.
- Stage 7 sends the preview plus one in-message button
  `<tg-button-row><tg-button type="callback_data" style="primary" data="more:<token>">Show more</tg-button></tg-button-row>`.
  A single-button row fills the message width and `style="primary"` paints it as the blue pill the product
  asked for. `more:` + 8 URL-safe characters is 13 bytes, far below the 64-byte cap.
- The send response carries the slideshow/audio blocks; the sender reads their `file_id`s (the largest photo
  size per item) and stores `{ fullHtml, media file_ids }` under the token. Stage 9 may then delete the files.
- The callback handler (`more:<token>`) answers the query, looks the payload up, and edits the message in
  place with `editMessageText(chat, message_id, { html: fullHtml, media: file_ids, skip_entity_detection: true })`.
  The full html has no button row, so the button disappears; header, time and slideshow stay because the
  slideshow is re-referenced by `file_id`. The edit goes through the same `run()` limiter; a `TG_PARSE`
  failure edits the plain text instead of leaving the message half broken.
- The expansion payload is process-local: TTL 24 h, cap 500 entries, oldest evicted. After a restart or
  expiry the tap answers "This post can no longer be expanded." and the preview stays.
  `shortcut:` upgrade to a stored payload when expansions must outlive a restart.
- Label is the English `Show more`: the render layer stays free of the bot layer's i18n; a localized label
  would need the locale threaded into stage 6.

## Consequences

- A long thread or list opens compact; one tap reveals the whole text without moving the message, and the
  message id, position and media survive.
- The expansion is one-way: the button is gone after the edit (the full html carries none).
- If Telegram omits a media attachment from the response, the stored refs are incomplete; the sender logs
  `more_media_refs_missing` and the edit may fail, leaving the preview intact — never a lost post.
- A message forwarded before the tap keeps the preview and its button; the token still resolves while the
  payload lives, so the receiving bot cannot expand it (the button belongs to this bot).
- Group and channel posts work: the callback carries the chat and message id, and the edit runs there.

## Evidence

`tmp/show-more-spike.mjs` + `tmp/show-more-spike-results.json` (cases A–F, messages 1636–1641);
`src/render/message-plan.ts` (`rich_more`), `src/render/rich-text.ts` (`truncateParagraphs`),
`src/telegram/api.ts` (`sendRichMore`, `expandMore`), `src/telegram/more.ts`, `src/bot/callbacks.ts`
(`more:` route), `test/unit/rich-render.test.ts`, `test/unit/rich-sender.test.ts`,
`test/integration/threads.test.ts`.