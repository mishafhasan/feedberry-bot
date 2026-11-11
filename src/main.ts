/** Boot order: config -> db -> bot -> worker -> tick (IMPLEMENTATION_PLAN §2). */
import { setCookies } from 'cobalt-engine';
import { createBot, networkFor } from './bot/index.ts';
import { telegraphClient } from './article/telegraph.ts';
import { parseConfig, type Config } from './config.ts';
import { openDb, schemaVersion } from './db/index.ts';
import { startWorker } from './jobs/worker.ts';
import { cobaltEngine } from './media/media-engine.ts';
import { ffmpegThumbnail } from './media/thumbnail.ts';
import type { Notifier } from './obs/alerts.ts';
import { log } from './obs/log.ts';
import { TelegramSender } from './telegram/api.ts';

let cfg: Config;
try {
  cfg = parseConfig(process.env);
} catch (err) {
  console.error(`FeedBerry: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

const db = openDb(cfg.dbPath);
const http = networkFor(cfg);
// X refuses gated media to guests; the same auth_token RSSHub uses makes the extraction call signed in.
if (cfg.twitterAuthToken) setCookies({ twitter: [`auth_token=${cfg.twitterAuthToken}`] });
const bot = createBot({ cfg, db, http, media: cobaltEngine, telegraph: telegraphClient, apiRoot: cfg.telegramApiRoot });

log('info', 'boot', { schema: schemaVersion(db), db: cfg.dbPath, rsshub: cfg.rsshubBase });

const sender = new TelegramSender(bot.api);
const notifier: Notifier = {
  notify: (text) => sender.sendText({ chatId: cfg.adminChatId, messageThreadId: null, isGroup: false }, text).then(() => undefined),
};

const worker = startWorker({
  db,
  http,
  cfg,
  media: cobaltEngine,
  thumbnail: ffmpegThumbnail,
  notifier,
  sender,
  telegraph: telegraphClient,
  workerConcurrency: cfg.limits.workerConcurrency,
});

await bot.start({
  allowed_updates: ['message', 'callback_query', 'my_chat_member'],
  drop_pending_updates: false,
  onStart: (me) => log('info', 'polling_started', { bot: me.username }),
});

worker.stop();
