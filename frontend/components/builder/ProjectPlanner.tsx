"use client";

import { Term } from "@/components/glossary/Term";
import { Panel } from "@/components/shell/Panel";
import type { PlanningInputs } from "./useProjectPlanning";
import { useGridForge } from "@/lib/store";
import { NumberField } from "./NumberField";

export function ProjectPlanner() {
  const { scenario, updateScenario, presets, applyPreset, runNow, running, autoRun, projectPlanning } = useGridForge();
  const { inputs, updateInputs, busy, error, plan: proposal, retry } = projectPlanning;
  const plant = inputs.plant_type;
  const share = inputs.renewable_energy_share * 100;
  const storage = inputs.storage_hours;
  const reserve = inputs.reserve_margin * 100;
  const setPlant = (value: string) => updateInputs({ plant_type: value as PlanningInputs["plant_type"] });
  const setShare = (value: number) => updateInputs({ renewable_energy_share: value / 100 });
  const setStorage = (value: number) => updateInputs({ storage_hours: value });
  const setReserve = (value: number) => updateInputs({ reserve_margin: value / 100 });
  if (!scenario) return <Panel title="Plan grid infrastructure">Loading…</Panel>;
  const options = (scenario.options?.project ?? {}) as Record<string, number | null>;
  const field = (key: string, fallback: number) => options[key] ?? fallback;
  const set = (key: string, value: number | null) => updateScenario(s => ({ ...s, options: { ...s.options, project: { ...s.options?.project as object, [key]: value } } }));
  const projected = proposal?.projection;
  return <Panel title="Plan grid infrastructure">
    <div className="space-y-3">
      {scenario.mode === "community"
        ? <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-2.5 dark:border-emerald-900 dark:bg-emerald-950/40">
            <p className="text-sm font-semibold leading-snug text-zinc-900 dark:text-zinc-50">Plan a community microgrid that keeps critical loads on in a grid outage and lowers bills and carbon.</p>
            <p className="mt-1 text-xs leading-snug text-zinc-600 dark:text-zinc-300">It uses the same hour-by-hour model Griddy runs for AI campuses, whose fast-growing demand is straining the grid. The Summary shows homes powered, outage protection, cost per home and payback, each with its source.</p>
          </div>
        : <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-2.5 dark:border-emerald-900 dark:bg-emerald-950/40">
            <p className="text-sm font-semibold leading-snug text-zinc-900 dark:text-zinc-50">Plan power for a big new load like a 1 GW AI campus: where to build, what to build, what it costs, and when it pays back.</p>
            <p className="mt-1 text-xs leading-snug text-zinc-600 dark:text-zinc-300">Plan power plants, storage and a grid connection for the demand, then compare cost, payback, carbon and resilience before detailed engineering.</p>
          </div>}
      <label className="block text-xs">Start from a design
        <select className="mt-1 w-full rounded border border-zinc-300 bg-transparent p-1.5 dark:border-zinc-700" value={scenario.preset ?? "custom"} onChange={e => applyPreset(e.target.value)}>
          <option value="custom">Custom project</option>
          {presets.filter(p => p.mode === scenario.mode).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </label>
      <NumberField label={<><Term k="peak_demand">Peak demand</Term> to serve</>} unit="MW" value={scenario.demand.peak_mw} min={0.01} max={20000} step={1}
        onChange={v => updateScenario(s => ({ ...s, demand: { ...s.demand, peak_mw: v } }))} />
      <NumberField label={<Term k="load_factor">Load factor</Term>} value={scenario.demand.load_factor ?? 0.9} min={0.01} max={1} step={0.01}
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
      <p className="text-[11px] text-zinc-500">This design serves the entered load with generation, storage and grid imports. Solar or wind + storage adds no gas plant; the hybrid option includes gas backup. Data-center profiles are optional under Build.</p>
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
          <NumberField label="Construction duration" unit="years" value={field("construction_years", 2)} min={0.25} max={10} step={0.25} onChange={v => set("construction_years", v)} />
          <NumberField label={<><Term k="capex">CAPEX</Term> paid as labor</>} unit="%" value={field("construction_labor_share", 0.2) * 100} max={100} onChange={v => set("construction_labor_share", v / 100)} />
          <NumberField label={<><Term k="om">O&amp;M</Term> paid as labor</>} unit="%" value={field("operations_labor_share", 0.35) * 100} max={100} onChange={v => set("operations_labor_share", v / 100)} />
          <NumberField label="Annual compensation" unit="USD / FTE" value={field("annual_compensation_usd", 120000)} min={10000} max={1000000} step={1000} onChange={v => set("annual_compensation_usd", v)} />
          <NumberField label="Local labor share" unit="%" value={field("local_labor_share", 0.6) * 100} max={100} onChange={v => set("local_labor_share", v / 100)} />
          <NumberField label="Illustrative offtake share" unit="%" value={field("contracted_share", 0) * 100} max={100} onChange={v => set("contracted_share", v / 100)} />
          <NumberField label="Illustrative offtake price" unit="USD / MWh" value={field("contract_price_usd_per_mwh", 80)} max={1000} onChange={v => set("contract_price_usd_per_mwh", v)} />
          <NumberField label="Illustrative contract term" unit="years" value={field("contract_years", 10)} min={1} max={40} onChange={v => set("contract_years", Math.round(v))} />
          <p className="text-zinc-500">Jobs and contracts are illustrative estimates.</p>
        </div>
      </details>
      <details className="text-xs">
        <summary className="cursor-pointer font-medium">Upfront carbon &amp; carbon price</summary>
        <div className="mt-2 space-y-2">
          <p className="text-zinc-500">Construction estimates are separate from yearly emissions. Defaults are reference footprints, not supplier-specific assessments; open the carbon sources in the results for their basis.</p>
          <NumberField label="Solar manufacturing + installation" unit="kg CO₂e / kW DC" value={field("solar_upfront_kg_per_kwdc", 1007)} max={100000} onChange={v => set("solar_upfront_kg_per_kwdc", v)} />
          <NumberField label="Wind construction reference" unit="kg CO₂e / kW" value={field("wind_upfront_kg_per_kw", 674.52)} max={100000} onChange={v => set("wind_upfront_kg_per_kw", v)} />
          <NumberField label="Battery construction reference" unit="kg CO₂e / kWh capacity" value={field("battery_upfront_kg_per_kwh", 172.7218530063873)} max={100000} onChange={v => set("battery_upfront_kg_per_kwh", v)} />
          <NumberField label="Other known upfront carbon" unit="t CO₂e" value={field("other_upfront_t_co2e", 0)} max={1e10} onChange={v => set("other_upfront_t_co2e", v)} />
          <p className="text-zinc-500">Use other carbon for known gas-plant, grid, civil works or other construction not covered by the reference factors.</p>
          <NumberField label={<><Term k="carbon_price">Carbon price</Term> sensitivity</>} unit="USD / t CO₂e" value={scenario.assumptions?.carbon_price_usd_per_t ?? 0} max={1000} onChange={v => updateScenario(s => ({ ...s, assumptions: { ...s.assumptions, carbon_price_usd_per_t: v } }))} />
          <NumberField label="Carbon & cost analysis horizon" unit="years" value={scenario.assumptions?.analysis_years ?? 20} min={1} max={100} onChange={v => updateScenario(s => ({ ...s, assumptions: { ...s.assumptions, analysis_years: Math.round(v) } }))} />
        </div>
      </details>
      {busy && <p role="status" aria-live="polite" className="text-xs text-zinc-500">Recalculating project…</p>}
      {error && <div role="alert" className="text-xs text-red-600"><p>Could not recalculate the project.</p><button onClick={retry} className="mt-1 underline">Retry</button></div>}
      {proposal && projected && <div className="space-y-2 rounded border border-emerald-200 bg-emerald-50/40 p-2 text-xs dark:border-emerald-900 dark:bg-emerald-950/20">
        <p className="font-semibold">Year {projected.years}: {projected.peak_mw.toLocaleString(undefined, { maximumFractionDigits: 1 })} MW projected peak</p>
        <p>${(projected.capex_usd / 1e6).toFixed(1)}M capital · ${projected.lcoe_usd_per_mwh.toFixed(0)}/MWh · {(projected.annual_t_co2e / 1000).toFixed(1)} kt operational CO₂e/yr</p>
        <p>{projected.unmet_hours.toLocaleString()} hours unmet at projected demand</p>
        {proposal.scenario.assets.map(a => <p key={a.id}>{a.kind.replaceAll("_", " ")}: {a.capacity_mw.toFixed(1)} MW{a.kind === "battery" ? ` × ${a.duration_h} h` : ""}</p>)}
        {proposal.screening.issues.map(issue => <p key={issue} className="text-amber-800 dark:text-amber-300">{issue}</p>)}
        <p className="text-zinc-500">This preliminary design needs utility review.</p>
      </div>}
      {!autoRun && <button disabled={running || busy} className="w-full rounded border px-3 py-1.5 text-sm" onClick={() => void runNow()}>Run current design</button>}
    </div>
  </Panel>;
}
