"use client";
// App-wide state: the scenario being edited, the latest results, and the selected
// site.  OWNER: workstream D. Other workstreams: ask D for new shared state and keep
// everything else in local component state. Panels read/write through useGridForge().
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { runWithProgress, type RunProgress } from "@/components/builder/runWithProgress";
import { useProjectPlanning, type ProjectPlanningState } from "@/components/builder/useProjectPlanning";
import { allowSitePlacement } from "@/components/site_intel/regionGuard";

import { api } from "./api";
import { SCHEMA_VERSION, type LngLat, type MapOverlay, type Mode, type Scenario, type ScenarioResult, type SiteIntel, type SiteSummary } from "./contract";

export type View = "single" | "compare";
type ErrorSource = "presets" | "run" | "compare";

interface GridForgeState {
  presets: Scenario[];
  scenario: Scenario | null;
  projectPlanning: ProjectPlanningState;
  /** The scenario's display name: the preset's name, or "<preset> (modified)" once edited. */
  scenarioLabel: string;
  setScenario: (s: Scenario) => void;
  updateScenario: (fn: (s: Scenario) => Scenario) => void;
  /** Load a preset, keeping the current site, its grid context, and assumption edits. */
  applyPreset: (id: string) => void;
  /** Load a preset exactly as Compare ran it (current demand, portfolio scaled to it). */
  loadCompared: (id: string) => void;
  /** Switch Industrial / Community: loads that mode's default preset. No-op if already in it. */
  setMode: (mode: Mode) => void;
  /** Change the facility peak; rescales assets and grid limits when scaleWithDemand is on. */
  setPeakMw: (peakMw: number) => void;
  /** Change IT (compute) load at the current PUE: facility peak = IT x PUE. */
  setItLoadMw: (itMw: number) => void;
  /** Change PUE at the current IT load: facility peak = IT x PUE, so better cooling means
   *  less grid energy for the same compute. */
  setPue: (pue: number) => void;
  scaleWithDemand: boolean;
  setScaleWithDemand: (on: boolean) => void;
  autoRun: boolean;
  setAutoRun: (on: boolean) => void;
  result: ScenarioResult | null;
  /** Increments with every new result. */
  resultVersion: number;
  /** Increments only on deliberate actions (Run, Retry, preset/mode change). AppShell keys
   *  panel error boundaries on it, so auto-runs never remount panels and reset their state. */
  panelEpoch: number;
  running: boolean;
  runProgress: (RunProgress & { startedAt: number }) | null;
  error: string | null;
  run: () => Promise<void>;
  /** Explicit Run button: also resets any crashed panel. */
  runNow: () => Promise<void>;
  /** Retry whatever failed last (presets, run, or compare). */
  retry: () => void;
  view: View;
  setView: (v: View) => void;
  compareResults: ScenarioResult[] | null;
  /** True when the scenario changed since compareResults were computed. */
  compareStale: boolean;
  comparing: boolean;
  runCompare: () => Promise<void>;
  selectSite: (p: LngLat) => Promise<void>;
  siteSummary: SiteSummary | null;
  siteIntel: SiteIntel | null;
  overlays: MapOverlay[];
}

const Ctx = createContext<GridForgeState | null>(null);

const DEFAULT_PRESET: Record<Mode, string> = { industrial: "hybrid", community: "community_microgrid" };
const STORAGE_KEY = "gridforge:scenario";

/** The last edited scenario, so a reload (or opening /report directly) keeps the user's design. */
function readSavedScenario(): Scenario | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const s = raw ? (JSON.parse(raw) as Scenario) : null;
    return s && s.schema_version === SCHEMA_VERSION ? s : null;
  } catch {
    return null;
  }
}

/**
 * The website always opens at the default site (Stanford): a saved design keeps its assets,
 * demand and assumptions, but its site and that site's grid context come from the preset.
 * /report keeps the saved site, since it reports that exact design.
 */
function startAtDefaultSite(saved: Scenario, preset: Scenario | undefined): Scenario {
  if (!preset || typeof window === "undefined" || window.location.pathname.startsWith("/report")) return saved;
  return {
    ...saved,
    site: preset.site,
    grid: {
      ...saved.grid,
      poi_voltage_kv: preset.grid.poi_voltage_kv ?? null,
      interconnection_km: preset.grid.interconnection_km,
      substation_id: preset.grid.substation_id ?? null,
    },
  };
}

/** Multiply every asset and the grid limits by `factor` (no rounding, so repeated slider moves don't drift). */
function scaleScenario(s: Scenario, factor: number): Scenario {
  return {
    ...s,
    assets: s.assets.map((a) => ({ ...a, capacity_mw: a.capacity_mw * factor })),
    grid: {
      ...s.grid,
      import_limit_mw: s.grid.import_limit_mw * factor,
      export_limit_mw: (s.grid.export_limit_mw ?? 0) * factor,
    },
  };
}

/** Set the facility peak, scaling the portfolio and grid limits with it when `scale` is on. */
function withPeak(s: Scenario, peakMw: number, scale: boolean): Scenario {
  const next = { ...s, demand: { ...s.demand, peak_mw: peakMw } };
  return scale && s.demand.peak_mw > 0 ? scaleScenario(next, peakMw / s.demand.peak_mw) : next;
}

/** IT (compute) load implied by the contract's facility peak: peak_mw = IT x PUE. */
export function itLoadMw(s: Scenario): number {
  return s.demand.peak_mw / (s.demand.pue ?? 1.2);
}

/** A preset as it would apply to the current scenario: same site, grid context, assumptions, and (optionally) demand. */
function adaptPreset(p: Scenario, cur: Scenario | null, scale: boolean): Scenario {
  if (!cur) return p;
  const sameMode = (cur.mode ?? "industrial") === (p.mode ?? "industrial");
  let next: Scenario = {
    ...p,
    site: cur.site,
    // Transmission context (line distance, POI voltage) only carries over within a mode:
    // a community microgrid ties into distribution, not the campus's transmission line.
    grid: sameMode ? { ...p.grid, interconnection_km: cur.grid.interconnection_km, poi_voltage_kv: cur.grid.poi_voltage_kv } : p.grid,
    assumptions: cur.assumptions ?? p.assumptions,
    options: { ...cur.options, ...p.options },
  };
  // Keep household and project assumptions across presets; a prior sizing result
  // does not describe the newly selected preset.
  if (next.options) delete next.options.sizing;
  if (scale && sameMode && p.demand.peak_mw > 0 && cur.demand.peak_mw !== p.demand.peak_mw) {
    next = scaleScenario({ ...next, demand: { ...next.demand, peak_mw: cur.demand.peak_mw } }, cur.demand.peak_mw / p.demand.peak_mw);
  }
  return next;
}

/** How Compare runs a preset: on exactly the current demand, portfolio scaled to its peak. */
function compareCandidate(p: Scenario, cur: Scenario): Scenario {
  return { ...adaptPreset(p, cur, true), demand: { ...cur.demand } };
}

/** Put A's nearest-line context on an industrial scenario (community microgrids tie into distribution). */
function withLineContext(s: Scenario, summary: SiteSummary | null): Scenario {
  if (!summary || (s.mode ?? "industrial") !== "industrial") return s;
  return {
    ...s,
    grid: {
      ...s.grid,
      poi_voltage_kv: summary.nearest_line_kv ?? s.grid.poi_voltage_kv,
      interconnection_km: summary.nearest_line_km ?? s.grid.interconnection_km,
    },
  };
}

/** Identity of a design for "did anything change?" checks (ignores ids and names). */
function designKey(s: Scenario): string {
  const r = (x: number | null | undefined) => Math.round((x ?? 0) * 10) / 10;
  return JSON.stringify({
    mode: s.mode ?? "industrial",
    site: [r(s.site.location.lon * 1000), r(s.site.location.lat * 1000)],
    footprint: s.site.footprint ?? null,
    options: s.options ?? {},
    demand: [r(s.demand.peak_mw), s.demand.load_factor, s.demand.pue, s.demand.profile, s.demand.flexible_share],
    assets: s.assets.map((a) => [a.kind, r(a.capacity_mw), r(a.duration_h)]).sort(),
    grid: [s.grid.connected, s.grid.new_substation, r(s.grid.import_limit_mw), r(s.grid.export_limit_mw), r(s.grid.interconnection_km), r(s.grid.poi_voltage_kv)],
    assumptions: s.assumptions ?? {},
  });
}

export function GridForgeProvider({ children }: { children: ReactNode }) {
  const [presets, setPresets] = useState<Scenario[]>([]);
  const [scenario, setScenario] = useState<Scenario | null>(null);
  const projectPlanning = useProjectPlanning(scenario, setScenario);
  const [result, setResult] = useState<ScenarioResult | null>(null);
  const [resultVersion, setResultVersion] = useState(0);
  const [panelEpoch, setPanelEpoch] = useState(0);
  const [activeRun, setActiveRun] = useState<Scenario | null>(null);
  const running = activeRun !== null && activeRun === scenario;
  const [progress, setProgress] = useState<{ scenario: Scenario; value: RunProgress & { startedAt: number } } | null>(null);
  const runProgress = progress?.scenario === scenario ? progress.value : null;
  const [error, setError] = useState<string | null>(null);
  const [errorSource, setErrorSource] = useState<ErrorSource | null>(null);
  const [siteSummary, setSiteSummary] = useState<SiteSummary | null>(null);
  const [siteIntel, setSiteIntel] = useState<SiteIntel | null>(null);
  const [scaleWithDemand, setScaleWithDemand] = useState(true);
  const [autoRun, setAutoRun] = useState(true);
  const [view, setView] = useState<View>("single");
  const [compareResults, setCompareResults] = useState<ScenarioResult[] | null>(null);
  const [compareKey, setCompareKey] = useState<string | null>(null);
  const [comparing, setComparing] = useState(false);
  const latestSiteId = useRef<string | null>(null);
  const runSeq = useRef(0);
  const runAbort = useRef<AbortController | null>(null);
  useEffect(() => () => { runSeq.current++; runAbort.current?.abort(); }, [scenario]);
  const compareSeq = useRef(0);

  const fail = useCallback((source: ErrorSource, message: string) => {
    setError(message);
    setErrorSource(source);
  }, []);

  // Fetch the site cards (A's summary, E's screening) for a location, dropping responses
  // for a site that is no longer the latest one.
  const fetchSiteCards = useCallback(async (p: LngLat, id: string): Promise<SiteSummary | null> => {
    latestSiteId.current = id;
    setSiteSummary(null);
    setSiteIntel(null);
    const [summary, intel] = await Promise.allSettled([api.siteSummary(p), api.siteIntel(p)]);
    if (latestSiteId.current !== id) return null;
    if (summary.status === "fulfilled") setSiteSummary(summary.value);
    setSiteIntel(intel.status === "fulfilled" ? intel.value : null);
    return summary.status === "fulfilled" ? summary.value : null;
  }, []);

  const loadPresets = useCallback(() => {
    api
      .presets()
      .then((ps) => {
        const saved = readSavedScenario();
        const preset = ps.find((p) => p.id === DEFAULT_PRESET[saved?.mode ?? "industrial"]) ?? ps[0];
        const initial = saved ? startAtDefaultSite(saved, preset) : (preset ?? null);
        setPresets(ps);
        setError(null);
        setErrorSource(null);
        setScenario((cur) => cur ?? initial);
        // Fill the site cards for the starting site too (not only after a map click). This
        // only loads the cards; it doesn't change the design, so a preset stays unmodified.
        if (initial) void fetchSiteCards(initial.site.location, initial.site.id);
      })
      .catch((e: Error) => fail("presets", `Could not load presets (is the backend running?): ${e.message}`));
  }, [fail, fetchSiteCards]);

  useEffect(() => loadPresets(), [loadPresets]);

  // Remember the design across reloads (per browser; a convenience, never required).
  useEffect(() => {
    if (!scenario) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(scenario));
    } catch {
      // Storage unavailable (private mode, quota): fine, nothing to persist.
    }
  }, [scenario]);

  const labelFor = useCallback(
    (s: Scenario) => {
      const p = presets.find((x) => x.id === s.preset);
      if (!p) return s.name;
      return designKey(s) === designKey(adaptPreset(p, s, scaleWithDemand)) ? p.name : `${p.name} (modified)`;
    },
    [presets, scaleWithDemand],
  );

  const run = useCallback(async () => {
    if (!scenario || projectPlanning.busy || projectPlanning.error) return;
    // Only the newest run may write state, so a slow older run (e.g. from a debounced
    // auto-run) can't overwrite a newer result.
    const my = ++runSeq.current;
    runAbort.current?.abort();
    const controller = new AbortController();
    runAbort.current = controller;
    const startedAt = Date.now();
    setActiveRun(scenario);
    setProgress({ scenario, value: { percent: 0, message: "Connecting to simulation", startedAt } });
    setError(null);
    setErrorSource(null);
    try {
      const r = await runWithProgress({ ...scenario, name: labelFor(scenario) }, (value) => {
        if (my === runSeq.current) setProgress({ scenario, value: { ...value, startedAt } });
      }, controller.signal);
      if (my === runSeq.current) {
        setResult(r);
        setResultVersion((v) => v + 1);
      }
    } catch (e) {
      if (my === runSeq.current && !controller.signal.aborted) {
        setProgress(null);
        fail("run", (e as Error).message);
      }
    } finally {
      if (my === runSeq.current) setActiveRun(null);
    }
  }, [scenario, labelFor, fail, projectPlanning.busy, projectPlanning.error]);

  const runNow = useCallback(() => {
    setPanelEpoch((e) => e + 1);
    return run();
  }, [run]);

  // Debounced auto-run: any scenario edit re-runs half a second after the last change.
  useEffect(() => {
    if (!autoRun || !scenario || projectPlanning.busy || projectPlanning.error) return;
    const t = setTimeout(() => void run(), 500);
    return () => clearTimeout(t);
  }, [run, autoRun, scenario, projectPlanning.busy, projectPlanning.error]);

  const updateScenario = useCallback((fn: (s: Scenario) => Scenario) => setScenario((s) => (s ? fn(s) : s)), []);

  const applyPreset = useCallback(
    (id: string) => {
      const p = presets.find((x) => x.id === id);
      if (!p) return;
      setScenario((cur) => adaptPreset(p, cur, scaleWithDemand));
      setPanelEpoch((e) => e + 1);
    },
    [presets, scaleWithDemand],
  );

  const loadCompared = useCallback(
    (id: string) => {
      const p = presets.find((x) => x.id === id);
      if (!p) return;
      setScenario((cur) => (cur ? compareCandidate(p, cur) : p));
      setPanelEpoch((e) => e + 1);
      setView("single");
    },
    [presets],
  );

  const setMode = useCallback(
    (mode: Mode) => {
      if (!scenario || (scenario.mode ?? "industrial") === mode) return;
      const p = presets.find((x) => x.id === DEFAULT_PRESET[mode]) ?? presets.find((x) => (x.mode ?? "industrial") === mode);
      if (!p) return;
      // A clicked site's line context goes back on; the preset site keeps the preset's own grid.
      const clicked = scenario.site.id.startsWith("site-") ? siteSummary : null;
      setScenario((cur) => (cur && (cur.mode ?? "industrial") === mode ? cur : withLineContext(adaptPreset(p, cur, false), clicked)));
      setCompareResults(null);
      setPanelEpoch((e) => e + 1);
    },
    [scenario, presets, siteSummary],
  );

  const setPeakMw = useCallback(
    (peakMw: number) => setScenario((s) => (s ? withPeak(s, peakMw, scaleWithDemand) : s)),
    [scaleWithDemand],
  );

  const setItLoadMw = useCallback(
    (itMw: number) => setScenario((s) => (s ? withPeak(s, itMw * (s.demand.pue ?? 1.2), scaleWithDemand) : s)),
    [scaleWithDemand],
  );

  const setPue = useCallback(
    (pue: number) =>
      setScenario((s) => {
        if (!s) return s;
        const next = withPeak(s, itLoadMw(s) * pue, scaleWithDemand);
        return { ...next, demand: { ...next.demand, pue } };
      }),
    [scaleWithDemand],
  );

  const runCompare = useCallback(async () => {
    if (!scenario) return;
    const mode = scenario.mode ?? "industrial";
    // Every column runs on exactly the user's demand, so differences are design differences.
    const candidates = presets.filter((p) => (p.mode ?? "industrial") === mode).map((p) => compareCandidate(p, scenario));
    const key = designKey(scenario);
    const isPreset = candidates.some((c) => designKey(c) === key);
    const list = isPreset ? candidates : [...candidates, { ...scenario, id: "custom", name: labelFor(scenario), preset: null }];
    const my = ++compareSeq.current;
    setComparing(true);
    try {
      const rs = await api.compare(list);
      if (my === compareSeq.current) {
        setCompareResults(rs);
        setCompareKey(key);
        if (errorSource === "compare") {
          setError(null);
          setErrorSource(null);
        }
      }
    } catch (e) {
      if (my === compareSeq.current) fail("compare", (e as Error).message);
    } finally {
      if (my === compareSeq.current) setComparing(false);
    }
  }, [scenario, presets, labelFor, errorSource, fail]);

  const retry = useCallback(() => {
    setPanelEpoch((e) => e + 1);
    if (!presets.length || errorSource === "presets") loadPresets();
    else if (errorSource === "compare") void runCompare();
    else void run();
  }, [presets.length, errorSource, loadPresets, runCompare, run]);

  const selectSite = useCallback(async (p: LngLat) => {
    if (!allowSitePlacement(p)) return; // Griddy is California-only for now (E's guard shows why)
    // A clicked point is a new site: fresh id/name, never the preset's Kern labels.
    // Modules that cache per site should key on location rounded to 0.01 deg, not id.
    const id = `site-${p.lon.toFixed(3)}-${p.lat.toFixed(3)}`;
    setScenario((s) =>
      s
        ? { ...s, site: { id, name: `Site at ${p.lat.toFixed(3)}, ${p.lon.toFixed(3)}`, location: p, balancing_authority: s.site.balancing_authority } }
        : s,
    );
    const summary = await fetchSiteCards(p, id);
    if (!summary) return; // failed, or a newer click won
    // Hand A's grid context to the scenario: B's stress test reads poi_voltage_kv,
    // C costs the tie line from interconnection_km. Industrial scenarios only.
    setScenario((s) =>
      s && s.site.id === id
        ? withLineContext({ ...s, site: { ...s.site, county: summary.site.county, utility_territory: summary.site.utility_territory } }, summary)
        : s,
    );
  }, [fetchSiteCards]);

  const compareStale = useMemo(
    () => compareResults !== null && scenario !== null && compareKey !== designKey(scenario),
    [compareResults, compareKey, scenario],
  );
  const scenarioLabel = useMemo(() => (scenario ? labelFor(scenario) : ""), [scenario, labelFor]);

  const value = useMemo<GridForgeState>(
    () => ({
      presets,
      scenario,
      scenarioLabel,
      projectPlanning,
      setScenario,
      updateScenario,
      applyPreset,
      loadCompared,
      setMode,
      setPeakMw,
      setItLoadMw,
      setPue,
      scaleWithDemand,
      setScaleWithDemand,
      autoRun,
      setAutoRun,
      result,
      resultVersion,
      panelEpoch,
      running,
      runProgress,
      error,
      run,
      runNow,
      retry,
      view,
      setView,
      compareResults,
      compareStale,
      comparing,
      runCompare,
      selectSite,
      siteSummary,
      siteIntel,
      overlays: siteIntel?.overlays ?? [],
    }),
    [
      presets,
      scenario,
      scenarioLabel,
      projectPlanning,
      updateScenario,
      applyPreset,
      loadCompared,
      setMode,
      setPeakMw,
      setItLoadMw,
      setPue,
      scaleWithDemand,
      autoRun,
      result,
      resultVersion,
      panelEpoch,
      running,
      runProgress,
      error,
      run,
      runNow,
      retry,
      view,
      compareResults,
      compareStale,
      comparing,
      runCompare,
      selectSite,
      siteSummary,
      siteIntel,
    ],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useGridForge(): GridForgeState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useGridForge must be used inside <GridForgeProvider>");
  return v;
}
