"use client";
// App-wide state: the scenario being edited, the latest results, and the selected
// site.  OWNER: workstream D. Other workstreams: ask D for new shared state and keep
// everything else in local component state. Panels read/write through useGridForge().
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { api } from "./api";
import type { LngLat, MapOverlay, Mode, Scenario, ScenarioResult, SiteIntel, SiteSummary } from "./contract";

export type View = "single" | "compare";

interface GridForgeState {
  presets: Scenario[];
  scenario: Scenario | null;
  setScenario: (s: Scenario) => void;
  updateScenario: (fn: (s: Scenario) => Scenario) => void;
  /** Load a preset, keeping the current site, its grid context, and assumption edits. */
  applyPreset: (id: string) => void;
  /** Switch Industrial / Community: loads the first preset of that mode. */
  setMode: (mode: Mode) => void;
  /** Change peak demand; rescales assets and grid limits when scaleWithDemand is on. */
  setPeakMw: (peakMw: number) => void;
  scaleWithDemand: boolean;
  setScaleWithDemand: (on: boolean) => void;
  autoRun: boolean;
  setAutoRun: (on: boolean) => void;
  result: ScenarioResult | null;
  /** Increments with every new result; AppShell keys panel error boundaries on it. */
  resultVersion: number;
  running: boolean;
  error: string | null;
  run: () => Promise<void>;
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
  };
  if (scale && sameMode && p.demand.peak_mw > 0 && cur.demand.peak_mw !== p.demand.peak_mw) {
    next = scaleScenario({ ...next, demand: { ...next.demand, peak_mw: cur.demand.peak_mw } }, cur.demand.peak_mw / p.demand.peak_mw);
  }
  return next;
}

/** Identity of a design for "did anything change?" checks (ignores ids and names). */
function designKey(s: Scenario): string {
  const r = (x: number | null | undefined) => Math.round((x ?? 0) * 10) / 10;
  return JSON.stringify({
    mode: s.mode ?? "industrial",
    site: [r(s.site.location.lon * 1000), r(s.site.location.lat * 1000)],
    demand: [r(s.demand.peak_mw), s.demand.load_factor, s.demand.pue, s.demand.profile, s.demand.flexible_share],
    assets: s.assets.map((a) => [a.kind, r(a.capacity_mw), r(a.duration_h)]).sort(),
    grid: [r(s.grid.import_limit_mw), r(s.grid.export_limit_mw), r(s.grid.interconnection_km), r(s.grid.poi_voltage_kv)],
    assumptions: s.assumptions ?? {},
  });
}

export function GridForgeProvider({ children }: { children: ReactNode }) {
  const [presets, setPresets] = useState<Scenario[]>([]);
  const [scenario, setScenario] = useState<Scenario | null>(null);
  const [result, setResult] = useState<ScenarioResult | null>(null);
  const [resultVersion, setResultVersion] = useState(0);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
  const compareSeq = useRef(0);

  useEffect(() => {
    api
      .presets()
      .then((ps) => {
        setPresets(ps);
        setScenario((cur) => cur ?? ps.find((p) => p.id === "hybrid") ?? ps[0] ?? null);
      })
      .catch((e: Error) => setError(`Could not load presets (is the backend running?): ${e.message}`));
  }, []);

  const run = useCallback(async () => {
    if (!scenario) return;
    // Only the newest run may write state, so a slow older run (e.g. from a debounced
    // auto-run) can't overwrite a newer result.
    const my = ++runSeq.current;
    setRunning(true);
    setError(null);
    try {
      const r = await api.run(scenario);
      if (my === runSeq.current) {
        setResult(r);
        setResultVersion((v) => v + 1);
      }
    } catch (e) {
      if (my === runSeq.current) setError((e as Error).message);
    } finally {
      if (my === runSeq.current) setRunning(false);
    }
  }, [scenario]);

  // Debounced auto-run: any scenario edit re-runs half a second after the last change.
  useEffect(() => {
    if (!autoRun || !scenario) return;
    const t = setTimeout(() => void run(), 500);
    return () => clearTimeout(t);
  }, [run, autoRun, scenario]);

  const updateScenario = useCallback((fn: (s: Scenario) => Scenario) => setScenario((s) => (s ? fn(s) : s)), []);

  const applyPreset = useCallback(
    (id: string) => {
      const p = presets.find((x) => x.id === id);
      if (p) setScenario((cur) => adaptPreset(p, cur, scaleWithDemand));
    },
    [presets, scaleWithDemand],
  );

  const setMode = useCallback(
    (mode: Mode) => {
      const p = presets.find((x) => (x.mode ?? "industrial") === mode);
      if (p) setScenario((cur) => adaptPreset(p, cur, false));
    },
    [presets],
  );

  const setPeakMw = useCallback(
    (peakMw: number) =>
      setScenario((s) => {
        if (!s) return s;
        const next = { ...s, demand: { ...s.demand, peak_mw: peakMw } };
        return scaleWithDemand && s.demand.peak_mw > 0 ? scaleScenario(next, peakMw / s.demand.peak_mw) : next;
      }),
    [scaleWithDemand],
  );

  const runCompare = useCallback(async () => {
    if (!scenario) return;
    const mode = scenario.mode ?? "industrial";
    const candidates = presets.filter((p) => (p.mode ?? "industrial") === mode).map((p) => adaptPreset(p, scenario, scaleWithDemand));
    const key = designKey(scenario);
    const isPreset = candidates.some((c) => designKey(c) === key);
    const list = isPreset ? candidates : [...candidates, { ...scenario, id: "custom", name: "Your scenario", preset: null }];
    const my = ++compareSeq.current;
    setComparing(true);
    try {
      const rs = await api.compare(list);
      if (my === compareSeq.current) {
        setCompareResults(rs);
        setCompareKey(key);
      }
    } catch (e) {
      if (my === compareSeq.current) setError((e as Error).message);
    } finally {
      if (my === compareSeq.current) setComparing(false);
    }
  }, [scenario, presets, scaleWithDemand]);

  const selectSite = useCallback(async (p: LngLat) => {
    // A clicked point is a new site: fresh id/name, never the preset's Kern labels.
    // Modules that cache per site should key on location rounded to 0.01 deg, not id.
    const id = `site-${p.lon.toFixed(3)}-${p.lat.toFixed(3)}`;
    latestSiteId.current = id;
    setScenario((s) =>
      s
        ? { ...s, site: { id, name: `Site at ${p.lat.toFixed(3)}, ${p.lon.toFixed(3)}`, location: p, balancing_authority: s.site.balancing_authority } }
        : s,
    );
    setSiteSummary(null);
    setSiteIntel(null);
    const [summary, intel] = await Promise.allSettled([api.siteSummary(p), api.siteIntel(p)]);
    if (latestSiteId.current !== id) return; // a newer click won; drop stale responses
    if (summary.status === "fulfilled") {
      const { site, nearest_line_kv, nearest_line_km } = summary.value;
      setSiteSummary(summary.value);
      // Hand A's grid context to the scenario: B's stress test reads poi_voltage_kv,
      // C costs the tie line from interconnection_km.
      setScenario((s) =>
        s && s.site.id === id
          ? {
              ...s,
              site: { ...s.site, county: site.county, utility_territory: site.utility_territory },
              grid: {
                ...s.grid,
                poi_voltage_kv: nearest_line_kv ?? s.grid.poi_voltage_kv,
                interconnection_km: nearest_line_km ?? s.grid.interconnection_km,
              },
            }
          : s,
      );
    }
    setSiteIntel(intel.status === "fulfilled" ? intel.value : null);
  }, []);

  const compareStale = useMemo(
    () => compareResults !== null && scenario !== null && compareKey !== designKey(scenario),
    [compareResults, compareKey, scenario],
  );

  const value = useMemo<GridForgeState>(
    () => ({
      presets,
      scenario,
      setScenario,
      updateScenario,
      applyPreset,
      setMode,
      setPeakMw,
      scaleWithDemand,
      setScaleWithDemand,
      autoRun,
      setAutoRun,
      result,
      resultVersion,
      running,
      error,
      run,
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
      updateScenario,
      applyPreset,
      setMode,
      setPeakMw,
      scaleWithDemand,
      autoRun,
      result,
      resultVersion,
      running,
      error,
      run,
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
