"use client";
// App-wide state: the scenario being edited, the latest results, and the selected
// site.  OWNER: workstream D. Other workstreams: ask D for new shared state and keep
// everything else in local component state. Panels read/write through useGridForge().
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

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
  const latestSiteId = useRef<string | null>(null);
  const runSeq = useRef(0);

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
    // Only the newest run may write state, so a slow older run (e.g. from a debounced
    // auto-run) can't overwrite a newer result.
    const my = ++runSeq.current;
    setRunning(true);
    setError(null);
    try {
      const r = await api.run(scenario);
      if (my === runSeq.current) setResult(r);
    } catch (e) {
      if (my === runSeq.current) setError((e as Error).message);
    } finally {
      if (my === runSeq.current) setRunning(false);
    }
  }, [scenario]);

  const updateScenario = useCallback((fn: (s: Scenario) => Scenario) => setScenario((s) => (s ? fn(s) : s)), []);

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
