/** JSON line logs to stdout with the redactions of ARCHITECTURE §12.1. */

// No leading \b: the token sits right after "bot" in api.telegram.org/bot<token>/method.
const BOT_TOKEN = /\d{6,}:[A-Za-z0-9_-]{30,}/g;
const COOKIE_HEADER = /(cookie["']?\s*[:=]\s*)[^\n"']+/gi;
const RSSHUB_KEY = /(access_?key=)[^&\s"']+/gi;

export function redact(line: string): string {
  return line.replace(BOT_TOKEN, '[redacted-token]').replace(COOKIE_HEADER, '$1[redacted]').replace(RSSHUB_KEY, '$1[redacted]');
}

export type Level = 'info' | 'warn' | 'error';

export function log(level: Level, code: string, fields: Record<string, unknown> = {}): void {
  process.stdout.write(redact(JSON.stringify({ ts: new Date().toISOString(), level, code, ...fields })) + '\n');
}
