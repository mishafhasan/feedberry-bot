/**
 * The destination picker prefixes an icon by chat type, but `btn.personal` already carries its 👤 —
 * the doubled "👤 👤 Personal account" came from prefixing it again.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatRow } from '../../src/db/repos/chats.ts';
import { digestChatView } from '../../src/bot/screens/digest.ts';

const chat = (id: number, type: string, title: string | null): ChatRow => ({
  id,
  owner_user_id: 1,
  tg_chat_id: -100 - id,
  type,
  title,
  message_thread_id: null,
  can_post: 1,
  verified_at: null,
  rights_json: null,
});

const labels = (chats: ChatRow[]): string[] => digestChatView({ chats, lang: 'en' }).keyboard.inline_keyboard.flat().map((button) => button.text);

test('the destination picker prints one 👤 for the personal chat', () => {
  assert.deepEqual(labels([chat(1, 'private', null)]), ['👤 Personal account', '← Back']);
});

test('channels and groups keep their own icon', () => {
  assert.deepEqual(labels([chat(2, 'channel', 'News'), chat(3, 'group', 'Team')]), ['📢 News', '👥 Team', '← Back']);
});
