/**
 * Config from env. Limits are config, never hard-coded (ARCHITECTURE §6).
 * Pure function so tests can pass their own env.
 */
export interface Limits {
  maxSourcesPerUser: number;
  maxChatsPerUser: number;
  maxDownloadMb: number;
  backfillCount: number;
  maxSourceAgeDays: number;
  workerConcurrency: number;
  maxDownloadsPerDay: number;
  /** §12.4 abuse quotas: one callback per 2 s, one source-add per 10 s, 30 checks per hour. */
  callbackIntervalMs: number;
  addIntervalMs: number;
  checksPerHour: number;
}

export interface Config {
  botToken: string;
  adminChatId: number;
  rsshubBase: string;
  dbPath: string;
  /** Point at a self-hosted Bot API server (or a local fake in tests); default api.telegram.org. */
  telegramApiRoot: string | undefined;
  limits: Limits;
  trialEnabled: boolean;
  telegramBeta: boolean;
}

export function parseConfig(env: NodeJS.ProcessEnv): Config {
  const botToken = (env.BOT_TOKEN ?? '').trim();
  if (!botToken) {
    throw new Error('BOT_TOKEN is missing. Copy .env.example to .env and paste the token from @BotFather.');
  }

  const adminChatId = int(env.ADMIN_CHAT_ID, undefined, 'ADMIN_CHAT_ID');

  const rsshubBase = (env.RSSHUB_BASE ?? '').trim().replace(/\/+$/, '');
  if (!rsshubBase) throw new Error('RSSHUB_BASE is missing. Set it to your self-hosted RSSHub, e.g. http://rsshub:1200.');
  if (!/^https?:\/\//.test(rsshubBase)) throw new Error(`RSSHUB_BASE must start with http:// or https://, got "${rsshubBase}".`);

  return {
    botToken,
    adminChatId,
    rsshubBase,
    dbPath: (env.DB_PATH ?? '').trim() || 'data/bot.db',
    telegramApiRoot: (env.TELEGRAM_API_ROOT ?? '').trim() || undefined,
    limits: {
      maxSourcesPerUser: int(env.MAX_SOURCES_PER_USER, 250, 'MAX_SOURCES_PER_USER'),
      maxChatsPerUser: int(env.MAX_CHATS_PER_USER, 20, 'MAX_CHATS_PER_USER'),
      maxDownloadMb: int(env.MAX_DOWNLOAD_MB, 100, 'MAX_DOWNLOAD_MB'),
      backfillCount: int(env.BACKFILL_COUNT, 5, 'BACKFILL_COUNT'),
      maxSourceAgeDays: int(env.MAX_SOURCE_AGE_DAYS, 30, 'MAX_SOURCE_AGE_DAYS'),
      workerConcurrency: int(env.WORKER_CONCURRENCY, 2, 'WORKER_CONCURRENCY'),
      maxDownloadsPerDay: int(env.MAX_DOWNLOADS_PER_DAY, 30, 'MAX_DOWNLOADS_PER_DAY'),
      callbackIntervalMs: atLeastZero(env.CALLBACK_INTERVAL_MS, 2000, 'CALLBACK_INTERVAL_MS'),
      addIntervalMs: atLeastZero(env.ADD_INTERVAL_MS, 10_000, 'ADD_INTERVAL_MS'),
      checksPerHour: atLeastZero(env.CHECKS_PER_HOUR, 30, 'CHECKS_PER_HOUR'),
    },
    trialEnabled: flag(env.TRIAL_ENABLED),
    telegramBeta: flag(env.TELEGRAM_BETA),
  };
}

/** Positive integer from env, or `fallback` when unset; throws on garbage rather than guessing. */
function int(raw: string | undefined, fallback: number | undefined, name: string): number {
  const value = (raw ?? '').trim();
  if (!value) {
    if (fallback === undefined) throw new Error(`${name} is missing. See .env.example.`);
    return fallback;
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer, got "${value}".`);
  return n;
}

function atLeastZero(raw: string | undefined, fallback: number, name: string): number {
  const value = (raw ?? '').trim();
  if (!value) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer, got "${value}".`);
  return n;
}

function flag(raw: string | undefined): boolean {
  const value = (raw ?? '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}
