import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Update } from 'grammy/types';

/** One recorded Bot API call, with the JSON body the bot sent. */
export interface Call {
  method: string;
  body: Record<string, any>;
}

/** getChat / getChatMember fixture keyed by chat id. */
export interface FakeChat {
  chat: Record<string, any>;
  member: Record<string, any>;
}

export interface FakeApi {
  apiRoot: string;
  calls: Call[];
  last(method: string): Call | undefined;
  callsSince(mark: number): Call[];
  close(): Promise<void>;
}

export const BOT_USER = { id: 999, is_bot: true, first_name: 'FeedBerry', username: 'feedberry_bot' };

/** Fake Bot API: records calls, answers from fixtures, never touches the network. */
export async function fakeBotApi(chats: Record<number, FakeChat> = {}): Promise<FakeApi> {
  const calls: Call[] = [];
  let messageId = 100;

  const resultFor = (method: string, body: Record<string, any>): unknown | { __error: string } => {
    switch (method) {
      case 'getMe':
        return { ...BOT_USER, can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false };
      case 'getChat': {
        const entry = chats[Number(body.chat_id)];
        return entry ? entry.chat : { __error: 'Bad Request: chat not found' };
      }
      case 'getChatMember': {
        const entry = chats[Number(body.chat_id)];
        return entry ? entry.member : { __error: 'Bad Request: chat not found' };
      }
      case 'answerCallbackQuery':
      case 'deleteMessage':
        return true;
      case 'sendMessage':
      case 'editMessageText':
      case 'sendPhoto':
        return { message_id: ++messageId, date: 0, chat: { id: Number(body.chat_id), type: 'private' } };
      default:
        return true;
    }
  };

  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const method = new URL(req.url ?? '/', 'http://localhost').pathname.split('/').pop() ?? '';
      const body = raw ? JSON.parse(raw) : {};
      calls.push({ method, body });
      const result = resultFor(method, body) as { __error?: string };
      res.setHeader('content-type', 'application/json');
      res.end(
        result.__error
          ? JSON.stringify({ ok: false, error_code: 400, description: result.__error })
          : JSON.stringify({ ok: true, result }),
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    apiRoot: `http://127.0.0.1:${port}`,
    calls,
    last: (method) => calls.filter((c) => c.method === method).at(-1),
    callsSince: (mark) => calls.slice(mark),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const PRIVATE_CHAT = (userId: number) => ({ id: userId, type: 'private' });
const FROM = (userId: number) => ({ id: userId, is_bot: false, first_name: 'Tester' });

export function startUpdate(updateId: number, userId: number): Update {
  return {
    update_id: updateId,
    message: {
      message_id: 1,
      date: 0,
      chat: PRIVATE_CHAT(userId),
      from: FROM(userId),
      text: '/start',
      entities: [{ type: 'bot_command', offset: 0, length: 6 }],
    },
  };
}

export function textUpdate(updateId: number, userId: number, text: string): Update {
  return {
    update_id: updateId,
    message: { message_id: 2, date: 0, chat: PRIVATE_CHAT(userId), from: FROM(userId), text },
  };
}

export function callbackUpdate(updateId: number, userId: number, data: string, chatId = userId): Update {
  return {
    update_id: updateId,
    callback_query: {
      id: `cb${updateId}`,
      from: FROM(userId),
      chat_instance: 'ci',
      data,
      message: { message_id: 42, date: 0, chat: { id: chatId, type: chatId === userId ? 'private' : 'channel' } },
    },
  };
}

export function chatMemberUpdate(updateId: number, userId: number, chatId: number, status: string, type = 'channel', title = 'Chat'): Update {
  return {
    update_id: updateId,
    my_chat_member: {
      chat: { id: chatId, type, title },
      from: FROM(userId),
      date: 0,
      old_chat_member: { status: 'left', user: BOT_USER },
      new_chat_member: { status, user: BOT_USER },
    },
  } as Update;
}
