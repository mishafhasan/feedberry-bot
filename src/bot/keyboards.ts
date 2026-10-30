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
