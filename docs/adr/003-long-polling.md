# ADR-003: Long polling instead of webhooks

**Status:** Accepted (design) · 2026-10-29

## Context

The bot must receive updates both when idle and during heavy work. Webhooks need a public HTTPS endpoint
on one of the supported ports and a valid certificate `[TG-WEBHOOK]`; the primary host (ADR-010) is a
home device behind NAT. Long polling and webhooks are mutually exclusive `[TG-FAQ]`.

## Options

| Option | Requires | Verdict |
|---|---|---|
| Long polling (`getUpdates`, 25 s timeout) | outbound HTTPS only | **Chosen** |
| Webhook on the Pi | public IP, DNS, TLS cert, reverse proxy, open port | Rejected for primary; documented as the serverless/webhook variant |
| Webhook behind Cloudflare Tunnel (free) | tunnel process + certificate + one more moving part | Rejected: extra component for no functional gain |
| Hybrid (switch at runtime) | two code paths, `setWebhook`/`deleteWebhook` state machine | Rejected |

## Decision

grammY runner with long polling, `allowed_updates` limited to `message`, `callback_query`,
`my_chat_member` (the last one is how a channel/group kick is noticed). `drop_pending_updates=false` so
restarts do not silently lose taps; a burst after downtime is scanned for the newest callback only.

## Consequences

- No inbound port, no TLS, no DNS, works on CGNAT. Idle cost = one request per 25 s, negligible `[assumption]`.
- Updates cannot be acknowledged selectively; a crash mid-handler replays the update. All handlers are
  therefore idempotent (callbacks act on current DB state, not on a captured one).
- Porting to a webhook host (e.g. a free PaaS that requires it) is a one-file change: grammY's
  `webhookCallback` replaces the runner; the FSM and pipeline are untouched.

## Evidence

`[TG-WEBHOOK]`, `[TG-FAQ]`.
