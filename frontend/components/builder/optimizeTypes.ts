// Types and helpers for POST /api/projects/optimize (backend/app/builder/optimizer.py).
// The route returns a plain dict, not a contract type, so lib/contract.ts stays untouched:
// every key past the plan's core shape is optional and read defensively.  OWNER: workstream D.
import type { Asset, AssetKind, LngLat, Provenance, Scenario, Severity } from "@/lib/contract";

export type Mix = Partial<Record<AssetKind, number>>;
/** The request's clean_metric values (OptimizeRequest.clean_metric). */
export type CleanMetric = "onsite_share" | "cfe_24_7";
export type PlacementMode = "site_model" | "campus_only";

export interface OptimizeRequest {
  scenario: Scenario;
  project: Record<string, unknown>;
  min_clean_share: number;
  max_unmet_hours: number;
  require_reserve_margin: boolean;
  require_n_minus_1: boolean;
  include_wind: boolean;
  /** Sent only when not the default ("site_model"). */
  placement?: PlacementMode;
  /** Sent only when not the default ("onsite_share"). */
  clean_metric?: CleanMetric;
}

/** Metrics shared by the recommended design, alternatives, frontier points and the baseline. */
export interface Metrics {
  npc_usd?: number | null;
  lcoe_usd_per_mwh?: number | null;
  capex_total_usd?: number | null;
  annual_t_co2e?: number | null;
  onsite_clean_share?: number | null;
  cfe_score_24_7?: number | null;
  hours_unmet?: number | null;
}

/** Exact (simulate + evaluate + stress) numbers for a judged design. */
export interface ExactMetrics extends Metrics {
  assets_mw?: Mix;
  findings_count?: Partial<Record<Severity, number>>;
  passes_checks?: boolean | null;
  failed_checks?: string[] | null;
}

/** Where one solar or wind block goes: a site-model candidate, or the campus (site_id "campus" / no candidate id). */
export interface Placement {
  asset_id?: string;
  kind: string;
  site_id?: string | null;
  candidate_id?: string | null;
  candidate?: Record<string, unknown> | null;
  location?: LngLat | null;
  mw: number;
  gen_tie_usd?: number | null;
  suitability?: number | null;
  county?: string | null;
  region?: string | null;
  label?: string | null;
}

/** The recommended mix judged again with every MW at the campus (response.campus_only). */
export interface CampusOnly extends ExactMetrics {
  /** True when the campus version is the recommendation (no remote cell was cheaper for this mix). */
  same_as_recommended?: boolean | null;
  basis?: string | null;
}

/** One place a kind's MW can go (response.placement.options[kind][i]); "campus" is the site itself. */
export interface PlacementOption {
  id: string;
  label?: string | null;
  annual_cf?: number | null;
  cost_usd_per_mwh?: number | null;
  max_mw?: number | null;
}

export interface PlacementInfo {
  requested?: string | null;
  used?: string | null;
  notes?: string[] | null;
  options?: Record<string, PlacementOption[]> | null;
}

export interface Design extends ExactMetrics {
  label?: string | null;
  scenario?: Scenario | null;
  battery_mwh?: number | null;
  findings?: { id: string; severity: Severity; title: string }[] | null;
  placement?: Placement[] | null;
  campus_only?: CampusOnly | null;
}

export interface FrontierPoint extends Metrics {
  label?: string | null;
  assets_mw?: Mix;
  battery_mwh?: number | null;
  /** true on frontier points; on candidates, the exact metrics object once judged (null before). */
  exact?: boolean | ExactMetrics | null;
  recommended?: boolean | null;
  scenario?: Scenario | null;
}

export interface Candidate extends FrontierPoint {
  est_cost_usd_per_yr?: number | null;
  est_lcoe_usd_per_mwh?: number | null;
  est_t_co2e?: number | null;
  status?: string | null;
  reason?: string | null;
}

export interface Baseline extends ExactMetrics {
  label?: string | null;
  available?: boolean | null;
  battery_mwh?: number | null;
  scenario?: Scenario | null;
  /** The plan's older name for passes_checks. */
  meets_targets?: boolean | null;
}

export interface OptimizeResult {
  available: boolean;
  basis?: string | null;
  tested?: number | null;
  /** A count in the plan; a list of exact points is accepted too. */
  finalists?: number | FrontierPoint[] | null;
  recommended?: Design | null;
  alternatives?: Design[] | null;
  frontier?: FrontierPoint[] | null;
  candidates?: Candidate[] | null;
  rejected_by_reason?: Record<string, number> | null;
  /** Main rejection reason when no design meets the targets. */
  main_reason?: string | null;
  reason?: string | null;
  /** Reason id -> plain words. */
  reasons?: Record<string, string> | null;
  message?: string | null;
  notes?: string[] | null;
  precomputed?: boolean | null;
  passing?: number | null;
  baseline?: Baseline | null;
  runtime_ms?: number | null;
  provenance?: Provenance[] | null;
  /** The placement actually used ({requested, used, notes, options}), a mode string, or the recommended design's rows. */
  placement?: string | Placement[] | PlacementInfo | null;
  campus_only?: CampusOnly | null;
  clean_metric?: string | null;
  search?: { widened?: boolean | null; sizing_peak_mw?: number | null } | null;
  /** Each preset's own mix at the projected demand, judged the same way: chart markers. */
  presets?: (ExactMetrics & { id?: string | null; label?: string | null; name?: string | null })[] | null;
  projection?: {
    years?: number | null;
    peak_mw?: number | null;
    current_peak_mw?: number | null;
    factor?: number | null;
    demand_mwh?: number | null;
  } | null;
}

/** Finite number or undefined: never trust a render to the backend's numbers. */
export const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

export const KIND_LABEL: Record<AssetKind, string> = {
  solar_pv: "Solar PV",
  onshore_wind: "Onshore wind",
  battery: "Battery",
  gas_cc: "Gas combined cycle",
  gas_ct: "Gas peaker",
};
const KIND_SHORT: Record<AssetKind, string> = { solar_pv: "Solar", onshore_wind: "Wind", battery: "Battery", gas_cc: "Gas CC", gas_ct: "Gas CT" };
export const KIND_ORDER: AssetKind[] = ["solar_pv", "onshore_wind", "battery", "gas_cc", "gas_ct"];

const int = (v: number) => Math.round(v).toLocaleString("en-US");

/** Battery duration in hours from MW and MWh, or null. */
export function batteryHours(mix: Mix | undefined, mwh: number | null | undefined): number | null {
  const mw = num(mix?.battery) ?? 0;
  const e = num(mwh);
  return mw > 0 && e !== undefined ? e / mw : null;
}

/** "Solar 2,760 · Battery 828 × 8 h · Gas CC 694 MW" (tooltips, tables). */
export function mixText(mix: Mix | undefined, mwh?: number | null): string {
  const parts = KIND_ORDER.flatMap((k) => {
    const mw = num(mix?.[k]) ?? 0;
    if (mw < 0.05) return [];
    const h = k === "battery" ? batteryHours(mix, mwh) : null;
    return [`${KIND_SHORT[k]} ${int(mw)}${h ? ` × ${trimH(h)} h` : ""}`];
  });
  return parts.length ? `${parts.join(" · ")} MW` : "No on-site plant (grid only)";
}

export const trimH = (h: number) => (Number.isInteger(Math.round(h * 10) / 10) ? String(Math.round(h)) : h.toFixed(1));

/** Plain words for the optimizer's rejection reasons: the response's own `reasons` map first,
 *  then known ids, then the id made readable. */
export function reasonText(reason: string | null | undefined, reasons?: Record<string, string> | null): string {
  if (!reason) return "";
  if (reasons?.[reason]) return reasons[reason];
  const r = reason.toLowerCase();
  if (/cfe/.test(r)) return "24/7 carbon-free score below the target";
  if (/clean/.test(r)) return "On-site clean share below the target";
  if (/budget/.test(r)) return "Capital cost above the budget";
  if (/land|footprint|area/.test(r)) return "Needs more land than the selected footprint";
  if (/co2|carbon|emission/.test(r)) return "Emissions above the CO₂ cap";
  if (/unmet|unserved/.test(r)) return "Leaves demand unserved for more hours than allowed";
  if (/n_minus_1|n-1|largest/.test(r)) return "Doesn't survive losing the largest gas unit";
  if (/firm|reserve|margin/.test(r)) return "Firm capacity margin below 15%";
  if (/stress|fail/.test(r)) return "A stress-test check fails";
  if (/dominat/.test(r)) return "Another design is both cheaper and cleaner";
  if (/cost|finalist|rank/.test(r)) return "Cheaper designs were judged first";
  const words = reason.replace(/_/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The reason most designs were turned down, for the "no design fits" message. */
export function mainReason(res: OptimizeResult): string | null {
  if (res.main_reason) return res.main_reason;
  if (res.reason) return res.reason;
  const counts = Object.entries(res.rejected_by_reason ?? {}).filter(([, n]) => (num(n) ?? 0) > 0);
  if (!counts.length) return null;
  return counts.sort((a, b) => b[1] - a[1])[0][0];
}

/** The recommended design's placement list, wherever the backend put it. */
export function placementOf(res: OptimizeResult, d: Design | null | undefined): Placement[] {
  const list = d?.placement ?? (Array.isArray(res.placement) ? res.placement : null);
  return (list ?? []).filter((p) => p && typeof p.mw === "number" && p.mw > 0.05);
}

/** True for a block placed away from the campus (at a site-model candidate). */
export const isRemote = (p: Placement) => !!(p.candidate_id || (p.site_id && p.site_id !== "campus"));

/** A candidate's exact numbers once judged: the backend's nested object, or the row itself (plan shape). */
export function exactOf(c: FrontierPoint): ExactMetrics | null {
  if (c.exact && typeof c.exact === "object") return c.exact;
  if (c.exact === false) return null;
  return num(c.lcoe_usd_per_mwh) !== undefined && num(c.annual_t_co2e) !== undefined ? c : null;
}

/** The clean measure the request targeted, read from a design's metrics. */
export const cleanOf = (m: Metrics | null | undefined, metric: CleanMetric): number | undefined =>
  num(metric === "cfe_24_7" ? m?.cfe_score_24_7 : m?.onsite_clean_share);

/** Rounded identity of a design's assets, to tell whether the store already holds it. */
export function assetsKey(assets: Asset[] | undefined): string {
  const r = (x: number | null | undefined) => Math.round((x ?? 0) * 10) / 10;
  return JSON.stringify(
    (assets ?? [])
      .map((a) => [a.kind, r(a.capacity_mw), r(a.duration_h), a.location ? [r(a.location.lon * 100), r(a.location.lat * 100)] : null])
      .sort(),
  );
}

/** A loadable scenario for a point that came without one: the mix at the campus, on the template's site. */
export function scenarioFromMix(template: Scenario, mix: Mix, mwh?: number | null): Scenario {
  const assets: Asset[] = KIND_ORDER.flatMap((k) => {
    const mw = num(mix[k]) ?? 0;
    if (mw < 0.05) return [];
    const h = k === "battery" ? (batteryHours(mix, mwh) ?? 4) : null;
    return [{ id: `opt-${k}`, kind: k, capacity_mw: mw, ...(h ? { duration_h: h } : {}) }];
  });
  return { ...template, id: "optimized", name: "Optimized design", preset: null, assets };
}
