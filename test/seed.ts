import type { Db } from '../src/db/index.ts';
import { ensureUser, setUserStatus } from '../src/db/repos/users.ts';

/**
 * Milestone tests drive the bot as a user the operator has approved. The allowlist itself is
 * tested in access.test.ts; every other test only needs the gate to open.
 */
export function allowUser(db: Db, tgUserId: number): void {
  ensureUser(db, tgUserId);
  setUserStatus(db, tgUserId, 'allowed');
}
