"use client";
// App-wide state: the scenario being edited, the latest results, and the selected
// site. SHARED (foundation). Panels read/write through useGridForge(); add new
// fields here only if more than one workstream needs them.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { api } from "./api";
import type { LngLat, MapOverlay, Scenario, ScenarioResult, SiteIntel, SiteSummary } from "./contract";

interface GridForgeState {
  presets: Scenario[];
  scenario: Scenario | null;
  setScenario: (s: Scenario) => void;
  updateScenario: (fn: (s: Scenario) => Scenario) => void;
  result: ScenarioResult | null;
  running: boolean;
  error: string | null;
  run: () => Promise<void>;
  selectSite: (p: LngLat) => Promise<void>;
  siteSummary: SiteSummary | null;
  siteIntel: SiteIntel | null;
  overlays: MapOverlay[];
}

const Ctx = createContext<GridForgeState | null>(null);

export function GridForgeProvider({ children }: { children: ReactNode }) {
  const [presets, setPresets] = useState<Scenario[]>([]);
  const [scenario, setScenario] = useState<Scenario | null>(null);
  const [result, setResult] = useState<ScenarioResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [siteSummary, setSiteSummary] = useState<SiteSummary | null>(null);
  const [siteIntel, setSiteIntel] = useState<SiteIntel | null>(null);

  useEffect(() => {
    api
      .presets()
      .then((ps) => {
        setPresets(ps);
        setScenario((cur) => cur ?? ps.find((p) => p.id === "hybrid") ?? ps[0] ?? null);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  const run = useCallback(async () => {
    if (!scenario) return;
    setRunning(true);
    setError(null);
    try {
      setResult(await api.run(scenario));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  }, [scenario]);

  const updateScenario = useCallback((fn: (s: Scenario) => Scenario) => setScenario((s) => (s ? fn(s) : s)), []);

  const selectSite = useCallback(async (p: LngLat) => {
    setScenario((s) => (s ? { ...s, site: { ...s.site, location: p } } : s));
    const [summary, intel] = await Promise.allSettled([api.siteSummary(p), api.siteIntel(p)]);
    setSiteSummary(summary.status === "fulfilled" ? summary.value : null);
    setSiteIntel(intel.status === "fulfilled" ? intel.value : null);
  }, []);

  const value = useMemo<GridForgeState>(
    () => ({
      presets,
      scenario,
      setScenario,
      updateScenario,
      result,
      running,
      error,
      run,
      selectSite,
      siteSummary,
      siteIntel,
      overlays: siteIntel?.overlays ?? [],
    }),
    [presets, scenario, updateScenario, result, running, error, run, selectSite, siteSummary, siteIntel],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useGridForge(): GridForgeState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useGridForge must be used inside <GridForgeProvider>");
  return v;
}
