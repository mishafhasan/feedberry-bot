/** Boot order: config -> db -> bot -> worker -> tick (IMPLEMENTATION_PLAN §2). */
import { createBot, networkFor } from './bot/index.ts';
import { parseConfig, type Config } from './config.ts';
import { openDb, schemaVersion } from './db/index.ts';
import { startWorker } from './jobs/worker.ts';
import { cobaltEngine } from './media/cobalt.ts';
import { ffmpegThumbnail } from './media/thumb.ts';
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
const bot = createBot({ cfg, db, http, media: cobaltEngine });

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
  workerConcurrency: cfg.limits.workerConcurrency,
});

await bot.start({
  allowed_updates: ['message', 'callback_query', 'my_chat_member'],
  drop_pending_updates: false,
  onStart: (me) => log('info', 'polling_started', { bot: me.username }),
});

worker.stop();
