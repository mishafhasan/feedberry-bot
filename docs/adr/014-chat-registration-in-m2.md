# ADR-014: Register and verify chats in M2, not M9

**Status:** Accepted · 2026-10-31 · **Supersedes:** the M9 scope in ARCHITECTURE §14

## Context

ARCHITECTURE §14 puts "admin verification at add" in M9. But M2's deliverable is S4, and S4 renders the
destination list from `chats` rows with `can_post = 1` (§7.3). §12.3 is stronger still: the bot MUST verify
admin/post rights **before registering a chat**.

Keeping §14 as written means M2 through M8 have no verified chat to show: S4 lists only "Personal account",
and the first time a channel can be added is the second-to-last milestone. That inverts the dependency the
architecture itself declares.

## Options

| Option | Effect | Verdict |
|---|---|---|
| Keep admin verification in M9 | S4's destination list is unusable for 7 milestones; §12.3 violated in every earlier build | Rejected |
| Verify in M2, keep forum-topic handling in M9 | chat rows exist but topic rows do not; a forum delivery would post to the General topic silently | Rejected: wrong target, silent |
| **Move chat registration, verification and `message_thread_id` capture into M2** | S4's list is real from M2 onward; M9 keeps deployment and hardening | **Chosen** |
| Stub the list with unverified chats | violates §12.3 and invites failed deliveries | Rejected |

## Decision

M2 owns:

- `my_chat_member` updates (`allowed_updates` per ADR-003) plus the "Personal account" row for DMs.
- `getChat` then `getChatMember(bot)`; a channel qualifies only with `status = administrator` **and**
  `can_post_messages = true`; a group/supergroup qualifies with `status = administrator` `[TG-ADMIN]`.
- `chats` upsert with `UNIQUE(tg_chat_id, message_thread_id)`; `message_thread_id` is captured at
  registration for forum topics (OQ-9: pick an existing topic, never auto-create).
- `E_BOT_NOT_ADMIN` in the §11 error map, rendered with `[🔁 Retry] [← Back]`.

M9 keeps: compose topology, runbook, backup/restore drill, credential audit (confirm none are stored) and quota audit, deployment smoke. Its old
verification ("refuse a channel where it is not admin") moves to M2; M9's new verification is the fresh-host
deploy.

## Consequences

- M2 grows by roughly one handler plus two API calls; M9 shrinks by the same.
- A chat can be revoked at any time; §12.3's re-check on `403` stays a M8/M9 concern, not M2's.
- The `chats` table is written from M2, so M3's S7 (which joins subscriptions) and M4's delivery target both
  have valid rows. No milestone after M2 needs a chat-registration retrofit.
- Forum-topic support is no longer a deployment concern; a topic row is just a chat row with a thread id.

## Evidence

ARCHITECTURE §7.3, §12.3; `[TG-ADMIN]`, `[TG-GETCHAT]`, `[TG-MSG]`; ADR-003.
