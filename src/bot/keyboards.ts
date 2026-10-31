import { InlineKeyboard } from 'grammy';
import { t, type Lang } from './i18n/index.ts';
import { platformIcon } from './texts.ts';

/** Interface-language names are never translated: a user finds their own language best in it. */
export const LANGUAGES: Array<{ code: Lang; label: string }> = [
  { code: 'en', label: '🇬🇧 English' },
  { code: 'ru', label: '🇷🇺 Русский' },
  { code: 'es', label: '🇪🇸 Español' },
  { code: 'hi', label: '🇮🇳 हिन्दी' },
  { code: 'ta', label: '🇮🇳 தமிழ்' },
  { code: 'id', label: '🇮🇩 Bahasa Indonesia' },
];

/** One button per feature on S1, two per row as in the reference screenshot. */
export function s1Keyboard(lang: Lang = 'en'): InlineKeyboard {
  return new InlineKeyboard()
    .text(t(lang, 'btn.add'), 'menu:add')
    .text(t(lang, 'btn.sources'), 'menu:sources')
    .row()
    .text(t(lang, 'btn.supported'), 'menu:supported')
    .text(t(lang, 'btn.help'), 'menu:help')
    .row()
    .text(t(lang, 'btn.download'), 'menu:download');
}

/** Screens that are one message deep: Supported Sites, Help, About, Language. */
export function menuKeyboard(lang: Lang = 'en'): InlineKeyboard {
  return new InlineKeyboard().text(t(lang, 'btn.home'), 'nav:home');
}

export function languageKeyboard(): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const [index, language] of LANGUAGES.entries()) {
    keyboard.text(language.label, `lang:${language.code}`);
    if (index % 2 === 1) keyboard.row();
  }
  return keyboard.row().text(t('en', 'btn.home'), 'nav:home');
}

export function backKeyboard(lang: Lang = 'en'): InlineKeyboard {
  return new InlineKeyboard().text(t(lang, 'btn.back'), 'nav:back');
}

/** Required on every failure screen (ARCHITECTURE §11). */
export function errorKeyboard(lang: Lang = 'en'): InlineKeyboard {
  return new InlineKeyboard().text(t(lang, 'btn.retry'), 'err:retry').row().text(t(lang, 'btn.back'), 'nav:back');
}

/** A finished download offers the next one instead of dropping the user back to silence. */
export function downloadResultKeyboard(lang: Lang = 'en'): InlineKeyboard {
  return new InlineKeyboard().text(t(lang, 'btn.downloadMore'), 'dl:more').row().text(t(lang, 'btn.home'), 'nav:home');
}

/** A pasted link the bot cannot use: explain once, offer Help, never a Retry that would re-fail. */
export function noticeKeyboard(lang: Lang = 'en'): InlineKeyboard {
  return new InlineKeyboard().text(t(lang, 'btn.help'), 'menu:help').row().text(t(lang, 'btn.home'), 'nav:home');
}

/** A pasted post link: download it, and subscribe to the account when the URL names it. */
export function postLinkKeyboard(hasProfile: boolean, lang: Lang = 'en'): InlineKeyboard {
  const keyboard = new InlineKeyboard().text(t(lang, 'btn.downloadPost'), 'dl:post');
  if (hasProfile) keyboard.text(t(lang, 'btn.addPost'), 'add:post');
  return keyboard.row().text(t(lang, 'btn.home'), 'nav:home');
}

/** S4: personal account first, then every verified chat, then Back (ADR-014). */
export function destinationKeyboard(personalChatId: number, chats: Array<{ id: number; title: string | null; type: string }>, lang: Lang = 'en'): InlineKeyboard {
  const keyboard = new InlineKeyboard().text(t(lang, 'btn.personal'), `add:dest:${personalChatId}`).row();
  for (const chat of chats) {
    const icon = chat.type === 'channel' ? '📢' : '👥';
    keyboard.text(`${icon} ${chat.title ?? chat.id}`, `add:dest:${chat.id}`).row();
  }
  return keyboard.text(t(lang, 'btn.back'), 'nav:back');
}

export function s5Keyboard(lang: Lang = 'en'): InlineKeyboard {
  return new InlineKeyboard()
    .text(t(lang, 'btn.addLatest'), 'add:save')
    .row()
    .text(t(lang, 'btn.addSilent'), 'add:save_silent')
    .row()
    .text(t(lang, 'btn.back'), 'nav:back');
}

export function s6Keyboard(lang: Lang = 'en'): InlineKeyboard {
  return new InlineKeyboard().text(t(lang, 'btn.back'), 'nav:back');
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
export function s7Keyboard(platforms: string[], active: string | null, page: number, pages: number, lang: Lang = 'en'): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  if (platforms.length > 0) {
    keyboard.text(active === null ? `● ${t(lang, 'btn.all')}` : t(lang, 'btn.all'), 'src:filter:all');
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
  return keyboard.text(t(lang, 'btn.back'), 'nav:back');
}

/** S7 card: [Off|On] [⟳] [🗑] exactly as the screenshot. */
export function cardKeyboard(sourceId: number, enabled: boolean, lang: Lang = 'en'): InlineKeyboard {
  return new InlineKeyboard()
    .text(enabled ? t(lang, 'btn.off') : t(lang, 'btn.on'), `${enabled ? 'src:off' : 'src:on'}:${sourceId}`)
    .text('⟳', `src:check:${sourceId}`)
    .text('🗑', `src:del:${sourceId}`);
}

/** S10: destructive action needs its own confirm button (ADR-016). */
export function s10Keyboard(sourceId: number, lang: Lang = 'en'): InlineKeyboard {
  return new InlineKeyboard().text(t(lang, 'btn.delete'), `src:delok:${sourceId}`).row().text(t(lang, 'btn.cancel'), `src:delno:${sourceId}`);
}
