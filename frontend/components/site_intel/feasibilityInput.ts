// Builds the feasibility score's input from data Griddy already loads for the selected site:
// A's site summary (through A's readSummary selector) and E's site intel. No new requests and
// no new data sources.  OWNER: workstream E (Site Intelligence).
// Only `import type`, so Node runs this file as-is in the tests (feasibility.test.mjs).
import type { SiteView } from "@/components/explore/useSiteSummary";
import type { SiteIntel, SiteSummary } from "@/lib/contract";

import type { AssetRef, CleanKind, ComponentKey, DemandSignal, Designation, FeasibilityInput, Lookup, MlSignals } from "./feasibility";

const OUTSIDE = "outside California data coverage";
const ML_MAX_CELL_KM = 5; // as feasibility.ts: a farther 5 km cell describes somewhere else
const CLEAN_KINDS: CleanKind[] = ["solar_pv", "onshore_wind", "battery"];

const rec = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

function asset(v: { name: string; voltage_kv: number | null; distance_km: number | null } | null): AssetRef | null {
  return v ? { name: v.name, voltageKv: v.voltage_kv, distanceKm: v.distance_km } : null;
}

/** A's forecast as E's site intel passes it (backend/app/site_intel/ml.py); null when incomplete. */
function demandSignal(f: Record<string, unknown> | null): DemandSignal | null {
  const region = rec(f?.region);
  const metrics = rec(f?.metrics) ?? {};
  const v = {
    forecastId: str(f?.artifact_id),
    scenario: str(f?.scenario),
    year: num(f?.year),
    baseYear: num(f?.base_year),
    regionName: str(region?.name) ?? str(region?.id),
    basePeakP50Mw: num(region?.base_peak_mw_p50),
    peakP50Mw: num(region?.peak_mw_p50),
  };
  if (Object.values(v).some((x) => x === null)) return null;
  return { ...(v as { [K in keyof typeof v]: NonNullable<(typeof v)[K]> }), mapeP50Pct: num(metrics.mape_p50_pct), coverage: num(metrics.p10_p90_coverage) };
}

/** E's extras.ml, or the reason it can't describe this site. */
function mlSignals(m: Record<string, unknown> | null): { ml: MlSignals | null; reason?: string } {
  if (!m || m.available !== true) return { ml: null, reason: str(m?.reason) ?? "model signals not in the site screening" };
  const art = rec(m.site_artifact);
  const cell = rec(m.cell);
  const cellKm = num(cell?.distance_km);
  const artifactId = str(art?.id);
  if (!artifactId || cellKm === null) return { ml: null, reason: "model signals incomplete" };
  if (cellKm > ML_MAX_CELL_KM) return { ml: null, reason: `nearest model cell is ${cellKm.toFixed(1)} km away` };
  const metrics = rec(art?.model_metrics) ?? {};
  const clean = rec(m.clean_build);
  const rocAuc: MlSignals["rocAuc"] = {};
  for (const k of CLEAN_KINDS) {
    const auc = num(rec(metrics[k])?.roc_auc);
    if (auc !== null) rocAuc[k] = auc;
  }
  return {
    ml: {
      artifactId,
      rocAuc,
      cellKm,
      county: str(cell?.county),
      queueMw: num(m.queue_mw),
      cleanBuild: clean ? (Object.fromEntries(CLEAN_KINDS.map((k) => [k, num(rec(clean[k])?.best)])) as Record<CleanKind, number | null>) : null,
      demand: demandSignal(rec(m.forecast)),
    },
  };
}

export interface FeasibilitySources {
  /** A's summary for the current site, and readSummary(summary); null while loading or after an error. */
  summary: SiteSummary | null;
  view: SiteView | null;
  /** E's site intel for the current site; null when it failed or hasn't arrived yet. */
  intel: SiteIntel | null;
  /** Site intel is still on its way: its inputs count as missing, with that reason. */
  intelPending?: boolean;
}

export function feasibilityInput({ summary, view, intel, intelPending = false }: FeasibilitySources): FeasibilityInput {
  const x = rec(summary?.extras) ?? {};
  const ix = rec(intel?.extras) ?? {};
  // Datasets A's backend could not load: their lookups are unknown, not "none found".
  const missing = new Set(Array.isArray(x.missing_data) ? x.missing_data.filter((v): v is string => typeof v === "string") : []);
  const outside = view?.inCalifornia === false;
  const reasons: Partial<Record<ComponentKey, string>> = {};
  const noSummary = "site summary not loaded";
  const noIntel = intelPending ? "site screening still loading" : "site screening unavailable";

  // Grid: A's nearest 220 kV+ substation and operational AC 220 kV+ line, never a lower-voltage fallback.
  let substation: AssetRef | null = null;
  let line: AssetRef | null = null;
  if (!view) reasons.grid = noSummary;
  else if (outside) reasons.grid = `${OUTSIDE}: out-of-state infrastructure is not mapped, so distances would be overstated`;
  else {
    substation = missing.has("substations") ? null : asset(view.hvSubstation);
    line = missing.has("transmission") ? null : asset(view.hvLine);
    const why: string[] = [];
    if (!substation) why.push(missing.has("substations") ? "substation layer did not load" : "no 220 kV+ substation mapped");
    if (!line) why.push(missing.has("transmission") ? "transmission layer did not load" : "no operational 220 kV+ line mapped");
    if (why.length) reasons.grid = why.join("; ");
  }

  // Generation: A's full 25 km aggregate (generator-level fuel split), else the capped plant list.
  let generation: FeasibilityInput["generation"] = null;
  if (!view) reasons.generation = noSummary;
  else if (outside) reasons.generation = `${OUTSIDE}: plants outside California are not in the EIA layer`;
  else if (missing.has("plants")) reasons.generation = "plant layer did not load";
  else {
    const agg = rec(x.plants_within_25km);
    const split = agg !== null && rec(agg.by_fuel_mw) !== null;
    generation = {
      plantCount: view.plantsCount,
      byFuelMw: split || view.plantsCount === 0 ? Object.fromEntries(view.plantsByFuel) : null,
      totalMw: view.plantsTotalMw,
      incomplete: agg === null && view.plants.length > 0,
    };
  }

  let population: number | null = null;
  if (!view) reasons.community = noSummary;
  else if (outside) reasons.community = `${OUTSIDE}: the Census layer covers California only`;
  else if (view.population === null) reasons.community = missing.has("population") ? "population layer did not load" : "no estimate for this point";
  else population = view.population;

  // EPA designations: the Green Book layer is California-only, so an empty list elsewhere is not attainment.
  let designations: Designation[] | null = null;
  if (!intel) reasons.air = noIntel;
  else if (outside) reasons.air = `${OUTSIDE}: EPA Green Book areas are loaded for California only`;
  else if (ix.nonattainment_available === false || !Array.isArray(ix.nonattainment)) reasons.air = "EPA designation data did not load";
  else {
    designations = ix.nonattainment
      .map(rec)
      .filter((d): d is Record<string, unknown> => d !== null)
      .map((d) => ({ pollutant: str(d.pollutant), naaqs: str(d.naaqs), area: str(d.area), classification: str(d.classification) }));
  }
  const aq = rec(intel?.air_quality);
  const aqi = aq ? { aqi: num(aq.aqi), category: str(aq.category), pollutant: str(aq.pollutant) } : null;

  // Model signals (queue, clean-build similarity, demand forecast): missing when the artifact is
  // absent, the site is outside California, or the nearest 5 km cell is more than 5 km away.
  const signals = !intel ? { ml: null, reason: noIntel } : outside ? { ml: null, reason: OUTSIDE } : mlSignals(rec(ix.ml));

  // Utility / balancing authority: A's polygon lookups. "None" is a real answer (incl. outside
  // California); a layer that did not load is unknown. CAISO assumed by default does not count.
  const unknown: Lookup = { status: "unknown" };
  const lookup = (name: string | null): Lookup => (name ? { status: "identified", name } : { status: "none" });
  const utility = !view || missing.has("utilities") || !("utility" in x) ? unknown : lookup(view.utility ?? view.utilityTitle);
  const balancingAuthority =
    !view || missing.has("balancing_authorities") || !("balancing_authority" in x) ? unknown : lookup(view.balancingAuthority ?? view.balancingAuthorityTitle);
  if (!view) reasons.infrastructure = noSummary;
  else if (utility.status === "unknown" || balancingAuthority.status === "unknown") reasons.infrastructure = "territory layer did not load";

  return {
    substation,
    line,
    generation,
    population,
    designations,
    aqi,
    utility,
    balancingAuthority,
    outsideCoverage: outside,
    reasons,
    ml: signals.ml,
    ...(signals.reason ? { mlReason: signals.reason } : {}),
  };
}
