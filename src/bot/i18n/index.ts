/**
 * Interface strings, one flat dictionary per language. English is the base: a key missing from a
 * translation falls back to it, so a partial language can never render a blank screen.
 */
export type Lang = 'en' | 'ru' | 'es' | 'hi' | 'ta' | 'id';

export const LANGS: Lang[] = ['en', 'ru', 'es', 'hi', 'ta', 'id'];

export function isLang(value: string): value is Lang {
  return (LANGS as string[]).includes(value);
}

/** The stored locale, or English when it is unset or no longer supported. */
export function langFor(locale: string | null | undefined): Lang {
  return locale !== null && locale !== undefined && isLang(locale) ? locale : 'en';
}

const EN = {
  's1.body': `**FeedBerry** - fresh posts from your favorite accounts, delivered to Telegram.

🆔 Your ID: {id}
⭐ Plan: {plan}
📊 Sources: {sources}

**Features**:
🌳 Power Efficient: It should consume very little computing power to run.
🌐 Post forwarding from: RSS, Instagram, TikTok, YouTube, Twitter/X, Facebook, etc...
💬 Delivery to your DM, channels, groups and forum topics
🖼 Photos, videos, albums and files in original quality.
⬇️ Full article text: the bot pulls the whole article from the link and converts it into telegram instant view, with media and without ads.
🤖 AI Summary: blog and website posts in instant view open with a short summary by Cocoon AI.
🧠 Smart routing: AI detects the topic of each post and sorts posts from sources across chats and forum topics
⚡ Fast source checks: with custom interval
©️ Save media without watermarks and logo.
⬇️ Download mode: Send post link of supported platforms and bot will send the file/media as post.
✨ AI processing: summary, digest, rephrasing, style change, ad auto-detection and your own custom prompt (Coming Soon)

**How to use**:
1) Send a profile or post link
2) Choose where to deliver
3) Tap Add — done.`,
  'plan.free': 'Free',
  'plan.trial': '🕐 Trial ends: —',

  's2.title': '🔗 Adding a source',
  's2.outro': 'Just send a link to any of these sources and follow the instructions.',
  's2.snapchat': 'single links only — use Download Mode',

  's3.checking': '⚪ Checking source:',
  's4.question': 'Where should posts from this source be delivered?',
  's4.hint': '⚠️ To deliver into a channel or group, add the bot there as an admin with permission to post — the chat will then show up in this list.',
  's4.category': '📂 Category: {name}',
  's5.question': 'How do we add the source?',
  's6.added': 'Data source «{title}» is added to your feed. You will receive notification about new posts as soon as they are published.',
  's10.confirm': '🗑 Delete the source «{title}»?\nIts posts will stop coming and the subscription settings will be removed.',

  's7.title': 'Source list · Private messages',
  's7.showing': 'Showing {from}–{to} of {total}',
  's7.empty': 'Showing 0 of 0',
  's7.card': '{title}\nid: #{id}, source checked: {age}',
  's7.kinds': 'receiving: {kinds}',
  'age.never': 'never',

  'types.title': '📺 What should {handle} send here?',
  'types.hint': 'Tap what should arrive in this chat, then Done.',
  'types.video': 'Videos',
  'types.short': 'Shorts',
  'types.post': 'Posts',
  'types.sends': 'Sends: {kinds}',
  'types.done': '✅ Done',
  'types.all': 'All content',

  's5.keywords': '🔑 Keywords: {keywords}',
  'kw.none': 'no filter — every post',
  'kw.usesDefault': 'follows the default ({keywords})',
  'kw.prompt': 'Send the keywords or tags for «{title}», separated by commas.\nExample: ai, telegram, openai\nA post arrives when any of them appears in its title, text or tags.\nSend /skip to remove the filter.',
  'kw.promptDefault': 'Send the default keywords, separated by commas.\nThey apply to every source that has no list of its own.\nSend /skip to remove the filter.',
  'filter.title': '🔑 Keyword filters',
  'filter.lead': 'Only the posts that mention a word here reach their chat.',
  'filter.default': 'Default',
  'filter.defaultHint': 'Every source without a list of its own uses this.',
  'filter.tags': '🏷 {keywords}',
  'filter.empty': 'No sources yet — send a profile link to add one.',
  'filter.hint': 'Tap ✏️ to change a list, 🗑 to clear it.',

  'prompt.download': '⬇️ Send a post link and I will deliver the media here.',
  'prompt.downloadList': 'Supported sites: websites/blogs, Instagram, X/Twitter, Bluesky, TikTok, Snapchat, Tumblr, Pinterest, Facebook, YouTube, Threads.',
  'done.download': '✅ Delivered.',
  'prompt.postLink': '🔗 This is a post link.',
  'notice.postLinkRequired': '⬇️ Send a post link, not a profile.',
  'notice.sourceLinkRequired': '➕ Send a source link, not a post.',
  'notice.alreadySource': '📁 «{title}» is already in your sources.',

  'supported.title': '🌐 Supported sites',
  'supported.rows': '📡 Websites & blogs — any site with a feed\n📸 Instagram — profiles and posts\n📘 Facebook — pages, videos and reels\n🧵 Threads — profiles and posts\n✖️ X / Twitter — posts\n🎵 TikTok — profiles and video links\n🦋 Bluesky — profiles and posts\n👻 Snapchat — Download Mode only\n📝 Tumblr — blogs and posts\n📌 Pinterest — profiles and pins\n▶️ YouTube — channels, Shorts, videos and posts',
  'supported.outro': 'Send a profile link to subscribe, or a post link to download it once.',
  'help.body': '❓ How to use FeedBerry\n1) Send a profile link, or open Supported Sites to see what works.\n2) Pick the chat the posts should arrive in.\n3) Tap Add — done.\nUse Download Mode for a single post when you do not want to subscribe.',
  'about.body': 'ℹ️ FeedBerry\n\nFresh posts from the accounts you follow, delivered to Telegram — photos, videos, albums and full articles, without ads.\n\n🆔 Your ID: {id}\n\nTap /supported_sites to see where posts can come from.',
  'language.title': '🌐 Choose your language:',

  'toast.unknown': 'That button is no longer available.',
  'toast.slowDown': 'Slow down a moment.',
  'toast.checksExhausted': 'Too many checks this hour — try again later.',
  'toast.disabled': 'Source disabled — new posts will not arrive.',
  'toast.enabled': 'Source enabled.',
  'toast.deleted': 'Source deleted.',
  'toast.checkQueued': 'Queued for a check — the source will be polled within a minute.',

  'btn.add': '➕ Add Source',
  'btn.sources': '📁 My Sources',
  'btn.supported': '🌐 Supported Sites',
  'btn.help': '❓ Help',
  'btn.download': '⬇️ Download Mode',
  'btn.downloadMore': '⬇️ Download more',
  'btn.downloadPost': '⬇️ Download',
  'btn.addPost': '➕ Add source',
  'btn.back': '← Back',
  'btn.home': '← Back',
  'btn.retry': '🔁 Retry',
  'btn.personal': '👤 Personal account',
  'btn.addLatest': '🚀 Add and send latest posts',
  'btn.addSilent': '➕ Add without sending',
  'btn.delete': '🗑 Delete',
  'btn.cancel': '← Cancel',
  'btn.off': 'Off',
  'btn.on': 'On',
  'btn.all': 'All',
  'btn.keywords': '🔑 Keywords',
  'btn.filter': '📇 Filter',
  'btn.openSources': '📁 My Sources',
  'notice.menuReady': 'Menu ready — the keyboard icon by the message box folds it away and brings it back.',

  'err.E_LINK_INVALID': "That link isn't a supported source.",
  'err.E_NO_FEED': "Couldn't find a feed for this page.",
  'err.E_PROFILE_ONLY': 'This is a browse page, not a single post. Send a direct post link, or a profile link to subscribe.',
  'err.E_BOT_NOT_ADMIN': 'Add me as an admin with permission to post, then try again.',
  'err.E_FORUM_TOPIC': "That topic can't be posted to. Pick another or the General topic.",
  'err.E_SOURCE_LIMIT': "You've reached 250 sources. Delete one first.",
  'err.E_DUPLICATE': 'This source is already in your list.',
  'err.E_COOKIE_REQUIRED': "This source needs a login the bot doesn't have. Send one post link instead.",
  'err.E_RATE_LIMIT': 'The platform is rate-limiting checks. Will retry later.',
  'err.E_FEED_DOWN': 'The source is temporarily unreachable.',
  'err.E_NO_MEDIA': "Couldn't extract media; sending the link.",
  'err.E_TOO_LARGE': 'The file is too large to upload, so a preview was sent instead.',
  'err.E_MEDIA_GONE': 'The media link expired. Retrying with a fresh check.',
  'err.E_TELEGRAPH': 'The article could not be converted, so the link was sent.',
  'err.E_TG_PARSE': 'The post had unsupported formatting; it was sent as plain text.',
  'err.E_TG_FORBIDDEN': "I can't post to this chat.",
  'err.E_TG_429': 'Telegram asked us to slow down. Retrying.',
  'err.E_TG_UNKNOWN': 'Something went wrong. Retry?',
  'err.E_POST_REQUIRED': 'Send a post link, not a profile.',
  'err.E_DOWNLOAD_LIMIT': 'The daily download limit is reached. Try again tomorrow.',
  'err.E_SLOW_DOWN': 'One at a time — try again in a few seconds.',
  'err.limitSources': "⚠️ You've reached {limit} sources. Delete one first.",
  'err.limitDownloads': "⚠️ You've reached {limit} downloads today.",

  'btn.schedule': '⏰ Schedule',
  'schedule.title': '⏰ Check schedule',
  'schedule.hint': 'Choose a source to change how often the bot checks it.',
  'schedule.empty': 'No sources yet — add one, then come back to set its schedule.',
  'schedule.current': 'Current: {cadence}',
  'schedule.pickerHint': 'How often should the bot check this source?',
  'schedule.default': '08:00 & 20:00',
  'schedule.defaultOption': 'Default · 08:00 & 20:00',
  'schedule.every': 'every {value}',
  'schedule.setEvery': 'Every {value}',
  'unit.minutes': '{n} min',
  'unit.hours': '{n} h',
  'schedule.shared': 'A source keeps one schedule for all its subscribers.',
  'schedule.allSources': '🌐 All sources',
  'schedule.allTitle': '🌐 All sources',
  'schedule.allHint': 'The same cadence applies to every source in your list.',
  'toast.scheduleSet': 'Schedule updated.',

  'notice.access.request': '🔒 This bot is private.\nYour access request was sent to the admin. Ask the admin to approve you, then try again.',
  'notice.access.allowed': '✅ Your access has been approved. Send /start to open the bot.',
  'notice.access.blocked': '🚫 Your access to this bot has been revoked.',
  'notice.access.unblocked': '✅ Your access has been restored. Send /start to continue.',

  'adm.title': '🛠 Admin panel',
  'adm.stats': '👥 Users: {all} · ✅ {allowed} · ⏳ {pending} · 🚫 {blocked}',
  'adm.requests.title': '🕐 Recent access requests:',
  'adm.requests.none': 'none yet',
  'adm.request.row': '🆔 {id} {who}',
  'adm.users.title': '👥 Users',
  'adm.users.showing': 'Showing {from}–{to} of {total}',
  'adm.users.empty': 'No users yet.',
  'adm.users.row': '#{id} · {status} · {sources} src',
  'adm.user.title': '👤 User {id}',
  'adm.user.status': 'Status: {status}',
  'adm.user.locale': 'Language: {locale}',
  'adm.user.created': 'Created: {date}',
  'adm.user.sources': 'Sources ({count}):',
  'adm.user.noSources': 'No sources.',
  'adm.user.sourceRow': '{platform} · {title}',
  'adm.status.pending': 'pending',
  'adm.status.allowed': 'allowed',
  'adm.status.blocked': 'blocked',
  'adm.add.prompt': 'Send the Telegram user ID or @username to allow.\nThe user must have started the bot at least once.',
  'adm.add.invalid': 'That is not a Telegram ID or a known @username. Send a number like 123456789, or tap Back.',
  'adm.add.failed': 'Could not find that Telegram user. Check the number — the user must have started the bot first. Try again, or tap Back.',
  'adm.add.done': '✅ User {id} is allowed.',
  'adm.notify.pick': '✉️ Choose a user to message',
  'adm.msg.prompt': 'Send the message for user {id}.',
  'adm.msg.confirm': 'Send this message to user {id}?',
  'adm.msg.sent': '✅ Message sent to {id}.',
  'adm.msg.failed': '⚠️ Could not message {id} ({reason}). The user may have blocked the bot.',
  'adm.all.prompt': 'Send the message for all allowed users.',
  'adm.all.confirm': 'Send this message to all allowed users?',
  'adm.all.done': '✅ Sent to {sent}, failed {failed}.',
  'adm.btn.users': '👥 Users',
  'adm.btn.add': '➕ Add user',
  'adm.btn.notify': '✉️ Notify user',
  'adm.btn.notifyAll': '📣 Notify all',
  'adm.btn.allow': '✅ Allow',
  'adm.btn.block': '🚫 Block',
  'adm.btn.unblock': '🔓 Unblock',
  'adm.btn.notifyUser': '✉️ Notify',
  'adm.btn.send': '📤 Send',
  'adm.toast.allowed': 'User allowed.',
  'adm.toast.blocked': 'User blocked.',
  'adm.toast.unknown': 'That button is not available.',
} as const;

export type TextKey = keyof typeof EN;

type Dict = Record<TextKey, string>;

const RU: Partial<Dict> = {
  's1.body': `**FeedBerry** — свежие посты из ваших любимых аккаунтов прямо в Telegram.

🆔 Ваш ID: {id}
⭐ Тариф: {plan}
📊 Источники: {sources}

**Возможности**:
🌳 Экономный: почти не тратит ресурсы сервера.
🌐 Пересылка постов из RSS, Instagram, TikTok, YouTube, Twitter/X, Facebook и других.
💬 Доставка в личные сообщения, каналы, группы и темы форума.
🖼 Фото, видео, альбомы и файлы в исходном качестве.
⬇️ Полный текст статьи: бот забирает статью по ссылке и открывает её в Instant View, с медиа и без рекламы.
🤖 ИИ-саммари: статьи с сайтов и блогов в Instant View открываются с кратким саммари от Cocoon AI.
🧠 Умная маршрутизация: ИИ определяет тему поста и распределяет посты по чатам и темам.
⚡ Быстрые проверки источников: с настраиваемым интервалом.
©️ Медиа без водяных знаков и логотипов.
⬇️ Режим загрузки: отправьте ссылку на пост, и бот пришлёт медиа.
✨ Обработка ИИ: саммари, дайджест, перефразирование, смена стиля, автоопределение рекламы и свой промпт (скоро)

**Как пользоваться**:
1) Отправьте ссылку на профиль или пост
2) Выберите, куда доставлять
3) Нажмите «Добавить» — готово.`,
  'plan.free': 'Бесплатный',
  'plan.trial': '🕐 Пробный период до: —',
  's2.title': '🔗 Добавление источника',
  's2.outro': 'Просто отправьте ссылку на любой из этих источников и следуйте подсказкам.',
  's2.snapchat': 'только отдельные ссылки — используйте режим загрузки',
  's3.checking': '⚪ Проверяем источник:',
  's4.question': 'Куда доставлять посты из этого источника?',
  's4.hint': '⚠️ Чтобы доставлять в канал или группу, добавьте туда бота как админа с правом публикации — тогда чат появится в этом списке.',
  's4.category': '📂 Категория: {name}',
  's5.question': 'Как добавить источник?',
  's6.added': 'Источник «{title}» добавлен. Вы будете получать новые посты сразу после публикации.',
  's10.confirm': '🗑 Удалить источник «{title}»?\nПосты перестанут приходить, а настройки подписки будут удалены.',
  's7.title': 'Список источников · Личные сообщения',
  's7.showing': 'Показано {from}–{to} из {total}',
  's7.empty': 'Показано 0 из 0',
  's7.card': '{title}\nid: #{id}, проверено: {age}',
  'age.never': 'никогда',
  'prompt.download': '⬇️ Отправьте ссылку на пост, и я пришлю медиа сюда.',
  'prompt.downloadList': 'Поддерживаются: сайты и блоги, Instagram, X/Twitter, Bluesky, TikTok, Snapchat, Tumblr, Pinterest, Facebook, YouTube, Threads.',
  'done.download': '✅ Готово.',
  'prompt.postLink': '🔗 Это ссылка на пост.',
  'supported.title': '🌐 Поддерживаемые сайты',
  'supported.rows': '📡 Сайты и блоги — любой сайт с лентой\n📸 Instagram — профили и посты\n📘 Facebook — страницы, видео и reels\n🧵 Threads — профили и посты\n✖️ X / Twitter — посты\n🎵 TikTok — профили и ссылки на видео\n🦋 Bluesky — профили и посты\n👻 Snapchat — только режим загрузки\n📝 Tumblr — блоги и посты\n📌 Pinterest — профили и пины\n▶️ YouTube — каналы, Shorts, видео и посты',
  'supported.outro': 'Отправьте ссылку на профиль, чтобы подписаться, или на пост, чтобы скачать его один раз.',
  'help.body': '❓ Как пользоваться FeedBerry\n1) Отправьте ссылку на профиль или откройте «Поддерживаемые сайты».\n2) Выберите чат, куда присылать посты.\n3) Нажмите «Добавить» — готово.\nДля одного поста без подписки используйте режим загрузки.',
  'about.body': 'ℹ️ FeedBerry\n\nСвежие посты из аккаунтов, за которыми вы следите, прямо в Telegram — фото, видео, альбомы и полные статьи, без рекламы.\n\n🆔 Ваш ID: {id}\n\nНажмите /supported_sites, чтобы увидеть список сайтов.',
  'language.title': '🌐 Выберите язык:',
  'toast.unknown': 'Эта кнопка больше недоступна.',
  'toast.slowDown': 'Немного помедленнее.',
  'toast.checksExhausted': 'Слишком много проверок за час — попробуйте позже.',
  'toast.disabled': 'Источник отключён — новые посты не придут.',
  'toast.enabled': 'Источник включён.',
  'toast.deleted': 'Источник удалён.',
  'toast.checkQueued': 'Проверка в очереди — источник опросим в течение минуты.',
  'btn.add': '➕ Добавить источник',
  'btn.sources': '📁 Мои источники',
  'btn.supported': '🌐 Поддерживаемые сайты',
  'btn.help': '❓ Помощь',
  'btn.download': '⬇️ Режим загрузки',
  'btn.downloadMore': '⬇️ Скачать ещё',
  'btn.downloadPost': '⬇️ Скачать',
  'btn.addPost': '➕ Добавить источник',
  'btn.back': '← Назад',
  'btn.home': '← Назад',
  'btn.retry': '🔁 Повторить',
  'btn.personal': '👤 Личный аккаунт',
  'btn.addLatest': '🚀 Добавить и прислать последние посты',
  'btn.addSilent': '➕ Добавить без отправки',
  'btn.delete': '🗑 Удалить',
  'btn.cancel': '← Отмена',
  'btn.off': 'Выкл',
  'btn.on': 'Вкл',
  'btn.all': 'Все',
  'err.E_LINK_INVALID': 'Эта ссылка не поддерживается.',
  'err.E_NO_FEED': 'Не удалось найти ленту для этой страницы.',
  'err.E_PROFILE_ONLY': 'Это страница просмотра, а не отдельный пост. Пришлите прямую ссылку на пост или ссылку на профиль, чтобы подписаться.',
  'err.E_BOT_NOT_ADMIN': 'Добавьте меня админом с правом публикации и попробуйте снова.',
  'err.E_FORUM_TOPIC': 'В эту тему нельзя писать. Выберите другую или «General».',
  'err.E_SOURCE_LIMIT': 'Достигнут лимит 250 источников. Удалите один.',
  'err.E_DUPLICATE': 'Этот источник уже в вашем списке.',
  'err.E_COOKIE_REQUIRED': 'Этому источнику нужен вход, которого у бота нет. Отправьте ссылку на пост.',
  'err.E_RATE_LIMIT': 'Платформа ограничивает запросы. Повторим позже.',
  'err.E_FEED_DOWN': 'Источник временно недоступен.',
  'err.E_NO_MEDIA': 'Не удалось извлечь медиа; отправляю ссылку.',
  'err.E_TOO_LARGE': 'Файл слишком большой, поэтому отправлен превью.',
  'err.E_MEDIA_GONE': 'Ссылка на медиа устарела. Повторяю с новой проверкой.',
  'err.E_TELEGRAPH': 'Статью не удалось преобразовать, отправлена ссылка.',
  'err.E_TG_PARSE': 'В посте неподдерживаемое форматирование; отправлено текстом.',
  'err.E_TG_FORBIDDEN': 'Не могу писать в этот чат.',
  'err.E_TG_429': 'Telegram просит сбавить темп. Повторяю.',
  'err.E_TG_UNKNOWN': 'Что-то пошло не так. Повторить?',
  'err.E_POST_REQUIRED': 'Отправьте ссылку на пост, а не на профиль.',
  'err.E_DOWNLOAD_LIMIT': 'Дневной лимит загрузок исчерпан. Попробуйте завтра.',
  'err.E_SLOW_DOWN': 'По одному — попробуйте через несколько секунд.',
  'err.limitSources': '⚠️ Достигнут лимит {limit} источников. Удалите один.',
  'err.limitDownloads': '⚠️ Достигнут лимит {limit} загрузок в день.',

  'btn.schedule': '⏰ Расписание',
  'schedule.title': '⏰ Расписание проверок',
  'schedule.hint': 'Выберите источник, чтобы изменить частоту его проверок.',
  'schedule.empty': 'Источников пока нет — добавьте, затем вернитесь, чтобы задать расписание.',
  'schedule.current': 'Сейчас: {cadence}',
  'schedule.pickerHint': 'Как часто боту проверять этот источник?',
  'schedule.default': '08:00 и 20:00',
  'schedule.defaultOption': 'По умолчанию · 08:00 и 20:00',
  'schedule.every': 'каждые {value}',
  'schedule.setEvery': 'Каждые {value}',
  'unit.minutes': '{n} мин',
  'unit.hours': '{n} ч',
  'schedule.shared': 'У источника одно расписание для всех подписчиков.',
  'schedule.allSources': '🌐 Все источники',
  'schedule.allTitle': '🌐 Все источники',
  'schedule.allHint': 'Один интервал применится ко всем источникам в вашем списке.',
  'toast.scheduleSet': 'Расписание обновлено.',
};

const ES: Partial<Dict> = {
  's1.body': `**FeedBerry** — publicaciones nuevas de tus cuentas favoritas, directo a Telegram.

🆔 Tu ID: {id}
⭐ Plan: {plan}
📊 Fuentes: {sources}

**Funciones**:
🌳 Eficiente: consume muy pocos recursos.
🌐 Reenvío desde RSS, Instagram, TikTok, YouTube, Twitter/X, Facebook y más.
💬 Entrega en tu chat privado, canales, grupos y temas del foro.
🖼 Fotos, vídeos, álbumes y archivos en calidad original.
⬇️ Texto completo: el bot extrae el artículo y lo abre en Instant View, con medios y sin anuncios.
🤖 Resumen IA: los artículos de webs y blogs en Instant View se abren con un resumen breve de Cocoon AI.
🧠 Enrutado inteligente: la IA detecta el tema y reparte las publicaciones.
⚡ Comprobaciones rápidas con intervalo personalizado.
©️ Medios sin marcas de agua ni logotipos.
⬇️ Modo descarga: envía un enlace de publicación y recibirás el medio.
✨ Procesamiento con IA: resumen, digest, reescritura, cambio de estilo y prompt propio (próximamente)

**Cómo usar**:
1) Envía un enlace de perfil o publicación
2) Elige dónde entregar
3) Pulsa Añadir — listo.`,
  'plan.free': 'Gratis',
  's2.title': '🔗 Añadir una fuente',
  's2.outro': 'Envía un enlace de cualquiera de estas fuentes y sigue las instrucciones.',
  's2.snapchat': 'solo enlaces individuales — usa el modo descarga',
  's3.checking': '⚪ Comprobando la fuente:',
  's4.question': '¿Dónde entregamos las publicaciones de esta fuente?',
  's4.hint': '⚠️ Para entregar en un canal o grupo, añade el bot como administrador con permiso para publicar — entonces el chat aparecerá en esta lista.',
  's4.category': '📂 Categoría: {name}',
  's5.question': '¿Cómo añadimos la fuente?',
  's6.added': 'La fuente «{title}» se añadió a tu feed. Recibirás las publicaciones nuevas en cuanto se publiquen.',
  's10.confirm': '🗑 ¿Eliminar la fuente «{title}»?\nSus publicaciones dejarán de llegar y se borrará la configuración de la suscripción.',
  's7.title': 'Lista de fuentes · Mensajes privados',
  's7.showing': 'Mostrando {from}–{to} de {total}',
  's7.empty': 'Mostrando 0 de 0',
  's7.card': '{title}\nid: #{id}, comprobada: {age}',
  'age.never': 'nunca',
  'prompt.download': '⬇️ Envía un enlace de publicación y te enviaré el medio aquí.',
  'prompt.downloadList': 'Compatible: webs/blogs, Instagram, X/Twitter, Bluesky, TikTok, Snapchat, Tumblr, Pinterest, Facebook, YouTube, Threads.',
  'done.download': '✅ Enviado.',
  'prompt.postLink': '🔗 Esto es un enlace de publicación.',
  'supported.title': '🌐 Sitios compatibles',
  'supported.rows': '📡 Webs y blogs — cualquier sitio con feed\n📸 Instagram — perfiles y publicaciones\n📘 Facebook — páginas, vídeos y reels\n🧵 Threads — perfiles y publicaciones\n✖️ X / Twitter — publicaciones\n🎵 TikTok — perfiles y enlaces de vídeo\n🦋 Bluesky — perfiles y publicaciones\n👻 Snapchat — solo modo descarga\n📝 Tumblr — blogs y publicaciones\n📌 Pinterest — perfiles y pines\n▶️ YouTube — canales, Shorts, vídeos y publicaciones',
  'supported.outro': 'Envía un enlace de perfil para suscribirte, o uno de publicación para descargarlo una vez.',
  'help.body': '❓ Cómo usar FeedBerry\n1) Envía un enlace de perfil o abre Sitios compatibles.\n2) Elige el chat donde deben llegar.\n3) Pulsa Añadir — listo.\nUsa el modo descarga para una sola publicación sin suscribirte.',
  'about.body': 'ℹ️ FeedBerry\n\nPublicaciones nuevas de las cuentas que sigues, directo a Telegram — fotos, vídeos, álbumes y artículos completos, sin anuncios.\n\n🆔 Tu ID: {id}\n\nPulsa /supported_sites para ver las fuentes disponibles.',
  'language.title': '🌐 Elige tu idioma:',
  'toast.unknown': 'Ese botón ya no está disponible.',
  'toast.slowDown': 'Un momento.',
  'toast.disabled': 'Fuente desactivada — no llegarán publicaciones nuevas.',
  'toast.enabled': 'Fuente activada.',
  'toast.deleted': 'Fuente eliminada.',
  'toast.checkQueued': 'Comprobación en cola — se consultará en un minuto.',
  'btn.add': '➕ Añadir fuente',
  'btn.sources': '📁 Mis fuentes',
  'btn.supported': '🌐 Sitios compatibles',
  'btn.help': '❓ Ayuda',
  'btn.download': '⬇️ Modo descarga',
  'btn.downloadMore': '⬇️ Descargar otra',
  'btn.downloadPost': '⬇️ Descargar',
  'btn.addPost': '➕ Añadir fuente',
  'btn.back': '← Atrás',
  'btn.home': '← Atrás',
  'btn.retry': '🔁 Reintentar',
  'btn.personal': '👤 Cuenta personal',
  'btn.addLatest': '🚀 Añadir y enviar lo último',
  'btn.addSilent': '➕ Añadir sin enviar',
  'btn.delete': '🗑 Eliminar',
  'btn.cancel': '← Cancelar',
  'btn.off': 'No',
  'btn.on': 'Sí',
  'btn.all': 'Todas',
  'err.E_LINK_INVALID': 'Ese enlace no es una fuente compatible.',
  'err.E_NO_FEED': 'No encontré un feed para esta página.',
  'err.E_PROFILE_ONLY': 'Esto es una página de exploración, no una publicación individual. Envía un enlace directo a la publicación, o uno de perfil para suscribirte.',
  'err.E_BOT_NOT_ADMIN': 'Añádeme como administrador con permiso para publicar y vuelve a intentarlo.',
  'err.E_FORUM_TOPIC': 'No puedo publicar en ese tema. Elige otro.',
  'err.E_SOURCE_LIMIT': 'Llegaste a 250 fuentes. Elimina una primero.',
  'err.E_DUPLICATE': 'Esta fuente ya está en tu lista.',
  'err.E_COOKIE_REQUIRED': 'Esta fuente requiere un inicio de sesión que el bot no tiene. Envía un enlace de publicación.',
  'err.E_RATE_LIMIT': 'La plataforma está limitando las comprobaciones. Reintentaremos.',
  'err.E_FEED_DOWN': 'La fuente no está disponible temporalmente.',
  'err.E_NO_MEDIA': 'No pude extraer el medio; envío el enlace.',
  'err.E_TOO_LARGE': 'El archivo es demasiado grande, así que envié una vista previa.',
  'err.E_MEDIA_GONE': 'El enlace del medio caducó. Reintentando.',
  'err.E_TELEGRAPH': 'No se pudo convertir el artículo; se envió el enlace.',
  'err.E_TG_PARSE': 'El formato no era compatible; se envió como texto.',
  'err.E_TG_FORBIDDEN': 'No puedo publicar en este chat.',
  'err.E_TG_429': 'Telegram pidió bajar el ritmo. Reintentando.',
  'err.E_TG_UNKNOWN': 'Algo salió mal. ¿Reintentar?',
  'err.E_POST_REQUIRED': 'Envía un enlace de publicación, no de perfil.',
  'err.E_DOWNLOAD_LIMIT': 'Límite diario de descargas alcanzado. Prueba mañana.',
  'err.E_SLOW_DOWN': 'De uno en uno — prueba en unos segundos.',
  'err.limitSources': '⚠️ Llegaste a {limit} fuentes. Elimina una primero.',
  'err.limitDownloads': '⚠️ Llegaste a {limit} descargas hoy.',

  'btn.schedule': '⏰ Horario',
  'schedule.title': '⏰ Horario de comprobación',
  'schedule.hint': 'Elige una fuente para cambiar cada cuánto la comprueba el bot.',
  'schedule.empty': 'Aún no hay fuentes — añade una y vuelve para ajustar su horario.',
  'schedule.current': 'Actual: {cadence}',
  'schedule.pickerHint': '¿Cada cuánto debe el bot comprobar esta fuente?',
  'schedule.default': '08:00 y 20:00',
  'schedule.defaultOption': 'Predeterminado · 08:00 y 20:00',
  'schedule.every': 'cada {value}',
  'schedule.setEvery': 'Cada {value}',
  'unit.minutes': '{n} min',
  'unit.hours': '{n} h',
  'schedule.shared': 'Una fuente mantiene un solo horario para todos sus suscriptores.',
  'schedule.allSources': '🌐 Todas las fuentes',
  'schedule.allTitle': '🌐 Todas las fuentes',
  'schedule.allHint': 'El mismo intervalo se aplica a todas las fuentes de tu lista.',
  'toast.scheduleSet': 'Horario actualizado.',
};

const HI: Partial<Dict> = {
  's1.body': `**FeedBerry** — आपके पसंदीदा अकाउंट की नई पोस्ट, सीधे Telegram पर।

🆔 आपकी ID: {id}
⭐ प्लान: {plan}
📊 स्रोत: {sources}

**सुविधाएँ**:
🌳 कम संसाधन: बहुत कम संसाधनों पर चलता है।
🌐 RSS, Instagram, TikTok, YouTube, Twitter/X, Facebook आदि से पोस्ट फ़ॉरवर्ड।
💬 DM, चैनल, ग्रुप और फ़ोरम टॉपिक में डिलीवरी।
🖼 फ़ोटो, वीडियो, एल्बम और फ़ाइलें मूल गुणवत्ता में।
⬇️ पूरा लेख: बॉट लिंक से लेख निकालकर Instant View में खोलता है, बिना विज्ञापन।
🤖 AI सारांश: वेबसाइट/ब्लॉग लेख Instant View में Cocoon AI का छोटा सारांश के साथ खुलते हैं।
🧠 स्मार्ट रूटिंग: AI पोस्ट का विषय पहचानकर सही चैट में भेजता है।
⚡ तेज़ जाँच: अपने अंतराल के साथ।
©️ वॉटरमार्क और लोगो के बिना मीडिया।
⬇️ डाउनलोड मोड: पोस्ट लिंक भेजें, बॉट मीडिया भेज देगा।
✨ AI प्रोसेसिंग: सारांश, डाइजेस्ट, पुनर्लेखन, शैली बदलाव और अपना प्रॉम्प्ट (जल्द आ रहा है)

**कैसे उपयोग करें**:
1) प्रोफ़ाइल या पोस्ट लिंक भेजें
2) चुनें कि कहाँ डिलीवर करना है
3) Add दबाएँ — हो गया।`,
  'plan.free': 'मुफ़्त',
  's2.title': '🔗 स्रोत जोड़ें',
  's2.outro': 'इनमें से किसी भी स्रोत का लिंक भेजें और निर्देशों का पालन करें।',
  's2.snapchat': 'केवल अलग लिंक — डाउनलोड मोड का उपयोग करें',
  's3.checking': '⚪ स्रोत जाँचा जा रहा है:',
  's4.question': 'इस स्रोत की पोस्ट कहाँ भेजें?',
  's4.hint': '⚠️ चैनल या ग्रुप में भेजने के लिए बॉट को वहाँ पोस्ट करने की अनुमति वाला एडमिन बनाएँ — तब वह चैट इस सूची में दिखेगी।',
  's4.category': '📂 श्रेणी: {name}',
  's5.question': 'स्रोत कैसे जोड़ें?',
  's6.added': 'स्रोत «{title}» जोड़ दिया गया। नई पोस्ट प्रकाशित होते ही आपको मिलेंगी।',
  's10.confirm': '🗑 स्रोत «{title}» हटाएँ?\nइसकी पोस्ट आना बंद हो जाएगा और सदस्यता सेटिंग हट जाएगी।',
  's7.title': 'स्रोत सूची · निजी संदेश',
  's7.showing': '{total} में से {from}–{to} दिखा रहे हैं',
  's7.empty': '0 में से 0 दिखा रहे हैं',
  's7.card': '{title}\nid: #{id}, जाँचा: {age}',
  'age.never': 'कभी नहीं',
  'prompt.download': '⬇️ पोस्ट लिंक भेजें, मैं मीडिया यहाँ भेज दूँगा।',
  'prompt.downloadList': 'समर्थित: वेबसाइट/ब्लॉग, Instagram, X/Twitter, Bluesky, TikTok, Snapchat, Tumblr, Pinterest, Facebook, YouTube, Threads.',
  'done.download': '✅ भेज दिया।',
  'prompt.postLink': '🔗 यह एक पोस्ट लिंक है।',
  'supported.title': '🌐 समर्थित साइटें',
  'supported.rows': '📡 वेबसाइट और ब्लॉग — फ़ीड वाली कोई भी साइट\n📸 Instagram — प्रोफ़ाइल और पोस्ट\n📘 Facebook — पेज, वीडियो और रील्स\n🧵 Threads — प्रोफ़ाइल और पोस्ट\n✖️ X / Twitter — पोस्ट\n🎵 TikTok — प्रोफ़ाइल और वीडियो लिंक\n🦋 Bluesky — प्रोफ़ाइल और पोस्ट\n👻 Snapchat — केवल डाउनलोड मोड\n📝 Tumblr — ब्लॉग और पोस्ट\n📌 Pinterest — प्रोफ़ाइल और पिन\n▶️ YouTube — चैनल, Shorts, वीडियो और पोस्ट',
  'supported.outro': 'सदस्यता के लिए प्रोफ़ाइल लिंक भेजें, या एक बार डाउनलोड के लिए पोस्ट लिंक।',
  'help.body': '❓ FeedBerry कैसे उपयोग करें\n1) प्रोफ़ाइल लिंक भेजें या समर्थित साइटें देखें।\n2) चुनें कि पोस्ट किस चैट में आएँ।\n3) Add दबाएँ — हो गया।\nएक पोस्ट के लिए डाउनलोड मोड का उपयोग करें।',
  'about.body': 'ℹ️ FeedBerry\n\nआपके फ़ॉलो किए अकाउंट की नई पोस्ट सीधे Telegram पर — फ़ोटो, वीडियो, एल्बम और पूरे लेख, बिना विज्ञापन।\n\n🆔 आपकी ID: {id}\n\nसाइटों की सूची के लिए /supported_sites दबाएँ।',
  'language.title': '🌐 अपनी भाषा चुनें:',
  'toast.unknown': 'यह बटन अब उपलब्ध नहीं है।',
  'toast.slowDown': 'थोड़ा धीरे।',
  'toast.disabled': 'स्रोत बंद — नई पोस्ट नहीं आएँगी।',
  'toast.enabled': 'स्रोत चालू।',
  'toast.deleted': 'स्रोत हटा दिया गया।',
  'toast.checkQueued': 'जाँच कतार में — एक मिनट में जाँचा जाएगा।',
  'btn.add': '➕ स्रोत जोड़ें',
  'btn.sources': '📁 मेरे स्रोत',
  'btn.supported': '🌐 समर्थित साइटें',
  'btn.help': '❓ सहायता',
  'btn.download': '⬇️ डाउनलोड मोड',
  'btn.downloadMore': '⬇️ और डाउनलोड करें',
  'btn.downloadPost': '⬇️ डाउनलोड',
  'btn.addPost': '➕ स्रोत जोड़ें',
  'btn.back': '← पीछे',
  'btn.home': '← पीछे',
  'btn.retry': '🔁 फिर कोशिश करें',
  'btn.personal': '👤 निजी अकाउंट',
  'btn.addLatest': '🚀 जोड़ें और नई पोस्ट भेजें',
  'btn.addSilent': '➕ बिना भेजे जोड़ें',
  'btn.delete': '🗑 हटाएँ',
  'btn.cancel': '← रद्द करें',
  'btn.off': 'बंद',
  'btn.on': 'चालू',
  'btn.all': 'सभी',
  'err.E_LINK_INVALID': 'यह लिंक समर्थित स्रोत नहीं है।',
  'err.E_NO_FEED': 'इस पेज के लिए फ़ीड नहीं मिली।',
  'err.E_PROFILE_ONLY': 'यह ब्राउज़ पेज है, एक पोस्ट नहीं। सीधा पोस्ट लिंक भेजें, या सदस्यता के लिए प्रोफ़ाइल लिंक।',
  'err.E_BOT_NOT_ADMIN': 'मुझे पोस्ट करने की अनुमति वाला एडमिन बनाएँ, फिर कोशिश करें।',
  'err.E_FORUM_TOPIC': 'इस टॉपिक में पोस्ट नहीं कर सकता। दूसरा चुनें।',
  'err.E_SOURCE_LIMIT': '250 स्रोतों की सीमा पूरी। पहले एक हटाएँ।',
  'err.E_DUPLICATE': 'यह स्रोत आपकी सूची में पहले से है।',
  'err.E_COOKIE_REQUIRED': 'इस स्रोत के लिए लॉगिन चाहिए जो बॉट के पास नहीं है। पोस्ट लिंक भेजें।',
  'err.E_RATE_LIMIT': 'प्लेटफ़ॉर्म जाँच सीमित कर रहा है। बाद में फिर कोशिश करेंगे।',
  'err.E_FEED_DOWN': 'स्रोत अस्थायी रूप से उपलब्ध नहीं है।',
  'err.E_NO_MEDIA': 'मीडिया नहीं निकल सका; लिंक भेज रहे हैं।',
  'err.E_TOO_LARGE': 'फ़ाइल बहुत बड़ी है, इसलिए प्रीव्यू भेजा गया।',
  'err.E_MEDIA_GONE': 'मीडिया लिंक समाप्त हो गया। फिर कोशिश कर रहे हैं।',
  'err.E_TELEGRAPH': 'लेख बदला नहीं जा सका, लिंक भेजा गया।',
  'err.E_TG_PARSE': 'फ़ॉर्मेटिंग समर्थित नहीं थी; सादे टेक्स्ट में भेजा गया।',
  'err.E_TG_FORBIDDEN': 'इस चैट में पोस्ट नहीं कर सकता।',
  'err.E_TG_429': 'Telegram ने धीमा होने को कहा। फिर कोशिश कर रहे हैं।',
  'err.E_TG_UNKNOWN': 'कुछ गड़बड़ हुई। फिर कोशिश करें?',
  'err.E_POST_REQUIRED': 'प्रोफ़ाइल नहीं, पोस्ट लिंक भेजें।',
  'err.E_DOWNLOAD_LIMIT': 'आज की डाउनलोड सीमा पूरी। कल कोशिश करें।',
  'err.E_SLOW_DOWN': 'एक बार में एक — कुछ सेकंड बाद कोशिश करें।',
  'err.limitSources': '⚠️ {limit} स्रोतों की सीमा पूरी। पहले एक हटाएँ।',
  'err.limitDownloads': '⚠️ आज {limit} डाउनलोड की सीमा पूरी।',

  'btn.schedule': '⏰ शेड्यूल',
  'schedule.title': '⏰ जाँच शेड्यूल',
  'schedule.hint': 'बॉट स्रोत को कितनी बार जाँचे, यह बदलने के लिए स्रोत चुनें।',
  'schedule.empty': 'अभी कोई स्रोत नहीं — पहले जोड़ें, फिर शेड्यूल सेट करने लौटें।',
  'schedule.current': 'वर्तमान: {cadence}',
  'schedule.pickerHint': 'बॉट इस स्रोत को कितनी बार जाँचे?',
  'schedule.default': '08:00 और 20:00',
  'schedule.defaultOption': 'डिफ़ॉल्ट · 08:00 और 20:00',
  'schedule.every': 'हर {value}',
  'schedule.setEvery': 'हर {value}',
  'unit.minutes': '{n} मिनट',
  'unit.hours': '{n} घंटे',
  'schedule.shared': 'एक स्रोत का एक ही शेड्यूल उसके सभी सब्सक्राइबर पर लागू होता है।',
  'schedule.allSources': '🌐 सभी स्रोत',
  'schedule.allTitle': '🌐 सभी स्रोत',
  'schedule.allHint': 'एक ही अंतराल आपकी सूची के सभी स्रोतों पर लागू होगा।',
  'toast.scheduleSet': 'शेड्यूल अपडेट हो गया।',
};

const TA: Partial<Dict> = {
  's1.body': `**FeedBerry** — உங்கள் விருப்பக் கணக்குகளின் புதிய இடுகைகள், நேரடியாக Telegram-க்கு.

🆔 உங்கள் ID: {id}
⭐ திட்டம்: {plan}
📊 மூலங்கள்: {sources}

**அம்சங்கள்**:
🌳 குறைந்த வளம்: மிகக் குறைந்த ஆற்றலில் இயங்கும்.
🌐 RSS, Instagram, TikTok, YouTube, Twitter/X, Facebook முதலியவற்றிலிருந்து இடுகைகள்.
💬 DM, சேனல், குழு மற்றும் ஃபோரம் தலைப்புகளுக்கு வழங்கல்.
🖼 புகைப்படங்கள், வீடியோக்கள், ஆல்பங்கள் அசல் தரத்தில்.
⬇️ முழு கட்டுரை: இணைப்பிலிருந்து கட்டுரையை எடுத்து Instant View-ல் திறக்கும், விளம்பரம் இல்லாமல்.
🤖 AI சுருக்கம்: வலைத்தள/வலைப்பதிவு கட்டுரைகள் Instant View-ல் Cocoon AI-யின் சுருக்கத்துடன் திறக்கும்.
🧠 ஸ்மார்ட் ரூட்டிங்: AI இடுகையின் தலைப்பை அறிந்து சரியான அரட்டைக்கு அனுப்பும்.
⚡ விரைவான சோதனை: உங்கள் இடைவெளியுடன்.
©️ நீர்அடையாளம் இல்லாத மீடியா.
⬇️ பதிவிறக்க முறை: இடுகை இணைப்பை அனுப்புங்கள், மீடியா வரும்.
✨ AI செயலாக்கம்: சுருக்கம், டைஜஸ்ட், மறுவடிவம், பாணி மாற்றம் மற்றும் உங்கள் ப்ராம்ப்ட் (விரைவில்)

**எப்படி பயன்படுத்துவது**:
1) சுயவிவரம் அல்லது இடுகை இணைப்பை அனுப்புங்கள்
2) எங்கு வழங்குவது என்பதைத் தேர்ந்தெடுக்கவும்
3) Add அழுத்தவும் — முடிந்தது.`,
  'plan.free': 'இலவசம்',
  's2.title': '🔗 மூலத்தைச் சேர்த்தல்',
  's2.outro': 'இந்த மூலங்களில் ஏதேனும் ஒரு இணைப்பை அனுப்பி வழிமுறைகளைப் பின்பற்றவும்.',
  's2.snapchat': 'தனி இணைப்புகள் மட்டும் — பதிவிறக்க முறையைப் பயன்படுத்தவும்',
  's3.checking': '⚪ மூலம் சரிபார்க்கப்படுகிறது:',
  's4.question': 'இந்த மூலத்தின் இடுகைகளை எங்கு வழங்க வேண்டும்?',
  's4.hint': '⚠️ சேனல் அல்லது குழுவுக்கு வழங்க, போட்டை அங்கு இடுகையிட அனுமதியுள்ள நிர்வாகியாகச் சேர்க்கவும் — பின்னர் அந்த அரட்டை இந்தப் பட்டியலில் தோன்றும்.',
  's4.category': '📂 வகை: {name}',
  's5.question': 'மூலத்தை எப்படிச் சேர்ப்பது?',
  's6.added': '«{title}» மூலம் சேர்க்கப்பட்டது. புதிய இடுகைகள் வெளியானவுடன் வரும்.',
  's10.confirm': '🗑 «{title}» மூலத்தை நீக்கவா?\nஇடுகைகள் வருவது நிற்கும், சந்தா அமைப்புகள் நீக்கப்படும்.',
  's7.title': 'மூலப் பட்டியல் · தனிப்பட்ட செய்திகள்',
  's7.showing': '{total}-ல் {from}–{to} காட்டப்படுகிறது',
  's7.empty': '0-ல் 0 காட்டப்படுகிறது',
  's7.card': '{title}\nid: #{id}, சரிபார்க்கப்பட்டது: {age}',
  'age.never': 'ஒருபோதும் இல்லை',
  'prompt.download': '⬇️ இடுகை இணைப்பை அனுப்புங்கள், மீடியாவை இங்கே அனுப்புகிறேன்.',
  'prompt.downloadList': 'ஆதரவு: வலைத்தளங்கள்/வலைப்பதிவுகள், Instagram, X/Twitter, Bluesky, TikTok, Snapchat, Tumblr, Pinterest, Facebook, YouTube, Threads.',
  'done.download': '✅ அனுப்பப்பட்டது.',
  'prompt.postLink': '🔗 இது ஒரு இடுகை இணைப்பு.',
  'supported.title': '🌐 ஆதரிக்கப்படும் தளங்கள்',
  'supported.rows': '📡 வலைத்தளங்கள் மற்றும் வலைப்பதிவுகள் — ஃபீட் உள்ள எந்தத் தளமும்\n📸 Instagram — சுயவிவரங்கள் மற்றும் இடுகைகள்\n📘 Facebook — பக்கங்கள், வீடியோக்கள், ரீல்கள்\n🧵 Threads — சுயவிவரங்கள் மற்றும் இடுகைகள்\n✖️ X / Twitter — இடுகைகள்\n🎵 TikTok — சுயவிவரங்கள் மற்றும் வீடியோ இணைப்புகள்\n🦋 Bluesky — சுயவிவரங்கள் மற்றும் இடுகைகள்\n👻 Snapchat — பதிவிறக்க முறை மட்டும்\n📝 Tumblr — வலைப்பதிவுகள் மற்றும் இடுகைகள்\n📌 Pinterest — சுயவிவரங்கள் மற்றும் பின்கள்\n▶️ YouTube — சேனல்கள், Shorts, வீடியோக்கள் மற்றும் இடுகைகள்',
  'supported.outro': 'சந்தா செய்ய சுயவிவர இணைப்பையும், ஒருமுறை பதிவிறக்க இடுகை இணைப்பையும் அனுப்புங்கள்.',
  'help.body': '❓ FeedBerry பயன்படுத்துவது எப்படி\n1) சுயவிவர இணைப்பை அனுப்புங்கள் அல்லது ஆதரிக்கப்படும் தளங்களைத் திறக்கவும்.\n2) இடுகைகள் வர வேண்டிய அரட்டையைத் தேர்ந்தெடுக்கவும்.\n3) Add அழுத்தவும் — முடிந்தது.\nஒரு இடுகைக்கு பதிவிறக்க முறையைப் பயன்படுத்தவும்.',
  'about.body': 'ℹ️ FeedBerry\n\nநீங்கள் பின்தொடரும் கணக்குகளின் புதிய இடுகைகள் நேரடியாக Telegram-க்கு — புகைப்படங்கள், வீடியோக்கள், ஆல்பங்கள் மற்றும் முழு கட்டுரைகள், விளம்பரம் இல்லாமல்.\n\n🆔 உங்கள் ID: {id}\n\nதளங்களின் பட்டியலுக்கு /supported_sites அழுத்தவும்.',
  'language.title': '🌐 உங்கள் மொழியைத் தேர்ந்தெடுக்கவும்:',
  'toast.unknown': 'அந்த பொத்தான் இனி இல்லை.',
  'toast.slowDown': 'சற்று மெதுவாக.',
  'toast.disabled': 'மூலம் முடக்கப்பட்டது — புதிய இடுகைகள் வராது.',
  'toast.enabled': 'மூலம் இயக்கப்பட்டது.',
  'toast.deleted': 'மூலம் நீக்கப்பட்டது.',
  'toast.checkQueued': 'சரிபார்ப்பு வரிசையில் — ஒரு நிமிடத்தில் சரிபார்க்கப்படும்.',
  'btn.add': '➕ மூலத்தைச் சேர்',
  'btn.sources': '📁 எனது மூலங்கள்',
  'btn.supported': '🌐 ஆதரிக்கப்படும் தளங்கள்',
  'btn.help': '❓ உதவி',
  'btn.download': '⬇️ பதிவிறக்க முறை',
  'btn.downloadMore': '⬇️ மேலும் பதிவிறக்கு',
  'btn.downloadPost': '⬇️ பதிவிறக்கு',
  'btn.addPost': '➕ மூலத்தைச் சேர்',
  'btn.back': '← பின்',
  'btn.home': '← பின்',
  'btn.retry': '🔁 மீண்டும்',
  'btn.personal': '👤 தனிப்பட்ட கணக்கு',
  'btn.addLatest': '🚀 சேர்த்து சமீபத்தியதை அனுப்பு',
  'btn.addSilent': '➕ அனுப்பாமல் சேர்',
  'btn.delete': '🗑 நீக்கு',
  'btn.cancel': '← ரத்து',
  'btn.off': 'ஆஃப்',
  'btn.on': 'ஆன்',
  'btn.all': 'அனைத்தும்',
  'err.E_LINK_INVALID': 'இந்த இணைப்பு ஆதரிக்கப்படவில்லை.',
  'err.E_NO_FEED': 'இந்தப் பக்கத்திற்கு ஃபீட் கிடைக்கவில்லை.',
  'err.E_PROFILE_ONLY': 'இது உலாவல் பக்கம், இடுகை அல்ல. இடுகையின் நேரடி இணைப்பையோ, சந்தா செய்ய சுயவிவர இணைப்பையோ அனுப்புங்கள்.',
  'err.E_BOT_NOT_ADMIN': 'இடுகையிட அனுமதியுள்ள நிர்வாகியாக என்னைச் சேர்க்கவும், பிறகு முயலவும்.',
  'err.E_FORUM_TOPIC': 'இந்தத் தலைப்பில் இடுகையிட முடியாது. வேறொன்றைத் தேர்ந்தெடுக்கவும்.',
  'err.E_SOURCE_LIMIT': '250 மூலங்கள் வரம்பு முடிந்தது. ஒன்றை நீக்கவும்.',
  'err.E_DUPLICATE': 'இந்த மூலம் ஏற்கனவே பட்டியலில் உள்ளது.',
  'err.E_COOKIE_REQUIRED': 'இந்த மூலத்திற்கு போட்டிடம் இல்லாத உள்நுழைவு தேவை. இடுகை இணைப்பை அனுப்புங்கள்.',
  'err.E_RATE_LIMIT': 'தளம் சோதனைகளைக் கட்டுப்படுத்துகிறது. பிறகு முயல்வோம்.',
  'err.E_FEED_DOWN': 'மூலம் தற்காலிகமாக கிடைக்கவில்லை.',
  'err.E_NO_MEDIA': 'மீடியாவை எடுக்க முடியவில்லை; இணைப்பை அனுப்புகிறேன்.',
  'err.E_TOO_LARGE': 'கோப்பு மிகப் பெரியது, எனவே முன்னோட்டம் அனுப்பப்பட்டது.',
  'err.E_MEDIA_GONE': 'மீடியா இணைப்பு காலாவதியானது. மீண்டும் முயல்கிறேன்.',
  'err.E_TELEGRAPH': 'கட்டுரையை மாற்ற முடியவில்லை; இணைப்பு அனுப்பப்பட்டது.',
  'err.E_TG_PARSE': 'வடிவமைப்பு ஆதரிக்கப்படவில்லை; எளிய உரையாக அனுப்பப்பட்டது.',
  'err.E_TG_FORBIDDEN': 'இந்த அரட்டையில் இடுகையிட முடியாது.',
  'err.E_TG_429': 'Telegram மெதுவாகச் செல்லச் சொன்னது. மீண்டும் முயல்கிறேன்.',
  'err.E_TG_UNKNOWN': 'ஏதோ தவறு நடந்தது. மீண்டும் முயலவா?',
  'err.E_POST_REQUIRED': 'சுயவிவரம் அல்ல, இடுகை இணைப்பை அனுப்புங்கள்.',
  'err.E_DOWNLOAD_LIMIT': 'இன்றைய பதிவிறக்க வரம்பு முடிந்தது. நாளை முயலவும்.',
  'err.E_SLOW_DOWN': 'ஒன்று ஒன்றாக — சில வினாடிகளில் முயலவும்.',
  'err.limitSources': '⚠️ {limit} மூலங்கள் வரம்பு முடிந்தது. ஒன்றை நீக்கவும்.',
  'err.limitDownloads': '⚠️ இன்று {limit} பதிவிறக்கங்கள் வரம்பு முடிந்தது.',

  'btn.schedule': '⏰ அட்டவணை',
  'schedule.title': '⏰ சோதனை அட்டவணை',
  'schedule.hint': 'மூலத்தை எంత அடிக்கடி சோதிப்பது என மாற்ற மூலத்தைத் தேர்ந்தெடுக்கவும்.',
  'schedule.empty': 'இன்னும் மூலங்கள் இல்லை — ஒன்றைச் சேர்த்துவிட்டு அட்டவணை அமைக்க திரும்பவும்.',
  'schedule.current': 'தற்போது: {cadence}',
  'schedule.pickerHint': 'இந்த மூலத்தை எంత அடிக்கடி சோதிக்க வேண்டும்?',
  'schedule.default': '08:00 & 20:00',
  'schedule.defaultOption': 'இயல்பு · 08:00 & 20:00',
  'schedule.every': '{value}-க்கு ஒருமுறை',
  'schedule.setEvery': '{value}-க்கு ஒருமுறை',
  'unit.minutes': '{n} நிமி',
  'unit.hours': '{n} மணி',
  'schedule.shared': 'ஒரு மூலத்தின் அட்டவணை அதைப் பின்தொடரும் அனைவருக்கும் ஒன்றே.',
  'schedule.allSources': '🌐 அனைத்து மூலங்கள்',
  'schedule.allTitle': '🌐 அனைத்து மூலங்கள்',
  'schedule.allHint': 'உங்கள் பட்டியலில் உள்ள அனைத்து மூலங்களுக்கும் ஒரே இடைவெளி.',
  'toast.scheduleSet': 'அட்டவணை புதுப்பிக்கப்பட்டது.',
};

const ID: Partial<Dict> = {
  's1.body': `**FeedBerry** — postingan baru dari akun favoritmu, langsung ke Telegram.

🆔 ID kamu: {id}
⭐ Paket: {plan}
📊 Sumber: {sources}

**Fitur**:
🌳 Hemat: hanya memakai sedikit sumber daya.
🌐 Meneruskan postingan dari RSS, Instagram, TikTok, YouTube, Twitter/X, Facebook, dan lainnya.
💬 Kirim ke DM, channel, grup, dan topik forum.
🖼 Foto, video, album, dan berkas dengan kualitas asli.
⬇️ Teks artikel lengkap: bot mengambil artikel dan membukanya di Instant View, dengan media dan tanpa iklan.
🤖 Ringkasan AI: artikel situs/blog di Instant View terbuka dengan ringkasan singkat dari Cocoon AI.
🧠 Perutean pintar: AI mengenali topik postingan dan mengirimnya ke chat yang tepat.
⚡ Pemeriksaan cepat dengan interval sendiri.
©️ Media tanpa watermark dan logo.
⬇️ Mode unduh: kirim tautan postingan, bot mengirim medianya.
✨ Pemrosesan AI: ringkasan, digest, parafrase, ubah gaya, dan prompt sendiri (segera hadir)

**Cara pakai**:
1) Kirim tautan profil atau postingan
2) Pilih tujuan pengiriman
3) Tekan Add — selesai.`,
  'plan.free': 'Gratis',
  's2.title': '🔗 Menambahkan sumber',
  's2.outro': 'Kirim tautan salah satu sumber ini dan ikuti petunjuknya.',
  's2.snapchat': 'hanya tautan tunggal — gunakan Mode Unduh',
  's3.checking': '⚪ Memeriksa sumber:',
  's4.question': 'Ke mana postingan dari sumber ini dikirim?',
  's4.hint': '⚠️ Untuk mengirim ke channel atau grup, tambahkan bot sebagai admin dengan izin memposting — chat itu akan muncul di daftar ini.',
  's4.category': '📂 Kategori: {name}',
  's5.question': 'Bagaimana sumber ini ditambahkan?',
  's6.added': 'Sumber «{title}» ditambahkan. Kamu akan menerima postingan baru begitu diterbitkan.',
  's10.confirm': '🗑 Hapus sumber «{title}»?\nPostingannya berhenti datang dan pengaturan langganan dihapus.',
  's7.title': 'Daftar sumber · Pesan pribadi',
  's7.showing': 'Menampilkan {from}–{to} dari {total}',
  's7.empty': 'Menampilkan 0 dari 0',
  's7.card': '{title}\nid: #{id}, diperiksa: {age}',
  'age.never': 'belum pernah',
  'prompt.download': '⬇️ Kirim tautan postingan, saya kirim medianya di sini.',
  'prompt.downloadList': 'Didukung: situs/blog, Instagram, X/Twitter, Bluesky, TikTok, Snapchat, Tumblr, Pinterest, Facebook, YouTube, Threads.',
  'done.download': '✅ Terkirim.',
  'prompt.postLink': '🔗 Ini tautan postingan.',
  'supported.title': '🌐 Situs yang didukung',
  'supported.rows': '📡 Situs & blog — situs apa pun dengan feed\n📸 Instagram — profil dan postingan\n📘 Facebook — halaman, video, dan reels\n🧵 Threads — profil dan postingan\n✖️ X / Twitter — postingan\n🎵 TikTok — profil dan tautan video\n🦋 Bluesky — profil dan postingan\n👻 Snapchat — hanya Mode Unduh\n📝 Tumblr — blog dan postingan\n📌 Pinterest — profil dan pin\n▶️ YouTube — channel, Shorts, video dan postingan',
  'supported.outro': 'Kirim tautan profil untuk berlangganan, atau tautan postingan untuk mengunduh sekali.',
  'help.body': '❓ Cara memakai FeedBerry\n1) Kirim tautan profil atau buka Situs yang didukung.\n2) Pilih chat tujuan postingan.\n3) Tekan Add — selesai.\nGunakan Mode Unduh untuk satu postingan tanpa berlangganan.',
  'about.body': 'ℹ️ FeedBerry\n\nPostingan baru dari akun yang kamu ikuti, langsung ke Telegram — foto, video, album, dan artikel penuh, tanpa iklan.\n\n🆔 ID kamu: {id}\n\nTekan /supported_sites untuk melihat daftar situs.',
  'language.title': '🌐 Pilih bahasa kamu:',
  'toast.unknown': 'Tombol itu sudah tidak tersedia.',
  'toast.slowDown': 'Pelan sedikit.',
  'toast.disabled': 'Sumber dimatikan — postingan baru tidak akan datang.',
  'toast.enabled': 'Sumber diaktifkan.',
  'toast.deleted': 'Sumber dihapus.',
  'toast.checkQueued': 'Pemeriksaan dalam antrean — sumber dicek dalam satu menit.',
  'btn.add': '➕ Tambah Sumber',
  'btn.sources': '📁 Sumber Saya',
  'btn.supported': '🌐 Situs yang Didukung',
  'btn.help': '❓ Bantuan',
  'btn.download': '⬇️ Mode Unduh',
  'btn.downloadMore': '⬇️ Unduh lagi',
  'btn.downloadPost': '⬇️ Unduh',
  'btn.addPost': '➕ Tambah sumber',
  'btn.back': '← Kembali',
  'btn.home': '← Kembali',
  'btn.retry': '🔁 Coba lagi',
  'btn.personal': '👤 Akun pribadi',
  'btn.addLatest': '🚀 Tambah dan kirim postingan terbaru',
  'btn.addSilent': '➕ Tambah tanpa mengirim',
  'btn.delete': '🗑 Hapus',
  'btn.cancel': '← Batal',
  'btn.off': 'Mati',
  'btn.on': 'Hidup',
  'btn.all': 'Semua',
  'err.E_LINK_INVALID': 'Tautan itu bukan sumber yang didukung.',
  'err.E_NO_FEED': 'Tidak menemukan feed untuk halaman ini.',
  'err.E_PROFILE_ONLY': 'Ini halaman jelajah, bukan satu postingan. Kirim tautan langsung ke postingan, atau tautan profil untuk berlangganan.',
  'err.E_BOT_NOT_ADMIN': 'Jadikan saya admin dengan izin memposting, lalu coba lagi.',
  'err.E_FORUM_TOPIC': 'Tidak bisa memposting ke topik itu. Pilih yang lain.',
  'err.E_SOURCE_LIMIT': 'Kamu mencapai 250 sumber. Hapus satu dulu.',
  'err.E_DUPLICATE': 'Sumber ini sudah ada di daftarmu.',
  'err.E_COOKIE_REQUIRED': 'Sumber ini butuh login yang tidak dimiliki bot. Kirim satu tautan postingan.',
  'err.E_RATE_LIMIT': 'Platform membatasi pemeriksaan. Akan dicoba lagi nanti.',
  'err.E_FEED_DOWN': 'Sumber sementara tidak bisa diakses.',
  'err.E_NO_MEDIA': 'Media tidak bisa diambil; mengirim tautannya.',
  'err.E_TOO_LARGE': 'Berkas terlalu besar, jadi pratinjau yang dikirim.',
  'err.E_MEDIA_GONE': 'Tautan media kedaluwarsa. Mencoba dengan pemeriksaan baru.',
  'err.E_TELEGRAPH': 'Artikel tidak bisa dikonversi, tautannya dikirim.',
  'err.E_TG_PARSE': 'Format tidak didukung; dikirim sebagai teks biasa.',
  'err.E_TG_FORBIDDEN': 'Saya tidak bisa memposting ke chat ini.',
  'err.E_TG_429': 'Telegram meminta melambat. Mencoba lagi.',
  'err.E_TG_UNKNOWN': 'Ada yang salah. Coba lagi?',
  'err.E_POST_REQUIRED': 'Kirim tautan postingan, bukan profil.',
  'err.E_DOWNLOAD_LIMIT': 'Batas unduhan harian tercapai. Coba besok.',
  'err.E_SLOW_DOWN': 'Satu per satu — coba lagi beberapa detik.',
  'err.limitSources': '⚠️ Kamu mencapai {limit} sumber. Hapus satu dulu.',
  'err.limitDownloads': '⚠️ Kamu mencapai {limit} unduhan hari ini.',

  'btn.schedule': '⏰ Jadwal',
  'schedule.title': '⏰ Jadwal pemeriksaan',
  'schedule.hint': 'Pilih sumber untuk mengubah seberapa sering bot memeriksanya.',
  'schedule.empty': 'Belum ada sumber — tambahkan satu, lalu kembali untuk mengatur jadwalnya.',
  'schedule.current': 'Saat ini: {cadence}',
  'schedule.pickerHint': 'Seberapa sering bot memeriksa sumber ini?',
  'schedule.default': '08:00 & 20:00',
  'schedule.defaultOption': 'Bawaan · 08:00 & 20:00',
  'schedule.every': 'setiap {value}',
  'schedule.setEvery': 'Setiap {value}',
  'unit.minutes': '{n} mnt',
  'unit.hours': '{n} j',
  'schedule.shared': 'Satu sumber punya satu jadwal untuk semua pelanggannya.',
  'schedule.allSources': '🌐 Semua sumber',
  'schedule.allTitle': '🌐 Semua sumber',
  'schedule.allHint': 'Interval yang sama berlaku untuk semua sumber di daftarmu.',
  'toast.scheduleSet': 'Jadwal diperbarui.',
};

const DICTS: Record<Lang, Partial<Dict>> = { en: EN, ru: RU, es: ES, hi: HI, ta: TA, id: ID };

/** Look up one key, substituting `{name}` placeholders. Missing translations use English. */
export function t(lang: Lang, key: TextKey, vars?: Record<string, string | number>): string {
  const template = DICTS[lang][key] ?? EN[key];
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? ''));
}
