/**
 * Slot math of ARCHITECTURE §4.3: 08:00 and 20:00 in the owner's timezone, or now + interval.
 * DST is handled by recomputing wall-clock → UTC at the candidate, never by adding 12 h.
 */

const SLOT_HOURS = [8, 20] as const;

export function slotAfter(now: number, tz: string, intervalMinutes: number | null): number {
  if (intervalMinutes && intervalMinutes > 0) return now + intervalMinutes * 60_000;

  const today = wallClock(now, tz);
  for (const dayOffset of [0, 1]) {
    for (const hour of SLOT_HOURS) {
      const candidate = wallToUtc(today.year, today.month, today.day + dayOffset, hour, tz);
      if (candidate > now) return candidate;
    }
  }
  // Unreachable for any real zone: tomorrow 08:00 local always exists.
  return wallToUtc(today.year, today.month, today.day + 2, 8, tz);
}

/**
 * ADR-029: the next `hour:00` in the owner's zone. Same wall-clock arithmetic as the source slots,
 * so a DST change shifts the digest with the clock instead of by a fixed 24 h.
 */
export function digestSlot(now: number, tz: string, hour: number): number {
  const today = wallClock(now, tz);
  for (const dayOffset of [0, 1]) {
    const candidate = wallToUtc(today.year, today.month, today.day + dayOffset, hour, tz);
    if (candidate > now) return candidate;
  }
  return wallToUtc(today.year, today.month, today.day + 2, hour, tz);
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/**
 * One probe per zone name. `Intl` throws on a zone it does not know, and the tick swallows that into a
 * log line — one bad `users.tz` would otherwise stop every user's schedule, every tick.
 */
const knownZones = new Map<string, boolean>();

function zoneOrUtc(tz: string): string {
  // `Intl` accepts `undefined` as "the host zone" without throwing, which must not become the fallback.
  if (!tz) return 'UTC';
  let ok = knownZones.get(tz);
  if (ok === undefined) {
    try {
      new Intl.DateTimeFormat('en', { timeZone: tz });
      ok = true;
    } catch {
      ok = false;
    }
    knownZones.set(tz, ok);
  }
  return ok ? tz : 'UTC';
}

function wallClock(ms: number, tz: string): WallClock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zoneOrUtc(tz),
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(ms);
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour') % 24, minute: get('minute'), second: get('second') };
}

/** Offset of `tz` at that instant, in ms (zone time minus UTC). */
function offsetAt(ms: number, tz: string): number {
  const local = wallClock(ms, tz);
  const asUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** A wall-clock time in `tz` becomes an instant; one correction pass settles DST boundaries. */
function wallToUtc(year: number, month: number, day: number, hour: number, tz: string): number {
  const guess = Date.UTC(year, month - 1, day, hour, 0, 0);
  const first = guess - offsetAt(guess, tz);
  return guess - offsetAt(first, tz);
}
