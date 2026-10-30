/**
 * In-memory FSM (ARCHITECTURE §7.1, OQ-15). Keyed by Telegram user id: a restart forgets
 * where a user was, which is safe because every screen can be re-rendered from the DB.
 */
export type FsmState = 'idle' | 'awaiting_source_link' | 'error' | 'confirming_delete';

export interface Session {
  state: FsmState;
  /** awaiting_source_link in Download Mode (ADR-013); unused until M5. */
  mode?: 'download';
}

const sessions = new Map<number, Session>();

export function getSession(userId: number): Session {
  return sessions.get(userId) ?? { state: 'idle' };
}

export function setSession(userId: number, patch: Partial<Session>): Session {
  const next: Session = { ...getSession(userId), ...patch };
  sessions.set(userId, next);
  return next;
}

export function resetSession(userId: number): void {
  sessions.delete(userId);
}
