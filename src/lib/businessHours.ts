export type BusinessHoursCfg = {
  enabled?: boolean;
  timezone?: string;
  days?: number[]; // 0=Sun ... 6=Sat
  start?: string; // HH:mm
  end?: string; // HH:mm
};

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function parseTimeToMinutes(hhmm: string, fallback: number) {
  const s = String(hhmm || '').trim();
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(s);
  if (!m) return fallback;
  return Number(m[1]) * 60 + Number(m[2]);
}

function normalizeTimeZone(tz: string) {
  const s = String(tz || '').trim() || 'UTC';
  try {
    // Throws RangeError for invalid timeZone
    new Intl.DateTimeFormat('en-US', { timeZone: s }).format(0);
    return s;
  } catch {
    return 'UTC';
  }
}

function getZonedParts(ms: number, timeZone: string) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = dtf.formatToParts(new Date(ms));
  const out: any = {};
  for (const p of parts) {
    if (p.type !== 'literal') out[p.type] = p.value;
  }
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour: Number(out.hour),
    minute: Number(out.minute),
    second: Number(out.second),
  };
}

function getTimeZoneOffsetMs(ms: number, timeZone: string) {
  const p = getZonedParts(ms, timeZone);
  const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUTC - ms;
}

function zonedLocalToUtcMs(
  y: number,
  m: number,
  d: number,
  hh: number,
  mm: number,
  timeZone: string
) {
  // Iterative correction for DST/offset changes.
  let guess = Date.UTC(y, m - 1, d, hh, mm, 0);
  for (let i = 0; i < 3; i++) {
    const off = getTimeZoneOffsetMs(guess, timeZone);
    const next = Date.UTC(y, m - 1, d, hh, mm, 0) - off;
    if (Math.abs(next - guess) < 1000) {
      guess = next;
      break;
    }
    guess = next;
  }
  return guess;
}

function addDaysYMD(y: number, m: number, d: number, days: number) {
  const t = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  t.setUTCDate(t.getUTCDate() + days);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

function weekdayInZone(ms: number, timeZone: string): number {
  const w = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(new Date(ms));
  switch (w) {
    case 'Sun': return 0;
    case 'Mon': return 1;
    case 'Tue': return 2;
    case 'Wed': return 3;
    case 'Thu': return 4;
    case 'Fri': return 5;
    case 'Sat': return 6;
    default: return 0;
  }
}

export function businessMinutesBetween(startMs: number, endMs: number, cfg?: BusinessHoursCfg): number {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return 0;
  const tz = normalizeTimeZone(String(cfg?.timezone || 'Asia/Baku'));
  const enabled = cfg?.enabled === true;
  if (!enabled) return (endMs - startMs) / 60000;

  const days = Array.isArray(cfg?.days) ? cfg!.days!.map((x) => Number(x)).filter((x) => Number.isFinite(x)) : [1, 2, 3, 4, 5];
  const daySet = new Set(days);
  const startMin = parseTimeToMinutes(String(cfg?.start || '09:00'), 9 * 60);
  const endMin = parseTimeToMinutes(String(cfg?.end || '18:00'), 18 * 60);
  if (startMin === endMin) return 0;

  let total = 0;
  let cursor = startMs;
  // Safety: never loop more than 370 days
  for (let i = 0; i < 370; i++) {
    if (cursor >= endMs) break;

    const p = getZonedParts(cursor, tz);
    const y = p.year;
    const m = p.month;
    const d = p.day;

    const dow = weekdayInZone(cursor, tz);
    const nextYMD = addDaysYMD(y, m, d, 1);
    const dayStartUtc = zonedLocalToUtcMs(y, m, d, 0, 0, tz);
    const nextDayStartUtc = zonedLocalToUtcMs(nextYMD.y, nextYMD.m, nextYMD.d, 0, 0, tz);

    // If day is not active, skip to next day.
    if (!daySet.has(dow)) {
      cursor = nextDayStartUtc;
      continue;
    }

    const winStartUtc = zonedLocalToUtcMs(y, m, d, Math.floor(startMin / 60), startMin % 60, tz);
    let winEndUtc = zonedLocalToUtcMs(y, m, d, Math.floor(endMin / 60), endMin % 60, tz);
    if (endMin < startMin) {
      // Overnight shift
      winEndUtc = zonedLocalToUtcMs(nextYMD.y, nextYMD.m, nextYMD.d, Math.floor(endMin / 60), endMin % 60, tz);
    }

    const a0 = clamp(Math.max(startMs, winStartUtc), startMs, endMs);
    const a1 = clamp(Math.min(endMs, winEndUtc), startMs, endMs);
    if (a1 > a0) total += (a1 - a0) / 60000;

    // Move to next local day
    // Ensure progress even if TZ math goes weird
    cursor = Math.max(nextDayStartUtc, dayStartUtc + 24 * 60 * 60 * 1000);
  }

  return total;
}
