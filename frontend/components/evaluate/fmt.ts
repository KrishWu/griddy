// Formatting helpers for the Evaluate panel that @/lib/format doesn't cover (signed
// dollars, small tonnages, rates). OWNER: workstream C (Evaluate).
import { usd } from "@/lib/format";

export const DASH = "—";

/** Finite number or undefined: contract numbers should be finite, but never trust a render to it. */
export const finite = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** usd() with a real minus sign for credits (usd(-5e6) would print "$-5.0M"). */
export const signedUsd = (v: number) => (v < 0 ? `−${usd(-v)}` : usd(v));

/** Axis ticks: $0, $500M, $2B, $2.5B. */
export const compactUsd = (v: number) => {
  const a = Math.abs(v);
  const sign = v < 0 ? "−" : "";
  if (a >= 1e9) return `${sign}$${trim(a / 1e9)}B`;
  if (a >= 1e6) return `${sign}$${trim(a / 1e6)}M`;
  if (a >= 1e3) return `${sign}$${trim(a / 1e3)}K`;
  return `${sign}$${Math.round(a)}`;
};

const trim = (v: number) => (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(0) : v.toFixed(1).replace(/\.0$/, ""));

/** Metric tons with useful precision for small values (tons() rounds 0.4 t to "0 t"). */
export const tonsFine = (v: number) => {
  const a = Math.abs(v);
  if (a >= 1e6) return `${(v / 1e6).toFixed(2)} Mt`;
  if (a >= 1e4) return `${Math.round(v / 1e3).toLocaleString()}k t`;
  if (a >= 100) return `${Math.round(v).toLocaleString()} t`;
  if (a >= 10) return `${v.toFixed(1)} t`;
  if (a === 0) return "0 t";
  return `${v.toFixed(2)} t`;
};

export const perMwh = (v: number) => `$${v.toFixed(0)}/MWh`;
export const kgPerMwh = (v: number) => `${Math.round(v).toLocaleString()} kg/MWh`;
export const acres = (v: number) => `${Math.round(v).toLocaleString()} ac`;

/** BOM quantities: integers as-is, large values rounded, small fractions to 2 dp. */
export const qty = (v: number) =>
  Number.isInteger(v) || Math.abs(v) >= 100 ? Math.round(v).toLocaleString() : v.toLocaleString(undefined, { maximumFractionDigits: 2 });

export const pct1 = (v: number) => `${(v * 100).toFixed(1)}%`;
