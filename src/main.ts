/** Boot order: config -> db -> bot -> worker -> tick (IMPLEMENTATION_PLAN §2). */
import { createBot } from './bot/index.ts';
import { parseConfig, type Config } from './config.ts';
import { openDb, schemaVersion } from './db/index.ts';
import { log } from './obs/log.ts';

let cfg: Config;
try {
  cfg = parseConfig(process.env);
} catch (err) {
  console.error(`FeedBerry: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

const db = openDb(cfg.dbPath);
const bot = createBot({ cfg, db });

log('info', 'boot', { schema: schemaVersion(db), db: cfg.dbPath, rsshub: cfg.rsshubBase });

await bot.start({
  allowed_updates: ['message', 'callback_query', 'my_chat_member'],
  drop_pending_updates: false,
  onStart: (me) => log('info', 'polling_started', { bot: me.username }),
});
