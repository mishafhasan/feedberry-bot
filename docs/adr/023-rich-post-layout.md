# ADR-023: Non-RSS posts arrive as one rich message

**Status:** Accepted · 2026-11-11 · amends ADR-008, ADR-012, ADR-022 for non-RSS sources · header, time and long-body layout amended by ADR-025

## Context

A social post (X, Instagram, Threads, TikTok, Tumblr, YouTube community, Facebook, Bluesky, Snapchat,
Pinterest) used to ship as the classic layout: a media message or `sendMediaGroup`, a caption capped at
1024 characters, the tail split into `(1/2)` reply-chained texts, and — past the caption limit — a
Telegra.ph page behind `👉🏻 Read more`. A carousel became several attached messages; a long post became
a stub plus a link off-platform.

Bot API 10.1 added rich messages (`sendRichMessage`): one message carries up to 32,768 characters of
text, 50 media attachments, and an in-message slideshow (`RichBlockSlideshow`). That is enough to hold a
whole social post — header, time, every photo/video, and the full text — in a single forwardable message.

RSS feeds and blog/website posts are different: they are articles, read in Instant View (ADR-007), and
their classic layout is unchanged.

## Options

| Option | User result | Cost | Verdict |
|---|---|---|---|
| Keep the classic layout for social posts | split captions, attached albums, Read more | 0 | Rejected: the post is fragmented |
| Rich message, hotlinked platform CDN URLs | one message, but media Telegram must fetch | 0 | Rejected: platform CDNs are signed and expire; hotlink refusal is per-platform |
| Rich message, `blocks` mode + `attach://` upload | one message, uploaded media | a RichText tree per text run | Rejected: more code than html for the same result |
| **Rich message, `html` mode + `media[]` `tg://` refs, uploaded files** | one message, uploaded media, full text | one `sendRichMessage` | **Chosen** |

## Decision

- Every non-RSS post — scheduled/auto-check **and** Download Mode — is one `MessagePlan` of kind `rich`
  (`{ html, media[] }`). Stage 6 produces data; stage 7 (`TelegramSender.sendRich`) wraps each local file
  in `InputFile` and calls `sendRichMessage` through the same `run()` limiter, returning one `message_id`.
- The layout, in order: `{platformIcon} <a href="post URL">SourceName</a> | SourceType`; `⏱️ Time: DD/MM
  HH:MM` in the reader's zone; a `<tg-slideshow>` of the post's sendable photos/videos/animations (≤50);
  the post's own words, escaped, original line breaks kept; then one `🎬 <a href="direct URL">Video n</a>`
  line per video that cannot upload. No media → header + time + text, still one message.
- Media uploads as local files via `media[]` + `tg://photo?id=` / `tg://video?id=` refs (spike case B).
  grammY's multipart collector walks the payload and uploads each `InputFile` as `attach://`. Audio cannot
  ride in a slideshow (Telegram hoists it out, spike case B2), so it stands as its own `<audio>` block.
- `skip_entity_detection: true` always. Source captions are full of bare URLs, @handles, #hashtags,
  $cashtags, /commands and phone numbers; auto-detection would turn them into wrong links (spike case D).
  Only the `<a href>` links the renderer builds are links.
- Telegram collapses a raw newline inside `<p>` to a space (spike case B), so every source line break —
  including the one between the header and the time line — is emitted as `<br/>`.
- The header is produced once by `postHeader({ rich: true })`, which leads with `platformIcon()` and prints
  the day first (`ddmmhhmm`). The icons moved from `src/bot/texts.ts` to `src/platform/icons.ts` so the
  render layer can use them without importing the bot layer; `texts.ts` re-exports the one producer.
- `users.tz` is plumbed into delivery: `deliveryTargets` selects `u.tz`, the scheduled renderer and Download
  Mode pass it to `postHeader`. It defaults to `UTC` and is set today only by a manual
  `UPDATE users SET tz = '<IANA zone>' WHERE tg_user_id = <id>`; there is no bot UI for it (no country→zone
  guess is invented).
- Over 32,768 characters the body is clamped at a word boundary with `…` and logged (`rich_clamped`).
  `shortcut:` upgrade when a real source exceeds it. Media past 50 attachments is dropped (`shortcut:`).
- `withReadMore` returns a rich plan untouched — the Telegraph path stays for RSS/blog. The duration rule
  (R6/R8) and stand-in frames (R15/ADR-022) are RSS-only now: a non-RSS post returns before them, so a frame
  never leaks into the slideshow and an oversized video keeps its `🎬` link instead of a frame.
- The `E.TG_PARSE` fallback still applies: a rich message Telegram cannot parse is resent as plain text
  (`parse_mode` removed), never dropped. `deliveries.parts` records the real message count (one).

## Rich text (source → HTML)

Social captions arrive as plain text, so `src/render/rich-text.ts` turns their own conventions into
the Telegram rich HTML tags. Every other character is escaped; nothing is auto-detected.

| Source | Output |
|---|---|
| `# ` … `###### ` at line start | `<h1>` … `<h6>` (h2–h6 read as subheadings) |
| `> ` line / `>> ` deeper run | `<blockquote>`, nested by depth; consecutive lines join with `<br/>` |
| ` ``` ` fence (optional language) | `<pre>` / `<pre><code class="language-x">`, content escaped, never styled |
| `- `, `* `, `• ` | `<ul><li>`, deeper indent nests inside the item above |
| `1. `, `1) ` | `<ol><li>`; the client prints the numbers, deeper indent nests |
| blank line between prose lines | a new `<p>` per paragraph (line breaks inside one stay `<br/>`) |
| `**b**`, `__b__` | `<b>` |
| `*i*`, `_i_` | `<i>` (the `_` form only outside words) |
| `++u++` | `<u>` (Telegram markdown has no underline; this is the house marker) |
| `~~s~~`, `||spoiler||`, `==marked==` | `<s>`, `<tg-spoiler>`, `<mark>` |
| `` `code` `` | `<code>` |
| `[label](url)` | `<a href>` only for http(s), mailto and tel; the label stays literal text |
| bare `https://…`, `a@b.com`, `+8801712345678` | our own `<a href>`, `mailto:`, `tel:` (trailing punctuation stays out) |
| `![alt](tg://emoji?id=…)` | `<tg-emoji emoji-id>` |
| `![text](tg://time?unix=…&format=…)` | `<tg-time unix format>` (client-local date/time) |

Safety: the formatter never passes source HTML through — `<script>` and friends stay literal text —
and an href is protocol-checked and quote-encoded before it is written. `skip_entity_detection`
remains true, so Telegram adds no link of its own. `shortcut:` emphasis does not nest and a marker
inside a link label prints literally; upgrade when a real source needs nested styling.

## Consequences

- A social post is one forwardable message that keeps its whole text and its media together; forwarding
  preserves every block (spike, all cases).
- The classic album/video/read-more code stays reachable for RSS posts whose article extraction fails
  (thin or paywalled pages, blog enclosures), so ADR-012/022 still hold there.
- Custom-emoji platform logos render only while the bot's owner holds Premium and the bot owns the emoji
  set; otherwise Telegram strips the tag to the plain emoji fallback (spike case E). The layout degrades
  gracefully, exactly as the existing `platformIcon` shortcut comment predicts.
- An oversized video is still downloaded before it is withheld (ADR-022's bandwidth note stands); the rich
  path simply links it instead of framing it. **Amended by ADR-026**: a non-RSS clip is measured with a
  ranged request and never downloaded when it cannot upload, and X/YouTube step 1080 → 720 → 480 first.
- A failed media download keeps its `🎬` link when the engine gave a URL (R15), so a stalled transfer is
  still not a lost post.

## Evidence

Live spike against the real Bot API with a throwaway test bot (`tmp/rich-spike.mjs`,
`tmp/rich-spike-results.json`): A hotlink slideshow `message_id=1500`; B html+`media[]` upload
`message_id=1502` (photo+video+animation slideshow, `<br/>` survives, raw `\n` collapses); B2 audio hoisted
`message_id=1504`; C blocks `attach://` `message_id=1506`; D entity detection on/off `1508`/`1510`; E custom
emoji stripped `1512`. Every case survived forwarding. `[TG-RICH]`
https://core.telegram.org/bots/api#rich-message-limits, `node_modules/@grammyjs/types/rich.d.ts`,
`src/render/message-plan.ts`, `src/telegram/api.ts`, `src/pipeline/render-post.ts`.