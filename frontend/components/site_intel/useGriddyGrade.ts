"use client";
// The GriddyGrade for the selected site and the proposed generation project, for GriddyGradeCard,
// its details and D's report.  OWNER: workstream E (Site Intelligence).
// Inputs are data Griddy already loads (A's site summary, E's site intel), so this adds no
// requests: changing the technology or capacity only recomputes the score. The math is in
// feasibility.ts, the numbers in feasibilityPolicy.ts, the percentile in percentile.ts.
import { useMemo, useSyncExternalStore } from "react";

import { sameLoc } from "@/components/explore/geo";
import { readSummary, useSiteSummary } from "@/components/explore/useSiteSummary";
import type { LngLat, Provenance } from "@/lib/contract";
import { useGridForge } from "@/lib/store";

import { calculatePowerPlantFeasibility, type FeasibilityResult, type ProjectInput } from "./feasibility";
import { feasibilityInput, intelFor } from "./feasibilityInput";
import { POWER_PLANT_POLICY, type CoolingConfig, type GenerationTechnology, type ScoringPolicy } from "./feasibilityPolicy";
import table from "./gradePercentiles.json";
import { cutoffsFor, displayPercentile, percentileFor, type PercentileTable } from "./percentile";

const PERCENTILES = table as PercentileTable;
export const POLICY: ScoringPolicy = POWER_PLANT_POLICY;

/** The proposed project as entered: numbers stay text so an invalid entry is shown, never replaced. */
export interface ProjectDraft {
  technology: GenerationTechnology;
  capacityText: string;
  cooling: CoolingConfig;
  /** Optional co-located storage, MW (shown separately, never scored). */
  storageText: string;
}

export const DEFAULT_DRAFT: ProjectDraft = { technology: POLICY.defaults.technology, capacityText: String(POLICY.defaults.capacityMw), cooling: "not_specified", storageText: "" };

// The project lives in this tiny module store, not component state, so it survives the card
// remounting (AppShell re-keys panels on Run). Separate from the data center scenario, which it
// never changes. A view setting only: never persisted.
let draft: ProjectDraft = DEFAULT_DRAFT;
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};

export function setProjectDraft(patch: Partial<ProjectDraft>): void {
  draft = { ...draft, ...patch };
  listeners.forEach((fn) => fn());
}

export function useProjectDraft(): ProjectDraft {
  return useSyncExternalStore(subscribe, () => draft, () => DEFAULT_DRAFT);
}

/** A typed number: "" and anything that isn't a plain number become NaN (so validation reports it). */
const parseMw = (text: string) => (/^\s*[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?\s*$/i.test(text.replace(/,/g, "")) ? Number(text.replace(/,/g, "")) : Number.NaN);

export function draftInput(d: ProjectDraft): ProjectInput {
  return { technology: d.technology, capacityMw: parseMw(d.capacityText), cooling: d.cooling, storageMw: d.storageText.trim() === "" ? null : parseMw(d.storageText) };
}

export interface GradePercentile {
  /** 0-100, unrounded. */
  value: number;
  /** To the nearest tenth, 0.1-99.9. */
  display: number;
  /** Reference sites for this technology and tier. */
  count: number;
  reference: string;
  table: PercentileTable;
}

export interface GriddyGrade {
  /** null while loading, or when the project settings are invalid (see projectErrors). */
  result: FeasibilityResult | null;
  projectErrors: string[];
  draft: ProjectDraft;
  /** The score's rank among plausible California sites for the same technology and tier. */
  percentile: GradePercentile | null;
  loading: boolean;
  error: string | null;
  /** Site intel hasn't arrived: its inputs are loading, so the score is provisional. */
  intelPending: boolean;
  /** Provenance of every input (A's summary + E's intel). */
  provenance: Provenance[];
  siteName: string | null;
  location: LngLat | null;
  policy: ScoringPolicy;
}

export function useGriddyGrade(): GriddyGrade {
  const { scenario, siteIntel, siteSummary: storeSummary } = useGridForge();
  const { summary, loading, error } = useSiteSummary();
  const view = useMemo(() => (summary ? readSummary(summary) : null), [summary]);
  const d = useProjectDraft();

  const location = scenario?.site.location ?? null;
  // Only intel for the current location counts, so a late answer for an earlier click can't leak in.
  // The store publishes summary and intel together, so a store summary for this site means intel
  // has settled (and a missing intel then means it failed), not that it is still loading.
  const intel = intelFor(siteIntel, location);
  const intelPending = !intel && !(location && sameLoc(storeSummary?.site?.location, location));

  const site = useMemo(() => (view ? feasibilityInput({ summary, view, intel, intelPending }) : null), [summary, view, intel, intelPending]);
  const outcome = useMemo(() => (site ? calculatePowerPlantFeasibility(site, draftInput(d), POLICY) : null), [site, d]);
  const result = outcome?.valid ? outcome : null;
  const projectErrors = outcome && !outcome.valid ? outcome.errors : [];
  const percentile = useMemo(() => {
    const c = result ? cutoffsFor(result.project.technology, result.voltageTier.minKv, PERCENTILES) : null;
    const p = result && c ? percentileFor(result.overallScoreRaw, c.cutoffs) : Number.NaN;
    return c && Number.isFinite(p) ? { value: p, display: displayPercentile(p), count: c.count, reference: PERCENTILES.reference, table: PERCENTILES } : null;
  }, [result]);
  const provenance = useMemo(() => [...(summary?.provenance ?? []), ...(intel?.provenance ?? [])], [summary, intel]);

  // A clicked site is named "Site at lat, lon" by the store: prefer the backend's "Site in X County, CA".
  const siteName = scenario ? (summary?.site?.name && scenario.site.name.startsWith("Site at") ? summary.site.name : scenario.site.name) : null;
  return { result, projectErrors, draft: d, percentile, loading, error, intelPending, provenance, siteName, location, policy: POLICY };
}
