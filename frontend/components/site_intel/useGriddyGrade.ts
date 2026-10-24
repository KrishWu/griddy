"use client";
// The GriddyGrade for the selected site, for GriddyGradeCard and its details.
// OWNER: workstream E (Site Intelligence).
// Inputs are data Griddy already loads (A's site summary, E's site intel), so this adds no
// requests; the math is in feasibility.ts, the percentile in percentile.ts.
import { useMemo, useSyncExternalStore } from "react";

import { sameLoc } from "@/components/explore/geo";
import { readSummary, useSiteSummary } from "@/components/explore/useSiteSummary";
import type { LngLat, Provenance, Scenario } from "@/lib/contract";
import { useGridForge } from "@/lib/store";

import { calculateFeasibilityScore, DEFAULT_LOAD_MW, type FeasibilityResult } from "./feasibility";
import { feasibilityInput } from "./feasibilityInput";
import table from "./gradePercentiles.json";
import { displayPercentile, percentileAt, type PercentileTable } from "./percentile";

const PERCENTILES = table as PercentileTable;

export type LoadBasis = "scenario" | "default";

export interface ScenarioLoad {
  avgMw: number;
  peakMw: number;
  loadFactor: number;
}

// The load choice lives in this tiny module store, not component state, so it survives the card
// remounting (AppShell re-keys panels on Run and moves the card between layouts). A view
// preference only: never persisted.
let loadBasis: LoadBasis = "scenario";
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};

export function setLoadBasis(basis: LoadBasis): void {
  loadBasis = basis;
  listeners.forEach((fn) => fn());
}

/** The scenario's average data center load (facility peak x load factor); null when it isn't a data center. */
function scenarioLoad(s: Scenario | null): ScenarioLoad | null {
  if (!s || (s.demand.kind ?? "data_center") !== "data_center") return null;
  const loadFactor = s.demand.load_factor ?? 0.9; // the contract's default
  const avgMw = s.demand.peak_mw * loadFactor;
  return Number.isFinite(avgMw) && avgMw > 0 ? { avgMw, peakMw: s.demand.peak_mw, loadFactor } : null;
}

export interface GradePercentile {
  /** 0-100, unrounded. */
  value: number;
  /** Whole number, 1-99. */
  display: number;
  table: PercentileTable;
}

export interface GriddyGrade {
  result: FeasibilityResult | null;
  /** The grade's rank among plausible California sites at the same load; null without a result. */
  percentile: GradePercentile | null;
  loading: boolean;
  error: string | null;
  /** Site intel hasn't arrived: air quality counts as missing until it does. */
  intelPending: boolean;
  scenarioLoad: ScenarioLoad | null;
  usingScenarioLoad: boolean;
  loadMw: number;
  /** Provenance of every input (A's summary + E's intel). */
  provenance: Provenance[];
  siteName: string | null;
  location: LngLat | null;
}

export function useGriddyGrade(): GriddyGrade {
  const { scenario, siteIntel, siteSummary: storeSummary } = useGridForge();
  const { summary, loading, error } = useSiteSummary();
  const view = useMemo(() => (summary ? readSummary(summary) : null), [summary]);
  const basis = useSyncExternalStore(subscribe, () => loadBasis, () => "scenario" as const);

  const location = scenario?.site.location ?? null;
  // The store publishes summary and intel together, so a store summary for this site means intel
  // has settled (and a missing intel then means it failed), not that it is still loading.
  const intel = siteIntel && location && sameLoc(siteIntel.location, location) ? siteIntel : null;
  const intelPending = !intel && !(location && sameLoc(storeSummary?.site?.location, location));

  const load = useMemo(() => scenarioLoad(scenario), [scenario]);
  const usingScenarioLoad = basis === "scenario" && load !== null;
  const loadMw = usingScenarioLoad ? load.avgMw : DEFAULT_LOAD_MW;

  const input = useMemo(() => (view ? feasibilityInput({ summary, view, intel, intelPending }) : null), [summary, view, intel, intelPending]);
  const result = useMemo(() => (input ? calculateFeasibilityScore(input, loadMw) : null), [input, loadMw]);
  const percentile = useMemo(() => {
    const p = result ? percentileAt(result.overallScoreRaw, loadMw, PERCENTILES) : Number.NaN;
    return Number.isFinite(p) ? { value: p, display: displayPercentile(p), table: PERCENTILES } : null;
  }, [result, loadMw]);
  const provenance = useMemo(() => [...(summary?.provenance ?? []), ...(intel?.provenance ?? [])], [summary, intel]);

  // A clicked site is named "Site at lat, lon" by the store: prefer the backend's "Site in X County, CA".
  const siteName = scenario ? (summary?.site?.name && scenario.site.name.startsWith("Site at") ? summary.site.name : scenario.site.name) : null;
  return { result, percentile, loading, error, intelPending, scenarioLoad: load, usingScenarioLoad, loadMw, provenance, siteName, location };
}
