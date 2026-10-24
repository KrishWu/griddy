"use client";

import { useEffect, useState } from "react";
import { Panel } from "@/components/shell/Panel";
import { NumberField } from "@/components/builder/NumberField";
import { Term } from "@/components/glossary/Term";
import type { AreaStats } from "@/components/evaluate/project";
import { post } from "@/lib/api";
import { useAreaTools } from "./areaTools";
import { useGridForge } from "@/lib/store";

export function AreaPanel() {
  const { scenario, updateScenario, view } = useGridForge();
  const { setHost } = useAreaTools();
  const footprint = scenario?.site.footprint;
  const inputs = scenario?.options?.area as Record<string, number> | undefined;
  const persons = inputs?.persons_per_household ?? 2.9;
  const kwh = inputs?.household_kwh_per_year ?? 6500;
  const lf = inputs?.load_factor ?? 0.55;
  const body = JSON.stringify({ footprint, persons_per_household: persons, household_kwh_per_year: kwh, load_factor: lf });
  const [response, setResponse] = useState<{ key: string; stats?: AreaStats; error?: string } | null>(null);
  useEffect(() => {
    if (!footprint) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      post<AreaStats>("/explore/area", JSON.parse(body)).then(
        stats => { if (!cancelled) setResponse({ key: body, stats }); },
        e => { if (!cancelled) setResponse({ key: body, error: (e as Error).message }); },
      );
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [body, footprint]);
  const current = response?.key === body ? response : null;
  const stats = current?.stats;
  const set = (key: string, v: number) => updateScenario(s => ({ ...s, options: { ...s.options, area: { ...s.options?.area as object, [key]: v } } }));
  return <Panel title="People & demand in selected area">
    <div ref={setHost} className="mb-3" />
    {view === "compare" && <p className="mb-2 text-xs text-zinc-500">Open Single view to highlight an area.</p>}
    {!footprint ? <p className="text-xs text-zinc-500">Highlight an area to estimate its residents and electricity demand.</p> : <div className="space-y-2 text-xs">
      {current?.error && <p role="alert" className="text-red-600">{current.error}</p>}
      {!current && <p className="text-zinc-500">Estimating selected area…</p>}
      {stats && <>
        <p className="text-zinc-500">{stats.area_km2.toFixed(2)} km² selected · {stats.coverage}</p>
        <div className="grid grid-cols-2 gap-2">{[
          ["Residents in zone", stats.population?.toLocaleString() ?? "Unavailable"],
          ["Estimated households", stats.estimated_households?.toLocaleString(undefined, { maximumFractionDigits: 0 }) ?? "Unavailable"],
          ["Residential demand / year", stats.residential_demand_mwh_per_year === null ? "Unavailable" : `${stats.residential_demand_mwh_per_year.toLocaleString(undefined, { maximumFractionDigits: 0 })} MWh`],
          ["Estimated peak demand", stats.estimated_residential_peak_mw === null ? "Unavailable" : `${stats.estimated_residential_peak_mw.toFixed(2)} MW`, "peak_demand"],
        ].map(([label, value, term]) => <div key={label} className="rounded bg-zinc-50 p-2 dark:bg-zinc-900"><p className="text-[10px] text-zinc-500">{term === "peak_demand" ? <>Estimated <Term k="peak_demand">peak demand</Term></> : label}</p><p className="mt-1 font-semibold tabular-nums">{value}</p></div>)}</div>
        <p className="text-[10px] text-zinc-500">{stats.caveat}</p>
        <button disabled={!stats.estimated_residential_peak_mw} className="rounded border border-emerald-500 px-2 py-1.5 font-medium text-emerald-800 disabled:opacity-40 dark:text-emerald-300"
          onClick={() => updateScenario(s => ({ ...s, preset: null, mode: "community", name: "Selected area community project",
            demand: { ...s.demand, kind: "community", profile: "community", pue: 1, peak_mw: stats.estimated_residential_peak_mw!, load_factor: lf },
          }))}>Use zone’s residential demand</button>
      </>}
      <details><summary className="cursor-pointer">Household &amp; demand assumptions</summary><div className="mt-2 space-y-2">
        <NumberField label="People per household" value={persons} min={1} max={10} step={0.1} onChange={v => set("persons_per_household", v)} />
        <NumberField label="Electricity per household" unit="kWh / yr" value={kwh} min={1} max={100000} step={100} onChange={v => set("household_kwh_per_year", v)} />
        <NumberField label={<>Residential <Term k="load_factor">load factor</Term></>} value={lf} min={0.01} max={1} step={0.01} onChange={v => set("load_factor", v)} />
      </div></details>
      <button className="text-zinc-500 underline" onClick={() => updateScenario(s => ({ ...s, site: { ...s.site, footprint: null } }))}>Clear selected area</button>
    </div>}
  </Panel>;
}
