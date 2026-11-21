# ADR-032: A Facebook post permalink carries its album, and the feed is the fallback

**Status:** Accepted · 2026-11-21 · amends ADR-030 §Decision (the feed-photo fallback is not
Instagram-only) and ADR-031 (a Facebook post has an engine extractor; the bot still holds no session)

## Context

Facebook `/<page>/posts/pfbid…` links arrived as a bare link with no media. Measured live on
2026-11-21 from this host:

- `resolve()` answers `error.link.unsupported` for that form: `services.facebook` has no `posts`
  pattern, so the engine hands the link to the generic web extractor. That extractor reads
  `og:image` and the page's `og:description`, so a multi-photo post would ship one picture, and a
  text-less post would print the page's blurb.
- The same permalink, fetched anonymously with a Chrome UA and `sec-fetch-*: navigate`, answers
  **200 / 752 KB**. It carries the post as 51 `<script type="application/json" data-sjs>` blobs:
  `post_id`, `creation_time`, `permalink_url`, `actors[0].name`, and the photo under
  `attachments[].styles.attachment.media.photo_image.uri` (single) or
  `attachments[].all_subattachments.nodes[].media` (album). An album's nodes and an attached
  story are the same `Photo`/`Video` shapes RSSHub's own Facebook reader consumes.
- Facebook does not 404 an unknown pfbid: it serves the page's **latest** post and says so in
  `permalink_url`. A parser that takes the first story silently ships a different post.
- `stp`/`cstp`/`ctp` sit inside the URL's `oh=` signature: removing them answers **403**, and the
  path-size rewrite changes nothing. The rendered `photo_image` is what ships.
- The RSSHub `/facebook/page/:id` route renders one `<img>` per photo and one `<video>` per clip
  into `description`, which `mediaOf()` already turns into `payload.media`. It answers
  `Facebook GraphQL failed: Rate limit exceeded` from this host even with `FACEBOOK_COOKIE` set in
  the sidecar, so the feed rung is only as alive as that session.
- ADR-031 rejected "give the bot a Facebook cookie and write a story extractor" on the ground that
  no extractor existed to justify the credential. The payload is reachable anonymously, so the
  extractor needs no cookie; the bot still does not read `FACEBOOK_COOKIE`.

## Options

| Option | User result | Cost | Verdict |
|---|---|---|---|
| Keep ADR-031's "a Facebook story has no media" | the reported links stay bare links | none | Rejected: measured, the document carries the album |
| Give the bot `FACEBOOK_COOKIE` (the plan's Phase 4) | media also for login-walled posts | reverses ADR-006 and ADR-017's precedent with no measured gain | Rejected |
| A `src/`-only page adapter (the plan's Phase 3) | the album for a pasted link | a third Facebook parser beside the engine and `page-text.ts` | Rejected: ADR-028, one pipeline one parser |
| **An engine extractor for `posts/<id>` and the feed's photos as both doors' fallback** | the album in both doors | ~60 lines in the vendored engine plus one shared rule | **Chosen** |

## Decision

- **`facebook.com/<page>/posts/<id>` is a supported form.** `services.facebook` gains
  `:username/posts/:postId`, and `testers.facebook` accepts a `postId` of 80 characters or fewer.
  `story.php`/`permalink.php` stay on the feed rung, because neither has an anonymous extractor rung:
  `story.php?story_fbid=` answers 404 without the page `id`, and `permalink.php?story_fbid=…&id=…`
  redirects to `/login/`. `cleanURL()` also drops their query before any pattern could see it.
- **The extractor reads the document's own JSON, not its meta tags.** It parses the `data-sjs`
  blobs and merges every node stating the same `post_id` — the permalink, the words and the
  attachments arrive in different copies of one post — then keeps the post the document's own
  `og:url` names, so a post the page merely recommends is never the answer. The pfbid in the link is
  **not** compared: measured, Facebook re-encodes it in the canonical permalink (`pfbid0Kjy…` →
  `pfbid02P7Lz…`, same numeric post), and the requested id is echoed in the raw document even when
  Facebook ignored it, so no client-side comparison separates a re-encoded id from an unknown one.
- **Media is every `Photo`/`Video` node under the story's `attachments` and an attached story's,
  in document order, deduped.** Photos read `photo_image.uri`, then `image.uri`, then
  `large_share_image.uri`; videos read `browser_native_hd_url`, then `browser_native_sd_url`, then
  `playable_url`. One item returns the photo or video shape, several a picker. URLs ship verbatim:
  the signature forbids stripping the size parameters `getPhoto()` strips on a different URL shape.
- **`MEDIA_FROM_FEED` replaces ADR-030's hard-coded `instagram` check.** Both doors ship the feed's
  photos when the feed carries **more** than the extractor did. `>` and not `=== 0`, because the
  generic extractor answers a single `og:image`; ADR-030's R14 still holds, since a feed photo
  never replaces a working clip, and a video post's feed description carries no `<img>` at all.
- **The paste door asks the account's feed when a listed platform yielded at most one item** — the
  same "it can add something" test ADR-031 gave Instagram. The schedule pays nothing extra.
- **The engine may hold a Facebook session; the bot may not.** `cookie-store.js` accepts a
  `facebook` service for a standalone engine user and refreshes a rotated `c_user`/`xs` pair.
  `config.ts`, `main.ts` and compose are untouched, so ADR-006 and ADR-017 stand.

## Consequences

- A scheduled or pasted Facebook post ships its album as a `<tg-slideshow>`: the extractor when
  Facebook answers, the RSSHub feed when it does not.
- A text-less post still prints the page's own `og:description` ("171,640 followers · …") as its body
  on the paste door, and the feed's title on the schedule. Both predate this ADR and are unchanged:
  `page-text.ts` has no post-versus-page test for a Facebook document.
- Every album item lands in its own file. The engine names every photo `media-photo.jpg`, and a
  sniffed extension rename handed the same name back, so item 2 overwrote item 1 and the album
  showed one picture N times. The rename now asks `uniquePath`; Instagram and Threads carousels
  were silently hit by the same bug.
- A link Facebook no longer serves gets what Facebook answers for it: measured, the page's latest
  post. That is Facebook's own reply to the URL, and it is the price of not rejecting every real
  link whose pfbid was re-encoded. Only a document with no post node at all is
  `content.post.unavailable`.
- The shipped picture is Facebook's rendered `photo_image` (552×414 on the measured post), not the
  original: the signature gives no cheaper upgrade.
- `story.php`/`permalink.php` links keep the feed rung, so their album arrives when the sidecar's
  session does.
- A pasted single-photo Instagram or Facebook post costs one extra feed request; a scheduled one
  costs none.
- The feed rung is only as alive as the sidecar's Facebook session: today this host gets
  `Rate limit exceeded`, so the extractor is the rung that answers.

## Evidence

- `node cobalt-engine/bin/cobalt-engine.mjs '<posts link>'` → `error.link.unsupported` (`service: web`).
- The 752 KB anonymous document: 51 `data-sjs` blobs, one story node with
  `post_id: 1447865554149666`, `creation_time: 1793798512`,
  `permalink_url: …/posts/pfbid0WjkpEXQ…`, and its photo at
  `attachments[0].styles.attachment.media.photo_image.uri` (`ctp=p552x414`, 552×414).
- A fabricated pfbid answered the page's latest post, with a `permalink_url` of its own — which is
  indistinguishable from the re-encoding above, and the reason the id is no longer compared.
- The three reported links: each requested pfbid differs from the canonical `permalink_url`
  (`pfbid0Kjy…` → `pfbid02P7Lz…`, `pfbid0665…` → …), while `og:url` names one numeric post id
  (`…/left/1668138432022246/`). The requested id appears in the raw document even for a fabricated
  one, so an inclusion test proves nothing and an equality test rejects every real link (the first
  shipped build did exactly that).
- In the same document the focal story node carries `permalink_url` and `attachments` with
  `message: null`, while a sibling node with the same `post_id` carries the 1152-character text —
  reading one node shipped a truncated caption. Each album photo is a `Photo` node with
  `image.uri` (not `photo_image.uri`) under `all_subattachments.nodes[].media`.
- After the fix: all three links resolve `type: "picker"` with five photos, and the paste door
  renders 1207 / 3923 / 1016 characters of body text with five images each.
- Before the download fix, the same five photos all landed on `media-photo_1.jpg` (41,791 / 34,717 /
  49,555 / 46,327 / 40,748 B, five different hashes, one path); after it they land on
  `media-photo_1.jpg` … `media-photo_1 (4).jpg`, each with its own hash.
- `story.php?story_fbid=<real pfbid>` answers **404 in 9 bytes** on `www`, `m` and `web`; the same id
  through `permalink.php?story_fbid=…&id=100067787065231` redirects to `/login/` (383 KB of login
  shell, no `og:*`, no `data-sjs`). Those two forms have no anonymous rung.
- fbcdn ranged GETs: as-is `200 image/jpeg 34,237 B`; without `stp` `403`; without `cstp`/`ctp`
  `403`; without the `/p\d+x\d+/` path rewrite `200 image/jpeg 34,237 B`.
- RSSHub `GET /facebook/page/NASA` and `/facebook/page/TrollMafia01` → `503 Facebook GraphQL
  failed: Rate limit exceeded`; the route source renders `<img src="${photo_image.uri}">` per
  attachment and `<video src="${browser_native_hd_url ?? browser_native_sd_url}">` per clip.
- `test/unit/facebook-post.test.ts` (split nodes merged, `og:url` selection, single photo, video),
  the registry cases, and `cobalt-engine/test/smoke.mjs` for the URL forms.
