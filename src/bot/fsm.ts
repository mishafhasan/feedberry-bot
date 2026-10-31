import type { FeedItem } from '../platform/feed/native.ts';
import type { Platform, Strategy } from '../platform/registry.ts';

/**
 * In-memory FSM (ARCHITECTURE §7.1, OQ-15). Keyed by Telegram user id: a restart forgets
 * where a user was, which is safe because every screen can be re-rendered from the DB.
 */
export type FsmState = 'idle' | 'awaiting_source_link' | 'checking' | 'preview' | 'add_mode' | 'done' | 'error' | 'confirming_delete' | 'choosing';

/** What S4 showed, kept for 60 s so M3's add step does not refetch (plan §4 M2.5). */
export interface PendingSource {
  link: string;
  platform: Platform;
  canonicalUrl: string;
  externalId: string;
  feedUrl: string | null;
  strategy: Strategy;
  author: string;
  avatarUrl: string | null;
  items: FeedItem[];
  /** Author + item lines, reused by S5 so the caption does not have to be rebuilt. */
  bodyText: string;
  /** S4 was sent as a photo, so S5/S6 must edit a caption rather than text. */
  photo: boolean;
  at: number;
}

export type LastError = { kind: 'source'; link: string } | { kind: 'download'; link: string } | { kind: 'chat'; tgChatId: number };

/** S7 is one message, edited in place; its id is kept so a refresh can reuse it. */
export interface S7State {
  headerId: number | null;
  page: number;
  platform: string | null;
}

export interface Session {
  state: FsmState;
  /** awaiting_source_link in Download Mode (ADR-013); unused until M5. */
  mode?: 'download';
  pending?: PendingSource;
  /** The chat chosen on S4, kept until the add finishes. */
  destChatId?: number;
  error?: LastError;
  s7?: S7State;
  /** A post link pasted outside a flow, waiting on the download/add choice. */
  chooser?: { link: string };
}

export const PREVIEW_TTL_MS = 60_000;

const sessions = new Map<number, Session>();

export function getSession(userId: number): Session {
  return sessions.get(userId) ?? { state: 'idle' };
}

export function setSession(userId: number, patch: Partial<Session>): Session {
  const next: Session = { ...getSession(userId), ...patch };
  sessions.set(userId, next);
  return next;
}

/** Returns the cached preview only while it is fresh. */
export function freshPending(userId: number, now = Date.now()): PendingSource | undefined {
  const pending = getSession(userId).pending;
  return pending && now - pending.at < PREVIEW_TTL_MS ? pending : undefined;
}

export function resetSession(userId: number): void {
  sessions.delete(userId);
}
