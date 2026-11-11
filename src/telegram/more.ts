import { randomBytes } from 'node:crypto';
import type { MediaKind } from '../render/message-plan.ts';

/** ADR-024: what "Show more" edits with — the full body plus the file_ids Telegram assigned on send. */
export interface MorePayload {
  html: string;
  media: Array<{ id: string; kind: MediaKind; fileId: string }>;
}

/**
 * Stage 9 deletes the downloaded files, so the edit cannot re-upload; it reuses the file_ids the send
 * returned. That payload lives in memory only: a restart (or the TTL) loses it and the tap answers so.
 * shortcut: process-local map capped at 500 — upgrade to a store when expansions must outlive a restart.
 */
const TTL_MS = 24 * 60 * 60 * 1000;
const CAP = 500;
const saved = new Map<string, { payload: MorePayload; at: number }>();

/** 8 URL-safe bytes, so `more:<token>` stays far below the 64-byte callback_data cap. */
export function moreToken(): string {
  return randomBytes(6).toString('base64url');
}

export function rememberMore(token: string, payload: MorePayload): void {
  saved.set(token, { payload, at: Date.now() });
  while (saved.size > CAP) {
    const oldest = saved.keys().next().value;
    if (oldest === undefined) break;
    saved.delete(oldest);
  }
}

export function morePayload(token: string): MorePayload | undefined {
  const entry = saved.get(token);
  if (entry === undefined) return undefined;
  if (Date.now() - entry.at > TTL_MS) {
    saved.delete(token);
    return undefined;
  }
  return entry.payload;
}