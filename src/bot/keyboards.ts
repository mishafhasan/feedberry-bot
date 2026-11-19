import { InlineKeyboard } from 'grammy';
import { t, type Lang } from './i18n/index.ts';

/** Interface-language names are never translated: a user finds their own language best in it. */
export const LANGUAGES: Array<{ code: Lang; label: string }> = [
  { code: 'en', label: '🇬🇧 English' },
  { code: 'ru', label: '🇷🇺 Русский' },
  { code: 'es', label: '🇪🇸 Español' },
  { code: 'hi', label: '🇮🇳 हिन्दी' },
  { code: 'ta', label: '🇮🇳 தமிழ்' },
  { code: 'id', label: '🇮🇩 Bahasa Indonesia' },
];

/**
 * The zones the picker offers, as IANA names: an offset would be wrong twice a year. Sri Lanka leads
 * because it is the zone this screen exists for, and the list is also the whitelist for `tz:` taps.
 * It is a convenience set, not exhaustive: a zone written straight into `users.tz` still works, it is
 * just not marked in the picker until it happens to be one of these.
 */
export const TIMEZONES: ReadonlyArray<{ zone: string; label: string }> = [
  { zone: 'Asia/Colombo', label: '🇱🇰 Sri Lanka (Colombo)' },
  { zone: 'Asia/Kolkata', label: '🇮🇳 India (Kolkata)' },
  { zone: 'Asia/Kathmandu', label: '🇳🇵 Nepal (Kathmandu)' },
  { zone: 'Asia/Karachi', label: '🇵🇰 Pakistan (Karachi)' },
  { zone: 'Asia/Dhaka', label: '🇧🇩 Bangladesh (Dhaka)' },
  { zone: 'Asia/Yangon', label: '🇲🇲 Myanmar (Yangon)' },
  { zone: 'Asia/Bangkok', label: '🇹🇭 Thailand (Bangkok)' },
  { zone: 'Asia/Jakarta', label: '🇮🇩 Indonesia (Jakarta)' },
  { zone: 'Asia/Singapore', label: '🇸🇬 Singapore' },
  { zone: 'Asia/Manila', label: '🇵🇭 Philippines (Manila)' },
  { zone: 'Asia/Shanghai', label: '🇨🇳 China (Shanghai)' },
  { zone: 'Asia/Tokyo', label: '🇯🇵 Japan (Tokyo)' },
  { zone: 'Australia/Sydney', label: '🇦🇺 Australia (Sydney)' },
  { zone: 'Pacific/Auckland', label: '🇳🇿 New Zealand (Auckland)' },
  { zone: 'Asia/Dubai', label: '🇦🇪 UAE (Dubai)' },
  { zone: 'Asia/Riyadh', label: '🇸🇦 Saudi Arabia (Riyadh)' },
  { zone: 'Europe/Istanbul', label: '🇹🇷 Türkiye (Istanbul)' },
  { zone: 'Europe/Moscow', label: '🇷🇺 Russia (Moscow)' },
  { zone: 'Africa/Nairobi', label: '🇰🇪 Kenya (Nairobi)' },
  { zone: 'Europe/Athens', label: '🇬🇷 Greece (Athens)' },
  { zone: 'Africa/Johannesburg', label: '🇿🇦 South Africa (Johannesburg)' },
  { zone: 'Europe/Berlin', label: '🇩🇪 Germany (Berlin)' },
  { zone: 'Europe/Paris', label: '🇫🇷 France (Paris)' },
  { zone: 'Europe/Madrid', label: '🇪🇸 Spain (Madrid)' },
  { zone: 'Europe/London', label: '🇬🇧 UK (London)' },
  { zone: 'UTC', label: '🌐 UTC' },
  { zone: 'America/Sao_Paulo', label: '🇧🇷 Brazil (São Paulo)' },
  { zone: 'America/Argentina/Buenos_Aires', label: '🇦🇷 Argentina (Buenos Aires)' },
  { zone: 'America/Bogota', label: '🇨🇴 Colombia (Bogotá)' },
  { zone: 'America/New_York', label: '🇺🇸 USA (New York)' },
  { zone: 'America/Chicago', label: '🇺🇸 USA (Chicago)' },
  { zone: 'America/Mexico_City', label: '🇲🇽 Mexico (Mexico City)' },
  { zone: 'America/Denver', label: '🇺🇸 USA (Denver)' },
  { zone: 'America/Los_Angeles', label: '🇺🇸 USA (Los Angeles)' },
  { zone: 'Pacific/Honolulu', label: '🇺🇸 USA (Honolulu)' },
];

/** Two buttons per row; the single digest entry pairs with Schedule. */
export function s1Keyboard(lang: Lang = 'en', digest = false): InlineKeyboard {
  const keyboard = new InlineKeyboard()
    .text(t(lang, 'btn.add'), 'menu:add')
    .text(t(lang, 'btn.sources'), 'menu:sources')
    .row()
    .text(t(lang, 'btn.filter'), 'menu:filter')
    .text(t(lang, 'btn.supported'), 'menu:supported')
    .row()
    .text(t(lang, 'btn.settings'), 'menu:settings')
    .text(t(lang, 'btn.download'), 'menu:download');
  // ADR-029: no Gemini key, no digest; the button would open a screen that cannot run.
  if (digest) {
    keyboard.row().text(t(lang, 'btn.schedule'), 'menu:schedule').text(t(lang, 'btn.digest'), 'menu:digest');
  } else {
    keyboard.row().text(t(lang, 'btn.schedule'), 'menu:schedule');
  }
  return keyboard;
}

/** Screens that sit one message deep and only need a way home. */
export function menuKeyboard(lang: Lang = 'en'): InlineKeyboard {
  return new InlineKeyboard().text(t(lang, 'btn.home'), 'nav:home');
}

/** The Settings hub: the two info screens and the clock every scheduled post and digest follows. */
export function settingsKeyboard(lang: Lang = 'en'): InlineKeyboard {
  return new InlineKeyboard()
    .text(t(lang, 'btn.help'), 'set:help')
    .text(t(lang, 'btn.about'), 'set:about')
    .row()
    .text(t(lang, 'btn.setTimezone'), 'set:tz')
    .row()
    .text(t(lang, 'btn.home'), 'nav:home');
}

/** Help and About open from Settings, so they return there; the error notice still goes Home. */
export function settingsBackKeyboard(lang: Lang = 'en'): InlineKeyboard {
  return new InlineKeyboard().text(t(lang, 'btn.back'), 'menu:settings');
}

/** Two per row, the active zone marked; a tap cannot leave this list. */
export function timezoneKeyboard(current: string, lang: Lang = 'en'): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const [index, entry] of TIMEZONES.entries()) {
    // Break before a pair, never after one: a trailing `.row()` would leave a blank row.
    if (index > 0 && index % 2 === 0) keyboard.row();
    keyboard.text(`${entry.zone === current ? '✅ ' : ''}${entry.label}`, `tz:${entry.zone}`);
  }
  return keyboard.row().text(t(lang, 'btn.back'), 'menu:settings');
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

/** A finished download offers the next one, the source behind the link, then Back. */
export function downloadResultKeyboard(lang: Lang = 'en', hasSource = false, handle: string | null = null): InlineKeyboard {
  const keyboard = new InlineKeyboard().text(t(lang, 'btn.downloadMore'), 'dl:more');
  // The account behind a bare post link is only known after the download, so it is offered here.
  if (hasSource) keyboard.text(handle === null ? t(lang, 'btn.addPost') : `➕ @${handle}`, 'add:post');
  return keyboard.row().text(t(lang, 'btn.home'), 'nav:home');
}

/** Already subscribed: the next useful step is the list, not a Retry. */
export function openSourcesKeyboard(lang: Lang = 'en'): InlineKeyboard {
  return new InlineKeyboard().text(t(lang, 'btn.openSources'), 'menu:sources').row().text(t(lang, 'btn.home'), 'nav:home');
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
    .text(t(lang, 'btn.keywords'), 'add:kw')
    .row()
    .text(t(lang, 'btn.back'), 'nav:back');
}

export function s6Keyboard(lang: Lang = 'en'): InlineKeyboard {
  return new InlineKeyboard().text(t(lang, 'btn.back'), 'nav:back');
}

/** S10: destructive action needs its own confirm button (ADR-016). */
export function s10Keyboard(sourceId: number, lang: Lang = 'en'): InlineKeyboard {
  return new InlineKeyboard().text(t(lang, 'btn.delete'), `src:delok:${sourceId}`).row().text(t(lang, 'btn.cancel'), `src:delno:${sourceId}`);
}
