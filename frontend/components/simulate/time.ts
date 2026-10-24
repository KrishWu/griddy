// PST calendar helpers for hourly arrays.  OWNER: workstream B (Simulate + Stress Test).
// Contract: index i = the hour beginning at hourly.start + i steps, fixed UTC-8 (PST) all
// year, no DST. Never reads the browser timezone: each timestamp is shifted to PST wall
// time and read back with getUTC* getters only.

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const PST_OFFSET_MS = -8 * HOUR_MS;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export interface Clock {
  /** PST wall-clock time of index 0, as UTC epoch ms (read with getUTC*). */
  startWallMs: number;
  stepMs: number;
  /** Points per calendar day (24 for hourly data). */
  perDay: number;
}

/** Parses hourly.start ("2024-01-01T00:00:00-08:00"). A string with no zone is PST wall time. */
export function makeClock(start: string, stepMinutes: number): Clock {
  const stepMs = (stepMinutes > 0 ? stepMinutes : 60) * 60_000;
  const hasZone = /([zZ]|[+-]\d\d:?\d\d)$/.test(start);
  const parsed = hasZone ? Date.parse(start) : Date.parse(start.length <= 10 ? `${start}T00:00:00Z` : `${start}Z`);
  // Fallback: 2024-01-01 00:00 PST, the contract's weather year.
  const startWallMs = Number.isFinite(parsed) ? (hasZone ? parsed + PST_OFFSET_MS : parsed) : Date.UTC(2024, 0, 1);
  return { startWallMs, stepMs, perDay: Math.max(1, Math.round(DAY_MS / stepMs)) };
}

/** PST wall time of index i. Only call getUTC* on the result. */
export function wallAt(c: Clock, i: number): Date {
  return new Date(c.startWallMs + i * c.stepMs);
}

const pad = (n: number) => String(n).padStart(2, "0");

export const fmtDate = (d: Date) => `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
export const fmtMonthDay = (d: Date) => `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
export const fmtWeekday = (d: Date) => `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()}`;
export const fmtClock = (d: Date) => `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
export const fmtHour = (d: Date) => pad(d.getUTCHours());

/** "Mon, Jul 15, 2024 (PST)" for one day; "Jul 12 – 18, 2024 (PST)" for a span of days. */
export function rangeLabel(c: Clock, startIdx: number, length: number): string {
  const a = wallAt(c, startIdx);
  const b = wallAt(c, startIdx + Math.max(0, length - 1));
  const sameDay = a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth() && a.getUTCDate() === b.getUTCDate();
  if (sameDay) return `${WEEKDAYS[a.getUTCDay()]}, ${fmtDate(a)} (PST)`;
  if (a.getUTCFullYear() !== b.getUTCFullYear()) return `${fmtDate(a)} – ${fmtDate(b)} (PST)`;
  const end = a.getUTCMonth() === b.getUTCMonth() ? `${b.getUTCDate()}` : fmtMonthDay(b);
  return `${fmtMonthDay(a)} – ${end}, ${b.getUTCFullYear()} (PST)`;
}

/** Hover label for one point: "Mon Jul 15 · 14:00–15:00 PST". */
export function pointLabel(c: Clock, i: number): string {
  const a = wallAt(c, i);
  const b = wallAt(c, i + 1);
  return `${WEEKDAYS[a.getUTCDay()]} ${fmtMonthDay(a)} · ${fmtClock(a)}–${fmtClock(b)} PST`;
}

/** 0-based day index of month/day (month 0-11) in the year of index 0, clamped to [0, days-1]. */
export function dayOf(c: Clock, month: number, dom: number, days: number): number {
  const year = wallAt(c, 0).getUTCFullYear();
  const d = Math.floor((Date.UTC(year, month, dom) - c.startWallMs) / DAY_MS);
  return Math.min(Math.max(0, d), Math.max(0, days - 1));
}
