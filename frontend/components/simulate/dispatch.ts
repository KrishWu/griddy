// Dispatch chart data shaping: series definitions, per-hour derived values, worst-day
// search, axis ticks.  OWNER: workstream B (Simulate + Stress Test).
// Pure functions over HourlySeries; the components memoize them. Renewable generation_mw
// INCLUDES curtailed output, so the chart splits curtailed_mw between solar and wind in
// proportion to their output that hour and stacks only the used part, with the
// curtailed remainder drawn as a pale wash on top. Flows are hour-beginning averages
// drawn at the hour's start tick; SOC is shifted to the state at that same instant.
import type { HourlySeries } from "@/lib/contract";
import { mwh } from "@/lib/format";

import type { SimExtras, WorstDay } from "./extras";

export type SeriesKey = "nuclear" | "solar" | "wind" | "discharge" | "gas_cc" | "gas_ct" | "imports" | "unmet" | "curtailed" | "charge" | "exports";

export interface SeriesDef {
  key: SeriesKey;
  /** Table column header. */
  short: string;
  /** Legend label (shared by the two halves of battery and grid). */
  legend: string;
  /** Tooltip / table label. */
  label: string;
  color: string;
  /** "pos" stacks above zero, "neg" below zero (values stored negative). */
  stack: "pos" | "neg";
}

// Colors are CSS variables set on the chart wrapper (light + dark steps, validated as a
// set for adjacent-pair CVD separation in this stack order).
export const SERIES: SeriesDef[] = [
  // Nuclear (large + SMR) is must-run baseload, so it sits at the bottom of the stack.
  { key: "nuclear", short: "Nuclear", legend: "Nuclear", label: "Nuclear (large + SMR)", color: "var(--gf-nuclear)", stack: "pos" },
  { key: "solar", short: "Solar", legend: "Solar", label: "Solar (used)", color: "var(--gf-solar)", stack: "pos" },
  { key: "wind", short: "Wind", legend: "Wind", label: "Wind (used)", color: "var(--gf-wind)", stack: "pos" },
  { key: "discharge", short: "Batt out", legend: "Battery", label: "Battery discharge", color: "var(--gf-battery)", stack: "pos" },
  { key: "gas_cc", short: "Gas CC", legend: "Gas CC", label: "Gas CC", color: "var(--gf-gascc)", stack: "pos" },
  { key: "gas_ct", short: "Gas CT", legend: "Gas CT", label: "Gas CT", color: "var(--gf-gasct)", stack: "pos" },
  { key: "imports", short: "Import", legend: "Grid", label: "Grid imports", color: "var(--gf-grid)", stack: "pos" },
  { key: "unmet", short: "Unmet", legend: "Unmet", label: "Unmet demand", color: "var(--gf-unmet)", stack: "pos" },
  { key: "curtailed", short: "Curtail", legend: "Curtailed", label: "Curtailed", color: "var(--gf-muted)", stack: "pos" },
  { key: "charge", short: "Batt in", legend: "Battery", label: "Battery charge", color: "var(--gf-battery)", stack: "neg" },
  { key: "exports", short: "Export", legend: "Grid", label: "Grid exports", color: "var(--gf-grid)", stack: "neg" },
];

export interface Point extends Record<SeriesKey, number> {
  demand: number;
  /** Battery state of charge at the START of the hour (MWh). */
  soc: number;
}

/** One chart row: x = offset within the visible window, t = absolute index. */
export interface Row extends Point {
  x: number;
  t: number;
}

export type Presence = Record<SeriesKey | "soc", boolean>;

/** Below this a series counts as absent (engine output is rounded to 0.01 MW). */
const EPS_MW = 0.05;

/** a[t] if it is a finite number, else 0. */
export const valueAt = (a: number[] | undefined, t: number): number => {
  const v = a?.[t];
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
};
const pos = (a: number[] | undefined, t: number) => Math.max(0, valueAt(a, t));

/** SOC at the START of hour t. The engine reports the state at the END of each hour, so
 *  this is soc[t-1]; for t = 0 it is the year-end SOC, which the default cyclic dispatch
 *  starts the year from (dispatch.py rule 5). */
function socAtStart(h: HourlySeries, t: number): number {
  const n = h.battery_soc_mwh?.length ?? 0;
  return n > 0 ? pos(h.battery_soc_mwh, t > 0 ? t - 1 : n - 1) : 0;
}

export function pointAt(h: HourlySeries, t: number): Point {
  const solarGen = pos(h.generation_mw.solar_pv, t);
  const windGen = pos(h.generation_mw.onshore_wind, t);
  const curtailed = pos(h.curtailed_mw, t);
  const renewable = solarGen + windGen;
  const solarCurt = renewable > 0 ? (curtailed * solarGen) / renewable : 0;
  return {
    demand: pos(h.demand_mw, t),
    nuclear: pos(h.generation_mw.nuclear, t) + pos(h.generation_mw.nuclear_smr, t),
    solar: Math.max(0, solarGen - solarCurt),
    wind: Math.max(0, windGen - (curtailed - solarCurt)),
    discharge: pos(h.battery_discharge_mw, t),
    gas_cc: pos(h.generation_mw.gas_cc, t),
    gas_ct: pos(h.generation_mw.gas_ct, t),
    imports: pos(h.imports_mw, t),
    unmet: pos(h.unmet_mw, t),
    curtailed,
    charge: -pos(h.battery_charge_mw, t),
    exports: -pos(h.exports_mw, t),
    soc: socAtStart(h, t),
  };
}

export interface YearScan {
  /** Which series are non-zero anywhere in the year (keeps the legend stable across days). */
  present: Presence;
  /** Year-wide MW range: one fixed Y scale, so days stay comparable while scrubbing. */
  loMw: number;
  hiMw: number;
  socMaxMwh: number;
}

export function scanYear(h: HourlySeries): YearScan {
  const present: Presence = {
    nuclear: false, solar: false, wind: false, discharge: false, gas_cc: false, gas_ct: false, imports: false,
    unmet: false, curtailed: false, charge: false, exports: false, soc: false,
  };
  const keys = Object.keys(present) as (keyof Presence)[];
  let loMw = 0;
  let hiMw = 0;
  let socMaxMwh = 0;
  for (let t = 0; t < h.demand_mw.length; t++) {
    const p = pointAt(h, t);
    for (const k of keys) if (!present[k] && Math.abs(p[k]) > EPS_MW) present[k] = true;
    const up = p.nuclear + p.solar + p.wind + p.discharge + p.gas_cc + p.gas_ct + p.imports + p.unmet + p.curtailed;
    hiMw = Math.max(hiMw, up, p.demand);
    loMw = Math.min(loMw, p.charge + p.exports);
    socMaxMwh = Math.max(socMaxMwh, p.soc);
  }
  return { present, loMw, hiMw, socMaxMwh };
}

/** The visible window only (24 or 168 points), never the whole year. */
export function windowRows(h: HourlySeries, start: number, length: number): Row[] {
  return Array.from({ length }, (_, x) => ({ x, t: start + x, ...pointAt(h, start + x) }));
}

/** Grid-drawn part of hour t's battery charge (MW, never above the charge itself); 0 when
 *  the engine sent no hourly split. The browser never re-derives the engine's attribution. */
export function gridChargeAt(ex: Pick<SimExtras, "batteryGridChargeMw">, t: number, chargeMw: number): number {
  return Math.min(Math.abs(chargeMw), Math.max(0, valueAt(ex.batteryGridChargeMw, t)));
}

/** Share (0-1) of the year's battery charging energy drawn from grid imports, or null when
 *  the engine reported no split or the battery never charged. The hourly array wins (same
 *  units as battery_charge_mw); the annual MWh is the fallback. */
export function gridChargeShare(h: HourlySeries, ex: Pick<SimExtras, "batteryGridChargeMw" | "batteryGridChargeMwh">, stepH: number): number | null {
  let charge = 0;
  for (let t = 0; t < h.demand_mw.length; t++) charge += pos(h.battery_charge_mw, t);
  let grid: number | undefined;
  if (ex.batteryGridChargeMw) grid = ex.batteryGridChargeMw.reduce((a, v) => a + Math.max(0, v), 0);
  else if (ex.batteryGridChargeMwh !== undefined && stepH > 0) grid = Math.max(0, ex.batteryGridChargeMwh) / stepH;
  if (grid === undefined || charge <= EPS_MW) return null;
  return Math.min(1, grid / charge);
}

/** Most unmet MWh, else most gas + import MWh, else least solar + wind MWh. */
export function fallbackWorstDay(h: HourlySeries, perDay: number, days: number, stepH: number): WorstDay {
  const unmet = new Array<number>(days).fill(0);
  const firm = new Array<number>(days).fill(0);
  const renew = new Array<number>(days).fill(0);
  for (let t = 0; t < days * perDay; t++) {
    const d = Math.floor(t / perDay);
    unmet[d] += pos(h.unmet_mw, t) * stepH;
    firm[d] += (pos(h.generation_mw.gas_cc, t) + pos(h.generation_mw.gas_ct, t) + pos(h.imports_mw, t)) * stepH;
    renew[d] += (pos(h.generation_mw.solar_pv, t) + pos(h.generation_mw.onshore_wind, t)) * stepH;
  }
  const argmax = (a: number[]) => a.reduce((best, v, i) => (v > a[best] ? i : best), 0);
  const argmin = (a: number[]) => a.reduce((best, v, i) => (v < a[best] ? i : best), 0);
  let d = argmax(unmet);
  if (unmet[d] > EPS_MW) return { index: d, reason: `Most unmet energy: ${mwh(unmet[d])}` };
  d = argmax(firm);
  if (firm[d] > EPS_MW) return { index: d, reason: `Most gas + grid imports: ${mwh(firm[d])}` };
  d = argmin(renew);
  return { index: d, reason: `Lowest solar + wind output: ${mwh(renew[d])}` };
}

/** Round axis ticks spanning [lo, hi] with about `target` intervals. */
export function niceTicks(lo: number, hi: number, target = 4): number[] {
  const top = hi > lo ? hi : lo + 1;
  const raw = (top - lo) / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const k0 = Math.floor(lo / step + 1e-9);
  const k1 = Math.ceil(top / step - 1e-9);
  return Array.from({ length: k1 - k0 + 1 }, (_, i) => (k0 + i) * step);
}

/** Compact axis number: 950, 1.2k, 12k, 1.5M. */
export function compact(v: number): string {
  const a = Math.abs(v);
  const trim = (x: number) => x.toFixed(Math.abs(x) >= 10 ? 0 : 1).replace(/\.0$/, "");
  if (a >= 1e6) return `${trim(v / 1e6)}M`;
  if (a >= 1e3) return `${trim(v / 1e3)}k`;
  return `${Math.round(v)}`;
}

/** Whole number with thousands separators, locale-independent. */
export const int = (v: number) => (Math.round(v) || 0).toLocaleString("en-US"); // || 0 drops "-0"

/** Price with the sign ahead of the dollar sign: "$42/MWh", "−$12/MWh" (CAISO goes negative). */
export function usdPerMwh(v: number): string {
  const r = Math.round(v) || 0;
  return `${r < 0 ? "−" : ""}$${int(Math.abs(r))}/MWh`;
}
