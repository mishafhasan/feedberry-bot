import { InlineKeyboard } from 'grammy';
import { platformIcon } from './texts.ts';

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

export function s5Keyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('🚀 Add and send latest posts', 'add:save')
    .row()
    .text('➕ Add without sending', 'add:save_silent')
    .row()
    .text('← Back', 'nav:back');
}

export function s6Keyboard(): InlineKeyboard {
  return new InlineKeyboard().text('← Back', 'nav:back');
}

const CHIPS: Record<string, string> = {
  rss: 'RSS',
  instagram: 'IG',
  facebook: 'FB',
  x: 'X',
  threads: 'TH',
  tiktok: 'TT',
  tumblr: 'TB',
  pinterest: 'PT',
  youtube: 'YT',
  bluesky: 'BS',
  telegram: 'TG',
  snapchat: 'SC',
};

/** S7 header: platform chips, a pager when needed, then Back. */
export function s7Keyboard(platforms: string[], active: string | null, page: number, pages: number): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  if (platforms.length > 0) {
    keyboard.text(active === null ? '● All' : 'All', 'src:filter:all');
    for (const platform of platforms.slice(0, 6)) {
      const label = `${platformIcon(platform)} ${CHIPS[platform] ?? platform.slice(0, 2).toUpperCase()}`;
      keyboard.text(platform === active ? `● ${label}` : label, `src:filter:${platform}`);
    }
    keyboard.row();
  }
  if (pages > 1) {
    if (page > 0) keyboard.text('‹', `src:page:${page - 1}`);
    if (page < pages - 1) keyboard.text('›', `src:page:${page + 1}`);
    keyboard.row();
  }
  return keyboard.text('← Back', 'nav:back');
}

/** S7 card: [Off|On] [⟳] [🗑] exactly as the screenshot. */
export function cardKeyboard(sourceId: number, enabled: boolean): InlineKeyboard {
  return new InlineKeyboard()
    .text(enabled ? 'Off' : 'On', `${enabled ? 'src:off' : 'src:on'}:${sourceId}`)
    .text('⟳', `src:check:${sourceId}`)
    .text('🗑', `src:del:${sourceId}`);
}

/** S10: destructive action needs its own confirm button (ADR-016). */
export function s10Keyboard(sourceId: number): InlineKeyboard {
  return new InlineKeyboard().text('🗑 Delete', `src:delok:${sourceId}`).row().text('← Cancel', `src:delno:${sourceId}`);
}
