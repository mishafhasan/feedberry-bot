import type { Db } from '../index.ts';

export interface ChatRow {
  id: number;
  owner_user_id: number;
  tg_chat_id: number;
  type: string;
  title: string | null;
  message_thread_id: number | null;
  can_post: number;
  verified_at: number | null;
  rights_json: string | null;
}

export interface ChatInput {
  ownerUserId: number;
  tgChatId: number;
  type: string;
  title: string | null;
  messageThreadId: number | null;
  canPost: boolean;
  verifiedAt: number;
  rightsJson: string | null;
}

/** The DM target is always available, so S4 can always offer "Personal account". */
export function ensurePrivateChat(db: Db, ownerUserId: number, tgUserId: number, now = Date.now()): ChatRow {
  return upsertChat(db, {
    ownerUserId,
    tgChatId: tgUserId,
    type: 'private',
    title: null,
    messageThreadId: null,
    canPost: true,
    verifiedAt: now,
    rightsJson: null,
  });
}

/** One row per (chat, topic): the expression index makes a NULL thread a single row too. */
export function upsertChat(db: Db, input: ChatInput): ChatRow {
  const existing = db
    .prepare('SELECT * FROM chats WHERE tg_chat_id = ? AND COALESCE(message_thread_id, 0) = ?')
    .get(input.tgChatId, input.messageThreadId ?? 0) as unknown as ChatRow | undefined;

  if (existing) {
    db.prepare('UPDATE chats SET can_post = ?, verified_at = ?, rights_json = ?, title = ?, owner_user_id = ? WHERE id = ?').run(
      input.canPost ? 1 : 0,
      input.verifiedAt,
      input.rightsJson,
      input.title,
      input.ownerUserId,
      existing.id,
    );
    return { ...existing, can_post: input.canPost ? 1 : 0, verified_at: input.verifiedAt, rights_json: input.rightsJson, title: input.title };
  }

  const row = db
    .prepare(
      `INSERT INTO chats (owner_user_id, tg_chat_id, type, title, message_thread_id, can_post, verified_at, rights_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(
      input.ownerUserId,
      input.tgChatId,
      input.type,
      input.title,
      input.messageThreadId,
      input.canPost ? 1 : 0,
      input.verifiedAt,
      input.rightsJson,
    ) as unknown as ChatRow;
  return row;
}

/** S4's destination list: verified chats only (ADR-014). */
export function destinations(db: Db, ownerUserId: number): ChatRow[] {
  return db
    .prepare("SELECT * FROM chats WHERE owner_user_id = ? AND can_post = 1 AND type <> 'private' ORDER BY COALESCE(title, tg_chat_id)")
    .all(ownerUserId) as unknown as ChatRow[];
}

export function personalChat(db: Db, ownerUserId: number): ChatRow {
  return db.prepare("SELECT * FROM chats WHERE owner_user_id = ? AND type = 'private' ORDER BY id LIMIT 1").get(ownerUserId) as unknown as ChatRow;
}

/** A 403 at delivery demotes, it never deletes (§12.3). */
export function demoteChat(db: Db, tgChatId: number): void {
  db.prepare('UPDATE chats SET can_post = 0 WHERE tg_chat_id = ?').run(tgChatId);
}

export function findChat(db: Db, tgChatId: number): ChatRow | undefined {
  return db.prepare('SELECT * FROM chats WHERE tg_chat_id = ? ORDER BY id LIMIT 1').get(tgChatId) as unknown as ChatRow | undefined;
}

/** OQ-9: a topic is only listed once a verified chat row exists — topics are never auto-created. */
export function captureTopic(db: Db, tgChatId: number, messageThreadId: number): void {
  const base = findChat(db, tgChatId);
  if (!base || base.can_post !== 1) return;
  upsertChat(db, {
    ownerUserId: base.owner_user_id,
    tgChatId,
    type: base.type,
    title: base.title,
    messageThreadId,
    canPost: true,
    verifiedAt: base.verified_at ?? Date.now(),
    rightsJson: base.rights_json,
  });
}
