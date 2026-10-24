"use client";

import { useState } from "react";
import { Panel } from "@/components/shell/Panel";
import { post } from "@/lib/api";
import type { Scenario } from "@/lib/contract";
import { useGridForge } from "@/lib/store";
import { NumberField } from "./NumberField";

interface Plan {
  scenario: Scenario;
  projection: { years: number; peak_mw: number; unmet_hours: number; capex_usd: number; annual_t_co2e: number; lcoe_usd_per_mwh: number };
  screening: { meets_entered_checks: boolean; issues: string[]; basis: string };
}

export function ProjectPlanner() {
  const { scenario, setScenario, updateScenario, presets, applyPreset, runNow, running, autoRun } = useGridForge();
  const [plant, setPlant] = useState("hybrid");
  const [share, setShare] = useState(70);
  const [storage, setStorage] = useState(4);
  const [reserve, setReserve] = useState(15);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [proposal, setProposal] = useState<{ plan: Plan; key: string } | null>(null);
  if (!scenario) return <Panel title="Plan a project">Loading…</Panel>;
  const options = (scenario.options?.project ?? {}) as Record<string, number | null>;
  const field = (key: string, fallback: number) => options[key] ?? fallback;
  const set = (key: string, value: number | null) => updateScenario(s => ({ ...s, options: { ...s.options, project: { ...s.options?.project as object, [key]: value } } }));
  const body = { scenario, plant_type: plant, renewable_energy_share: share / 100, storage_hours: storage, reserve_margin: reserve / 100, project: options };
  const key = JSON.stringify(body);
  const stale = proposal?.key !== key;
  const design = async () => {
    setBusy(true); setError(null);
    try { setProposal({ plan: await post<Plan>("/projects/plan", body), key }); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const projected = proposal?.plan.projection;
  return <Panel title="Plan a project">
    <div className="space-y-3">
      <p className="text-xs text-zinc-500">Choose a site or highlight an area on the map, then size a plant for your demand.</p>
      <label className="block text-xs">Start from a design
        <select className="mt-1 w-full rounded border border-zinc-300 bg-transparent p-1.5 dark:border-zinc-700" value={scenario.preset ?? "custom"} onChange={e => applyPreset(e.target.value)}>
          <option value="custom">Custom project</option>
          {presets.filter(p => p.mode === scenario.mode).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </label>
      <NumberField label="Facility peak demand" unit="MW" value={scenario.demand.peak_mw} min={0.01} max={20000} step={1}
        onChange={v => updateScenario(s => ({ ...s, demand: { ...s.demand, peak_mw: v } }))} />
      <NumberField label="Load factor" value={scenario.demand.load_factor ?? 0.9} min={0.01} max={1} step={0.01}
        onChange={v => updateScenario(s => ({ ...s, demand: { ...s.demand, load_factor: v } }))} />
      <label className="block text-xs">Plant type
        <select className="mt-1 w-full rounded border border-zinc-300 bg-transparent p-1.5 dark:border-zinc-700" value={plant} onChange={e => setPlant(e.target.value)}>
          <option value="hybrid">Hybrid solar + wind + storage + gas</option>
          <option value="solar_storage">Solar + storage</option>
          <option value="wind_storage">Wind + storage</option>
          <option value="gas_cc">Combined-cycle gas</option>
          <option value="gas_ct">Gas peaker</option>
        </select>
      </label>
      <div className="grid grid-cols-2 gap-2">
        <NumberField label="Demand growth" unit="% / yr" value={field("annual_demand_growth", 0.02) * 100} min={0} max={30} step={0.5} onChange={v => set("annual_demand_growth", v / 100)} />
        <NumberField label="Plan ahead" unit="years" value={field("projection_years", 5)} min={0} max={30} onChange={v => set("projection_years", Math.round(v))} />
      </div>
      <details className="text-xs">
        <summary className="cursor-pointer font-medium">Sizing, jobs &amp; contract assumptions</summary>
        <div className="mt-2 space-y-2">
          <NumberField label="Renewable gross energy target" unit="%" value={share} max={100} onChange={setShare} />
          <NumberField label="Battery duration" unit="hours" value={storage} min={0.5} max={48} step={0.5} onChange={setStorage} />
          <NumberField label="Firm reserve target" unit="%" value={reserve} max={100} onChange={setReserve} />
          <NumberField label="Capital budget (0 = no limit)" unit="million USD" value={field("budget_usd", 0) / 1e6} max={100000} onChange={v => set("budget_usd", v ? v * 1e6 : null)} />
          <NumberField label="Critical load" unit="%" value={field("critical_load_share", 1) * 100} min={1} max={100} onChange={v => set("critical_load_share", v / 100)} />
          <NumberField label="Grid outage" unit="hours" value={field("outage_hours", 24)} min={1} max={168} onChange={v => set("outage_hours", Math.round(v))} />
          <NumberField label="Carbon price sensitivity" unit="USD / t CO₂e" value={scenario.assumptions?.carbon_price_usd_per_t ?? 0} max={1000} onChange={v => updateScenario(s => ({ ...s, assumptions: { ...s.assumptions, carbon_price_usd_per_t: v } }))} />
          <NumberField label="Construction duration" unit="years" value={field("construction_years", 2)} min={0.25} max={10} step={0.25} onChange={v => set("construction_years", v)} />
          <NumberField label="CAPEX paid as labor" unit="%" value={field("construction_labor_share", 0.2) * 100} max={100} onChange={v => set("construction_labor_share", v / 100)} />
          <NumberField label="O&M paid as labor" unit="%" value={field("operations_labor_share", 0.35) * 100} max={100} onChange={v => set("operations_labor_share", v / 100)} />
          <NumberField label="Annual compensation" unit="USD / FTE" value={field("annual_compensation_usd", 120000)} min={10000} max={1000000} step={1000} onChange={v => set("annual_compensation_usd", v)} />
          <NumberField label="Local labor share" unit="%" value={field("local_labor_share", 0.6) * 100} max={100} onChange={v => set("local_labor_share", v / 100)} />
          <NumberField label="Illustrative offtake share" unit="%" value={field("contracted_share", 0) * 100} max={100} onChange={v => set("contracted_share", v / 100)} />
          <NumberField label="Illustrative offtake price" unit="USD / MWh" value={field("contract_price_usd_per_mwh", 80)} max={1000} onChange={v => set("contract_price_usd_per_mwh", v)} />
          <NumberField label="Illustrative contract term" unit="years" value={field("contract_years", 10)} min={1} max={40} onChange={v => set("contract_years", Math.round(v))} />
          <p className="text-zinc-500">Jobs use illustrative labor-spending assumptions. Contract value is indicative and does not reduce owner costs.</p>
        </div>
      </details>
      <button disabled={busy} onClick={() => void design()} className="w-full rounded bg-emerald-700 px-3 py-2 text-sm font-medium text-white disabled:opacity-50">{busy ? "Checking projected demand…" : "Size plant for demand"}</button>
      {error && <p role="alert" className="break-words text-xs text-red-600">{error}</p>}
      {proposal && projected && <div className="space-y-2 rounded border border-emerald-200 bg-emerald-50/40 p-2 text-xs dark:border-emerald-900 dark:bg-emerald-950/20">
        <p className="font-semibold">Year {projected.years}: {projected.peak_mw.toLocaleString(undefined, { maximumFractionDigits: 1 })} MW projected peak</p>
        <p>${(projected.capex_usd / 1e6).toFixed(1)}M capital · ${projected.lcoe_usd_per_mwh.toFixed(0)}/MWh · {(projected.annual_t_co2e / 1000).toFixed(1)} kt CO₂e/yr</p>
        <p>{projected.unmet_hours.toLocaleString()} hours unmet at projected demand</p>
        {proposal.plan.scenario.assets.map(a => <p key={a.id}>{a.kind.replaceAll("_", " ")}: {a.capacity_mw.toFixed(1)} MW{a.kind === "battery" ? ` × ${a.duration_h} h` : ""}</p>)}
        {proposal.plan.screening.issues.map(issue => <p key={issue} className="text-amber-800 dark:text-amber-300">{issue}</p>)}
        <p className="text-zinc-500">{proposal.plan.screening.basis} Utility review required.</p>
        <button disabled={stale} onClick={() => { setScenario(proposal.plan.scenario); setProposal(null); }} className="rounded bg-zinc-900 px-3 py-1.5 text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-black">{stale ? "Inputs changed — size again" : "Use this design"}</button>
      </div>}
      {!autoRun && <button disabled={running} className="w-full rounded border px-3 py-1.5 text-sm" onClick={() => void runNow()}>Run current design</button>}
    </div>
  </Panel>;
}
