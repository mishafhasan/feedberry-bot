import { InlineKeyboard } from 'grammy';

/** One button per feature on S1, in screenshot order. */
export function s1Keyboard(sourceCount: number, limit: number): InlineKeyboard {
  return new InlineKeyboard()
    .text('➕ Add source', 'menu:add')
    .row()
    .text(`📁 My sources [${sourceCount}/${limit}]`, 'menu:sources')
    .row()
    .text('⬇️ Download Mode', 'menu:download');
}

export function backKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text('← Back', 'nav:back');
}

/** Required on every failure screen (ARCHITECTURE §11). */
export function errorKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text('🔁 Retry', 'err:retry').row().text('← Back', 'nav:back');
}

/** S4: personal account first, then every verified chat, then Back (ADR-014). */
export function destinationKeyboard(personalChatId: number, chats: Array<{ id: number; title: string | null; type: string }>): InlineKeyboard {
  const keyboard = new InlineKeyboard().text('👤 Personal account', `add:dest:${personalChatId}`).row();
  for (const chat of chats) {
    const icon = chat.type === 'channel' ? '📢' : '👥';
    keyboard.text(`${icon} ${chat.title ?? chat.id}`, `add:dest:${chat.id}`).row();
  }
  return keyboard.text('← Back', 'nav:back');
}
