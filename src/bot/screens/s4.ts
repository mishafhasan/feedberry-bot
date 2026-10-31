import type { InlineKeyboard } from 'grammy';
import type { ChatRow } from '../../db/repos/chats.ts';
import type { FeedItem } from '../../platform/feed/native.ts';
import type { Platform } from '../../platform/registry.ts';
import { destinationKeyboard } from '../keyboards.ts';
import { s4Text } from '../texts.ts';
import type { Lang } from '../i18n/index.ts';

export interface S4Data {
  platform: Platform;
  author: string;
  avatarUrl: string | null;
  items: FeedItem[];
  personalChatId: number;
  chats: ChatRow[];
  tz?: string;
  lang?: Lang;
}

export interface S4View {
  text: string;
  keyboard: InlineKeyboard;
  photoUrl: string | null;
}

export function s4View(data: S4Data): S4View {
  const text = s4Text({ platform: data.platform, author: data.author, items: data.items, tz: data.tz, lang: data.lang });
  return {
    // A caption is capped at 1024; this is a preview, so trimming beats a second message.
    text: data.avatarUrl && text.length > 1024 ? `${text.slice(0, 1023)}…` : text,
    keyboard: destinationKeyboard(data.personalChatId, data.chats, data.lang ?? 'en'),
    photoUrl: data.avatarUrl,
  };
}
