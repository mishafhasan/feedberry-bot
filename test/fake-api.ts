import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Chat, Update } from 'grammy/types';

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
export async function fakeBotApi(chats: Record<number, FakeChat> = {}, options: { fail429Once?: number; forbidChat?: number; failParseOnce?: boolean } = {}): Promise<FakeApi> {
  const calls: Call[] = [];
  let messageId = 100;
  let floodPending = options.fail429Once !== undefined;
  let parsePending = options.failParseOnce === true;

  const resultFor = (method: string, body: Record<string, any>): unknown | { __error: string } => {
    if ((method === 'sendMessage' || method === 'sendRichMessage') && parsePending) {
      parsePending = false;
      return { __error: "Bad Request: can't parse entities: Unsupported start tag" } as never;
    }
    if (method === 'sendMessage' && floodPending) {
      // §9.2 fixture: the first send is flood-limited, retry_after is in seconds.
      floodPending = false;
      return { __error: `Too Many Requests: retry after ${options.fail429Once}`, __retryAfter: options.fail429Once } as never;
    }
    if (method === 'sendMessage' && options.forbidChat !== undefined && Number(body.chat_id) === options.forbidChat) {
      // §12.3 fixture: the bot was removed from this chat.
      return { __error: 'Forbidden: bot was kicked from the channel', __status: 403 } as never;
    }
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
      case 'sendRichMessage':
      case 'editMessageText':
      case 'sendPhoto':
        return { message_id: ++messageId, date: 0, chat: { id: Number(body.chat_id), type: 'private' } };
      case 'sendMediaGroup': {
        // The API answers with one Message per media item.
        const count = Array.isArray(body.media) ? body.media.length : 1;
        return Array.from({ length: count }, () => ({ message_id: ++messageId, date: 0, chat: { id: Number(body.chat_id), type: 'private' } }));
      }
      default:
        return true;
    }
  };

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const method = new URL(req.url ?? '/', 'http://localhost').pathname.split('/').pop() ?? '';
      const contentType = String(req.headers['content-type'] ?? '');
      // Media methods post multipart/form-data (the file plus its fields), everything else JSON.
      const body = contentType.includes('multipart/form-data') ? parseMultipart(raw, contentType) : raw ? JSON.parse(raw) : {};
      calls.push({ method, body });
      const result = resultFor(method, body) as { __error?: string; __retryAfter?: number; __status?: number };
      res.setHeader('content-type', 'application/json');
      res.end(
        result.__error
          ? JSON.stringify({
              ok: false,
              error_code: result.__status ?? (result.__retryAfter === undefined ? 400 : 429),
              description: result.__error,
              ...(result.__retryAfter === undefined ? {} : { parameters: { retry_after: result.__retryAfter } }),
            })
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
    // Keep-alive sockets from the bot client would otherwise hold the server (and the test) open.
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/**
 * Minimal multipart/form-data reader: enough to see the text fields (`caption`, `chat_id`, the
 * `media` JSON array) without pulling a parser dependency into the tests.
 */
function parseMultipart(raw: string, contentType: string): Record<string, any> {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const marker = boundary?.[1] ?? boundary?.[2];
  const fields: Record<string, any> = {};
  if (!marker) return fields;

  for (const part of raw.split(`--${marker}`)) {
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd < 0) continue;
    const headers = part.slice(0, headerEnd);
    const name = /name="([^"]+)"/i.exec(headers)?.[1];
    if (!name) continue;
    const isFile = /filename=/i.test(headers);
    const value = part.slice(headerEnd + 4).replace(/\r\n$/, '');
    if (isFile) {
      fields[name] = [{ file: /filename="([^"]*)"/i.exec(headers)?.[1] ?? 'file' }];
      continue;
    }
    if (name === 'media' || name === 'rich_message' || name === 'reply_markup' || name === 'reply_parameters') {
      try {
        fields[name] = JSON.parse(value);
        continue;
      } catch {
        // fall through to the raw string
      }
    }
    fields[name] = value;
  }
  return fields;
}

const PRIVATE_CHAT = (userId: number): Chat.PrivateChat => ({ id: userId, type: 'private', first_name: 'Tester' });
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

/** A slash command. grammY matches `bot_command` entities, so a bare text update is not enough. */
export function commandUpdate(updateId: number, userId: number, command: string): Update {
  const text = `/${command}`;
  return {
    update_id: updateId,
    message: {
      message_id: 2,
      date: 0,
      chat: PRIVATE_CHAT(userId),
      from: FROM(userId),
      text,
      entities: [{ type: 'bot_command', offset: 0, length: text.length }],
    },
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
      message: {
        message_id: 42,
        date: 0,
        chat: chatId === userId ? PRIVATE_CHAT(chatId) : { id: chatId, type: 'channel', title: 'Chat' },
      },
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
