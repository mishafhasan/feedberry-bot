/** Delivery target: a chat, an optional forum topic (§9.4) and whether the group window applies. */
export interface Target {
  chatId: number;
  messageThreadId: number | null;
  isGroup: boolean;
}

export const targetOf = (chatId: number, messageThreadId: number | null, type = 'private'): Target => ({
  chatId,
  messageThreadId,
  isGroup: type === 'group' || type === 'supergroup',
});
