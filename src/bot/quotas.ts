/**
 * §12.4 abuse quotas, in memory: 1 callback per 2 s, 1 source-add per 10 s, 30 manual checks per
 * hour. A user who trips one gets a toast, never an exception.
 */
interface UserWindow {
  lastAdd: number;
  lastCallback: number;
  checks: number[];
}

const HOUR_MS = 60 * 60 * 1000;

const users = new Map<number, UserWindow>();

function windowOf(userId: number): UserWindow {
  let window = users.get(userId);
  if (!window) {
    // -Infinity means "never": a first action must always pass, whatever the clock says.
    window = { lastAdd: Number.NEGATIVE_INFINITY, lastCallback: Number.NEGATIVE_INFINITY, checks: [] };
    users.set(userId, window);
  }
  return window;
}

export function allowCallback(userId: number, minIntervalMs: number, now = Date.now()): boolean {
  if (minIntervalMs <= 0) return true;
  const window = windowOf(userId);
  if (now - window.lastCallback < minIntervalMs) return false;
  window.lastCallback = now;
  return true;
}

export function allowAdd(userId: number, minIntervalMs: number, now = Date.now()): boolean {
  if (minIntervalMs <= 0) return true;
  const window = windowOf(userId);
  if (now - window.lastAdd < minIntervalMs) return false;
  window.lastAdd = now;
  return true;
}

export function allowCheck(userId: number, perHour: number, now = Date.now()): boolean {
  if (perHour <= 0) return true;
  const window = windowOf(userId);
  window.checks = window.checks.filter((at) => now - at < HOUR_MS);
  if (window.checks.length >= perHour) return false;
  window.checks.push(now);
  return true;
}

export function resetQuotas(): void {
  users.clear();
}
