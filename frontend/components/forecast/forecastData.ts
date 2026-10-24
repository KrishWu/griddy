// Small readers + formatters for the Phase 2 demand forecast, shared by the forecast view,
// the map's demand layer and the Site panel.  OWNER: workstream A.
import type { CountyForecast, DemandForecast, RegionForecast } from "@/lib/contract";
import { mw, mwh } from "@/lib/format";

/** Kern County, the Griddy demo site: the data-center slider's county when no site county is known. */
export const DEFAULT_DC_GEOID = "06029";

export const SCENARIO_LABEL: Record<string, string> = { low: "Low", mid: "Mid", high: "High" };
export const scenarioLabel = (s: string | undefined) => (s ? (SCENARIO_LABEL[s] ?? s) : "Mid");

/** Short names for the EIA-930 load regions (full names come from the API). */
export const REGION_SHORT: Record<string, string> = {
  PGAE: "PG&E",
  SCE: "SCE",
  SDGE: "SDG&E",
  LDWP: "LADWP",
  BANC: "BANC",
  IID: "IID",
  TIDC: "TID",
};
export const regionShort = (r: string) => REGION_SHORT[r] ?? r;

/** "+1,021 MW" / "−172 MW" / "0 MW". */
export function signedMw(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "– MW";
  if (Math.round(v) === 0) return "0 MW";
  return v > 0 ? `+${mw(v)}` : `−${mw(-v)}`;
}

/** "+42.89 TWh" / "−1.2 GWh". */
export function signedMwh(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "– MWh";
  if (Math.round(v) === 0) return "0 MWh";
  return v > 0 ? `+${mwh(v)}` : `−${mwh(-v)}`;
}

/** "+19%" / "−2%" (from a fraction). */
export function signedPct(v: number | null | undefined, digits = 0): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "–";
  const s = (Math.abs(v) * 100).toFixed(digits);
  if (Number(s) === 0) return "0%";
  return `${v > 0 ? "+" : "−"}${s}%`;
}

/** "1.5%/yr" from a fraction per year. */
export const perYear = (v: number) => `${(v * 100).toFixed(1)}%/yr`;

/** "Kern County" -> "kern", for matching county names across datasets. */
export function countyKey(name: string | null | undefined): string {
  return (name ?? "").trim().replace(/\s+county$/i, "").toLowerCase();
}

export function countyByName(f: DemandForecast | null, name: string | null | undefined): CountyForecast | null {
  const key = countyKey(name);
  if (!key) return null;
  return f?.counties?.find((c) => countyKey(c.county) === key) ?? null;
}

export function countyByGeoid(f: DemandForecast | null, geoid: string | null | undefined): CountyForecast | null {
  if (!geoid) return null;
  return f?.counties?.find((c) => c.geoid === geoid) ?? null;
}

export const countyName = (f: DemandForecast | null, geoid: string) => countyByGeoid(f, geoid)?.county ?? geoid;

/** New firm data-center peak in a county: nameplate x load factor x (1 - flexible share), as the backend
 *  adds it to the peak; clamped to the county's growth so a stacked bar never overshoots. */
export function dataCenterPeakMw(c: CountyForecast, f: DemandForecast | null): number {
  const added = c.added_load_mw ?? 0;
  if (added <= 0) return 0;
  const lf = typeof f?.params?.data_center_load_factor === "number" ? f.params.data_center_load_factor : 0.9;
  const flex = typeof f?.params?.data_center_flexible_share === "number" ? f.params.data_center_flexible_share : 0;
  return Math.max(0, Math.min(Math.max(c.growth_peak_mw_p90, 0), added * lf * (1 - flex)));
}

export interface Totals {
  basePeak: number;
  growthPeak: number;
  baseEnergy: number;
  energy: number;
}

export function totals(f: DemandForecast | null): Totals | null {
  const regions: RegionForecast[] = f?.regions ?? [];
  if (!regions.length) return null;
  const sum = (k: (r: RegionForecast) => number) => regions.reduce((a, r) => a + (Number.isFinite(k(r)) ? k(r) : 0), 0);
  return {
    basePeak: sum((r) => r.base_peak_mw),
    growthPeak: typeof f?.total_growth_peak_mw_p90 === "number" ? f.total_growth_peak_mw_p90 : sum((r) => r.growth_peak_mw_p90),
    baseEnergy: sum((r) => r.base_energy_mwh),
    energy: sum((r) => r.energy_mwh),
  };
}

/** One trajectory point, read defensively (the contract types it as Record<string, number>). */
export interface TrajectoryPoint {
  year: number;
  p50: number;
  p90: number;
}

export function trajectory(r: RegionForecast): TrajectoryPoint[] {
  return (r.trajectory ?? [])
    .map((t) => ({ year: Math.round(Number(t.year)), p50: Number(t.peak_mw_p50), p90: Number(t.peak_mw_p90) }))
    .filter((t) => Number.isFinite(t.year) && Number.isFinite(t.p50))
    .map((t) => ({ ...t, p90: Number.isFinite(t.p90) ? Math.max(t.p90, t.p50) : t.p50 }));
}
