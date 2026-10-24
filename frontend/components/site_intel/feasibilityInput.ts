// Builds the power plant score's SiteData from data Griddy already loads for the selected site:
// A's site summary (through A's readSummary selector) and E's site intel. No new requests and no
// new data sources.  OWNER: workstream E (Site Intelligence).
// Only `import type`, so Node runs this file as-is in the tests (feasibility.test.mjs).
//
// Every input carries its dataset's state (feasibilityPolicy.ts SourceState), read by that
// dataset's semantics: an empty EPA list inside the loaded California layer is "no listed
// nonattainment", an empty territory lookup is "none identified", but a layer that did not load,
// a lookup still in flight or a point outside California is never read as absence or attainment.
import type { SiteView } from "@/components/explore/useSiteSummary";
import type { SiteIntel, SiteSummary } from "@/lib/contract";

import type {
  Designation,
  GridAsset,
  GridAssetObservation,
  GridTierInput,
  Observation,
  QueueContext,
  ResourceObservation,
  SiteData,
} from "./feasibility";
import type { SourceState } from "./feasibilityPolicy";

const OUTSIDE = "outside California data coverage";
const ML_MAX_CELL_KM = 5; // a farther 5 km cell describes somewhere else (as backend/app/site_intel/ml.py)
const HV_KV = 220; // A's summary reports the 220 kV+ tier itself (Griddy's 220 kV+ class)
const TIERS_KV = [69, 115, 220];
const NO_ENV_SCREEN = "Griddy has no documented, technology-applicable environmental screening method (e.g. habitat, wetlands, cultural resources or coastal zone)";

const rec = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const missing = <T>(state: SourceState, reason?: string): Observation<T> => ({ state, value: null, ...(reason ? { reason } : {}) });

/**
 * Site intel only when it answers for the current location (within ~100 m, as A's sameLoc), so a
 * late response for an earlier click can't update the current assessment.
 */
export function intelFor<T extends { location: { lon: number; lat: number } }>(intel: T | null | undefined, location: { lon: number; lat: number } | null, tolDeg = 1e-3): T | null {
  if (!intel || !location) return null;
  return Math.abs(intel.location.lon - location.lon) <= tolDeg && Math.abs(intel.location.lat - location.lat) <= tolDeg ? intel : null;
}

export interface FeasibilitySources {
  /** A's summary for the current site, and readSummary(summary); null while loading or after an error. */
  summary: SiteSummary | null;
  view: SiteView | null;
  /** E's site intel for the current site; null when it failed or hasn't arrived yet. */
  intel: SiteIntel | null;
  /** Site intel is still on its way (its inputs are loading, not missing). */
  intelPending?: boolean;
}

/** A substation or line as the summary and grid_tiers report it. Operating status: see grid_tiers.py. */
function asset(v: unknown): GridAsset | null {
  const r = rec(v);
  if (!r) return null;
  return { name: str(r.name), voltageKv: num(r.voltage_kv), distanceKm: num(r.distance_km), operatingEstablished: true, closerUntaggedKm: num(r.closer_untagged_km) };
}

function assetObs(state: unknown, v: unknown, layer: string): GridAssetObservation {
  if (state === "available") {
    const a = asset(v);
    return a ? { state: "available", value: a } : missing("unavailable", `${layer} result unreadable`);
  }
  if (state === "confirmed_absent") return { state: "confirmed_absent", value: null, searchedKm: Number.POSITIVE_INFINITY, reason: `no qualifying ${layer} anywhere in the California layer` };
  return missing("unavailable", `${layer} layer did not load`);
}

/** Nearest qualifying assets per threshold: E's grid_tiers, else A's summary for the 220 kV+ tier. */
function gridTiers(x: Record<string, unknown>, ix: Record<string, unknown> | null, view: SiteView, intelState: SourceState): Partial<Record<number, GridTierInput>> {
  const out: Partial<Record<number, GridTierInput>> = {};
  const tiers = rec(rec(ix?.grid_tiers)?.tiers);
  const missingData = new Set(Array.isArray(x.missing_data) ? x.missing_data.filter((v): v is string => typeof v === "string") : []);
  for (const kv of TIERS_KV) {
    const t = rec(tiers?.[String(kv)]);
    if (t) {
      out[kv] = { substation: assetObs(t.substation_state, t.substation, "substation"), line: assetObs(t.line_state, t.line, "transmission line") };
    } else if (kv === HV_KV) {
      // A's summary runs the same 220 kV+ search, so this tier doesn't wait for site intel.
      const sub = missingData.has("substations") ? missing<GridAsset>("unavailable", "substation layer did not load") : view.hvSubstation ? { state: "available" as const, value: asset(view.hvSubstation) } : missing<GridAsset>("unavailable", "no 220 kV+ substation in the summary");
      const line = missingData.has("transmission") ? missing<GridAsset>("unavailable", "transmission layer did not load") : view.hvLine ? { state: "available" as const, value: asset(view.hvLine) } : missing<GridAsset>("unavailable", "no operational 220 kV+ line in the summary");
      out[kv] = { substation: sub, line };
    } else {
      const reason = intelState === "loading" ? "site screening still loading" : intelState === "error" ? "site screening failed" : "voltage-tier search unavailable";
      const state: SourceState = intelState === "available" ? "unavailable" : intelState;
      out[kv] = { substation: missing(state, reason), line: missing(state, reason) };
    }
  }
  return out;
}

const ML_KINDS = ["solar_pv", "onshore_wind", "gas_cc", "battery"];

/** Model and resource inputs that don't apply here, with why. */
function none(state: SourceState, reason: string): Pick<SiteData, "resource" | "sitingSimilarity"> {
  const o = (kind: ResourceObservation["kind"]): ResourceObservation => ({ state, value: null, unit: "", kind, source: "Griddy site-location artifact", reason });
  return { resource: { ghi_annual_mean: o("observed"), wind_speed_hub: o("observed") }, sitingSimilarity: Object.fromEntries(ML_KINDS.map((k) => [k, o("inferred")])) };
}

/** The site cell's model and resource signals (E's extras.ml), with the state when they don't apply. */
function mlInputs(m: Record<string, unknown> | null, intelState: SourceState): Pick<SiteData, "resource" | "sitingSimilarity"> {
  if (intelState !== "available") return none(intelState, intelState === "loading" ? "site screening still loading" : "site screening failed");
  if (!m || m.available !== true) return none("unavailable", str(m?.reason) ?? "model signals not in the site screening");
  const cellKm = num(rec(m.cell)?.distance_km);
  if (cellKm === null || cellKm > ML_MAX_CELL_KM) return none("unavailable", cellKm === null ? "model signals incomplete" : `nearest model cell is ${cellKm.toFixed(1)} km away`);
  const art = rec(m.site_artifact);
  const artifactId = str(art?.id) ?? "unknown artifact";
  const metrics = rec(art?.model_metrics) ?? {};
  const site = rec(m.site_cell);
  const basis = rec(m.resource_basis) ?? {};
  const resource = rec(site?.resource) ?? {};
  const period = str(basis.period) ?? undefined;
  const gridKm = num(basis.grid_km) ?? undefined;
  const resSource = `${str(basis.source) ?? "Reanalysis"} via B's site artifact ${artifactId}${num(basis.years) === 1 ? " (one year, not a long-term mean)" : ""}`;
  const res = (value: number | null, unit: string, heightM?: number): ResourceObservation =>
    value === null
      ? { state: "unavailable", value: null, unit, kind: "observed", source: resSource, reason: "not in the site artifact" }
      : { state: "available", value, unit, ...(heightM !== undefined ? { heightM } : {}), ...(gridKm !== undefined ? { gridKm } : {}), ...(period ? { period } : {}), kind: "observed", source: resSource };

  const suit = rec(site?.suitability) ?? {};
  const sitingSimilarity: SiteData["sitingSimilarity"] = {};
  for (const kind of ML_KINDS) {
    const p = num(suit[kind]);
    const auc = num(rec(metrics[kind])?.roc_auc);
    sitingSimilarity[kind] =
      p === null
        ? { state: "unavailable", value: null, unit: "model score (0-1)", kind: "inferred", source: `Griddy site-location model ${artifactId}`, reason: "no model for this technology in the artifact" }
        : {
            state: "available",
            value: p,
            unit: "model score (0-1)",
            kind: "inferred",
            source: `Griddy site-location model ${artifactId}`,
            detail: `Site's 5 km cell (${cellKm.toFixed(1)} km away)${auc !== null ? `; spatial-CV ROC-AUC ${auc.toFixed(2)}` : ""}. Similar to where operating plants were built; not feasibility.`,
          };
  }
  return {
    resource: {
      ghi_annual_mean: res(num(resource.ghi_kwh_m2_day), str(basis.ghi_unit) ?? "kWh/m2/day"),
      wind_speed_hub: res(num(resource.wind100_ms), str(basis.wind_unit) ?? "m/s", num(basis.wind_height_m) ?? undefined),
    },
    sitingSimilarity,
  };
}

export function feasibilityInput({ summary, view, intel, intelPending = false }: FeasibilitySources): SiteData {
  const x = rec(summary?.extras) ?? {};
  const ix = rec(intel?.extras);
  const missingData = new Set(Array.isArray(x.missing_data) ? x.missing_data.filter((v): v is string => typeof v === "string") : []);
  const intelState: SourceState = intel ? "available" : intelPending ? "loading" : "error";
  const inCoverage = view?.inCalifornia ?? null;
  const outside = inCoverage === false;
  const location = summary?.site?.location ?? intel?.location ?? null;
  const noSummary = "site summary not loaded";

  // Grid: nearest qualifying assets per voltage threshold; outside California nothing is mapped.
  let grid: SiteData["grid"] = {};
  if (view && !outside) grid = gridTiers(x, ix, view, intelState);
  else {
    const o: GridAssetObservation = outside ? missing("outside_coverage", `${OUTSIDE}: out-of-state infrastructure is not mapped`) : missing("loading", noSummary);
    grid = Object.fromEntries(TIERS_KV.map((kv) => [kv, { substation: o, line: o }]));
  }

  const { resource, sitingSimilarity } = outside ? none("outside_coverage", OUTSIDE) : mlInputs(rec(ix?.ml), intelState);

  // Population: A's 2020 Census block groups, California only.
  let population: Observation<number>;
  if (!view) population = missing("loading", noSummary);
  else if (outside) population = missing("outside_coverage", `${OUTSIDE}: the Census layer covers California only`);
  else if (view.population === null) population = missing("unavailable", missingData.has("population") ? "population layer did not load" : "no estimate for this point");
  else population = { state: "available", value: view.population };

  // EPA designations: the Green Book layer is California-only, so an empty list elsewhere is not attainment.
  let designations: Observation<Designation[]>;
  if (!intel) designations = missing(intelState, intelPending ? "site screening still loading" : "site screening failed");
  else if (outside) designations = missing("outside_coverage", `${OUTSIDE}: EPA Green Book areas are loaded for California only`);
  else if (ix?.nonattainment_available === false || !Array.isArray(ix?.nonattainment)) designations = missing("unavailable", "EPA designation data did not load");
  else {
    designations = {
      state: "available",
      value: (ix.nonattainment as unknown[])
        .map(rec)
        .filter((d): d is Record<string, unknown> => d !== null)
        .map((d) => ({ pollutant: str(d.pollutant), naaqs: str(d.naaqs), area: str(d.area), classification: str(d.classification) })),
    };
  }
  const aq = rec(intel?.air_quality);
  const aqi = aq ? { aqi: num(aq.aqi), category: str(aq.category), pollutant: str(aq.pollutant) } : null;

  // Utility / balancing authority: A's polygon lookups. "None" is a real answer (outside California a
  // definitive non-identification for this context metric); a layer that did not load is unresolved.
  // CAISO assumed by default does not count.
  const lookup = (layer: string, key: string, name: string | null): Observation<string> => {
    if (!view) return missing("loading", noSummary);
    if (missingData.has(layer) || !(key in x)) return missing("unavailable", `${layer.replace("_", " ")} layer did not load`);
    if (name) return { state: "available", value: name };
    return missing(outside ? "outside_coverage" : "confirmed_absent", outside ? OUTSIDE : "no territory contains this point");
  };
  const utility = lookup("utilities", "utility", view ? (view.utility ?? view.utilityTitle) : null);
  const balancingAuthority = lookup("balancing_authorities", "balancing_authority", view ? (view.balancingAuthority ?? view.balancingAuthorityTitle) : null);

  // Protected-area overlap: E's land screening, precomputed for the demo areas only.
  const share = num(ix?.protected_share);
  const protectedShare: Observation<number> = !intel
    ? missing(intelState, intelPending ? "site screening still loading" : "site screening failed")
    : share !== null
      ? { state: "available", value: share }
      : missing("unavailable", "land screening covers the Kern, Tracy and Los Banos demo areas only");

  // County queue (A's LBNL aggregate), context only.
  const qc = rec(x.queue_county);
  const queue: Observation<QueueContext> = qc
    ? { state: "available", value: { county: str(qc.county), activeMw: num(qc.active_mw), activeProjects: num(qc.active_projects), asOf: str(qc.as_of) } }
    : missing(view ? "unavailable" : "loading", view ? "no county queue record" : noSummary);

  const nearbyFuelMw: Observation<Record<string, number>> =
    view && !outside && !missingData.has("plants") && rec(x.plants_within_25km) ? { state: "available", value: Object.fromEntries(view.plantsByFuel) } : missing(view ? "unavailable" : "loading");

  return {
    location: location ? { lon: location.lon, lat: location.lat } : null,
    inCoverage,
    grid,
    resource,
    sitingSimilarity,
    population,
    designations,
    environmentalScreen: missing("unavailable", NO_ENV_SCREEN),
    aqi,
    utility,
    balancingAuthority,
    protectedShare,
    queue,
    nearbyFuelMw,
  };
}
