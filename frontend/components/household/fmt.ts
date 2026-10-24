// Household-scale number formatting (kWh, kg, cents) that @/lib/format's MW-scale helpers don't cover.
// OWNER: household (frontend).
import { usd } from "@/lib/format";

/** Finite number or 0: the API promises finite numbers, but a render should never print NaN. */
export const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export const kwh = (v: number) => {
  const a = Math.abs(num(v));
  return `${a >= 100 ? Math.round(num(v)).toLocaleString() : num(v).toFixed(a >= 10 ? 0 : 1)} kWh`;
};
export const kg = (v: number) => {
  const a = Math.abs(num(v));
  if (a >= 10000) return `${(num(v) / 1000).toFixed(1)} t`;
  if (a > 0 && a < 10) return `${num(v).toFixed(a < 1 ? 3 : 2)} kg`;
  return `${Math.round(num(v)).toLocaleString()} kg`;
};
export const cents = (usdPerKwh: number) => `${(num(usdPerKwh) * 100).toFixed(1)}¢`;
export const usd0 = (v: number) => usd(num(v));
/** "+$310" / "−$40" (a real minus sign). */
export const signedUsd = (v: number) => (num(v) < 0 ? `−${usd(-num(v))}` : `+${usd(num(v))}`);
export const signedKg = (v: number) => (num(v) < 0 ? `−${kg(-num(v))}` : `+${kg(num(v))}`);
export const pct0 = (share: number) => `${Math.round(num(share) * 100)}%`;

/** 0 -> "12 am", 13 -> "1 pm". */
export const hourLabel = (h: number) => {
  const x = ((Math.round(num(h)) % 24) + 24) % 24;
  return `${x % 12 === 0 ? 12 : x % 12} ${x < 12 ? "am" : "pm"}`;
};
/** Compact axis tick: "12a", "6p". */
export const hourTick = (h: number) => {
  const x = ((Math.round(num(h)) % 24) + 24) % 24;
  return `${x % 12 === 0 ? 12 : x % 12}${x < 12 ? "a" : "p"}`;
};
export const compactUsd = (v: number) => {
  const a = Math.abs(v);
  const s = v < 0 ? "−" : "";
  return a >= 1000 ? `${s}$${(a / 1000).toFixed(a >= 10000 ? 0 : 1).replace(/\.0$/, "")}K` : `${s}$${Math.round(a)}`;
};

/** Round axis ticks covering [lo, hi] (always including 0 when the range spans it): steps of 1, 2, 2.5 or 5 × 10^k. */
export function niceTicks(lo: number, hi: number, target = 4): number[] {
  let a = Math.min(num(lo), num(hi));
  let b = Math.max(num(lo), num(hi));
  if (b - a < 1e-9) {
    b = a + 1;
    if (a > 0) a = 0;
  }
  const raw = (b - a) / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 2.5, 5, 10].find((m) => m * mag >= raw) ?? 10) * mag;
  const start = Math.floor(a / step) * step;
  const end = Math.ceil(b / step) * step;
  const out: number[] = [];
  for (let v = start; v <= end + step / 2; v += step) out.push(Number(v.toFixed(10)));
  return out;
}
