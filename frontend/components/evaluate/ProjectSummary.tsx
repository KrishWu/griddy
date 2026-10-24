"use client";

import { Panel } from "@/components/shell/Panel";
import { useGridForge } from "@/lib/store";
import { pct, tons, usd } from "@/lib/format";
import type { ScenarioResult } from "@/lib/contract";
import { projectOf, resilienceOf } from "./project";

export function ProjectSummary() {
  const { result } = useGridForge();
  if (!result) return null;
  const { economics: e, emissions: em } = result.evaluation;
  const p = projectOf(result), r = resilienceOf(result), s = result.simulation.summary;
  const served = s.demand_mwh - s.unmet_mwh;
  const issues = result.findings.filter(f => f.severity === "fail" || f.severity === "warn");
  return <Panel title="Project at a glance">
    <p className="mb-3 text-xs text-zinc-500">{result.scenario.name} · simulated design year</p>
    <div className="grid grid-cols-2 gap-3">
      {[
        ["Power delivered, average", `${(p?.production.average_power_served_mw ?? served / result.simulation.hourly.demand_mw.length).toFixed(1)} MW`],
        ["Demand supplied", s.demand_mwh ? pct(served / s.demand_mwh) : "—"],
        ["Upfront capital", usd(e.capex_total_usd)], ["Operating cost / year", usd(e.annual_opex_usd)],
        ["Lifetime energy cost", `$${e.lcoe_usd_per_mwh.toFixed(0)}/MWh`], ["Emissions / year", `${tons(em.annual_t_co2e)} CO₂e`],
      ].map(([label, value]) => <div key={label} className="rounded-lg bg-zinc-50 p-3 dark:bg-zinc-900">
        <p className="text-[11px] text-zinc-500">{label}</p><p className="mt-1 text-lg font-semibold tabular-nums">{value}</p>
      </div>)}
    </div>
    <p className="mt-3 text-xs text-zinc-500">{em.intensity_kg_per_mwh.toFixed(0)} kg CO₂e/MWh · {pct(s.onsite_clean_share)} on-site clean energy</p>
    <div className={`mt-3 rounded border p-2 text-xs ${s.hours_unmet ? "border-red-200 text-red-700 dark:text-red-300" : "border-emerald-200 text-emerald-800 dark:text-emerald-300"}`}>
      <p className="font-semibold">{s.hours_unmet ? `${s.hours_unmet.toLocaleString()} hours with unmet demand` : "Demand met every hour in the simulated year"}</p>
      <p className="mt-1">{issues.length} feasibility warning{issues.length === 1 ? "" : "s"} or failing check{issues.length === 1 ? "" : "s"}. Utility review required.</p>
    </div>
    {r && <div className="mt-3 text-xs">
      <p className="font-semibold">Resilience screening</p>
      <p className="mt-1">{pct(r.critical_energy_served_share)} of critical energy supplied during a {r.outage_hours} h grid outage.</p>
      <p>{r.hours_before_shortfall} h before first shortfall · sustained N-1 coverage {r.n_minus_1_coverage === null ? "—" : pct(r.n_minus_1_coverage)}.</p>
      <p className="mt-1 text-[11px] text-zinc-500">Assumes islanding controls and continuous gas supply. N-1 removes the largest grid tie or gas unit; excludes energy-limited storage.</p>
    </div>}
    <details className="mt-3 text-xs"><summary className="cursor-pointer">Key feasibility findings</summary>
      <ul className="mt-2 space-y-2">{issues.map(f => <li key={`${f.module}-${f.id}`}><span className="font-medium">{f.title}</span><p className="text-zinc-500">{f.detail}</p></li>)}</ul>
    </details>
    <p className="mt-3 text-[10px] text-zinc-500">Source: hourly dispatch with the cited cost and emissions assumptions. Screening estimates; see Advanced mode or the report for sources and all metrics.</p>
  </Panel>;
}

export function ProjectDetails({ result, expanded = false }: { result: ScenarioResult; expanded?: boolean }) {
  const p = projectOf(result), r = resilienceOf(result);
  if (!p) return null;
  const rows: [string, string][] = [
    ["Demand projected", `${p.projection.projected_peak_mw.toFixed(1)} MW peak in ${p.projection.years} years (${pct(p.projection.annual_growth)}/yr)`],
    ["Gross generation / year", `${p.production.gross_generation_mwh.toLocaleString(undefined, { maximumFractionDigits: 0 })} MWh`],
    ["Grid purchases / year", `${p.production.imports_mwh.toLocaleString(undefined, { maximumFractionDigits: 0 })} MWh`],
    ["Construction labor", `${p.jobs.construction_fte_years.toFixed(1)} FTE-years total; ${p.jobs.average_construction_fte.toFixed(1)} average FTE during construction`],
    ["Ongoing operations labor", `${p.jobs.operations_fte.toFixed(1)} FTE / year`],
    ["Local labor estimate", `${p.jobs.local_construction_fte_years.toFixed(1)} construction FTE-years; ${p.jobs.local_operations_fte.toFixed(1)} ongoing FTE`],
    ["Carbon cost in financial model", `${usd(p.carbon.booked_annual_cost_usd)} / yr`],
    ["All-emissions carbon exposure", `${usd(p.carbon.all_emissions_exposure_usd)} / yr`],
    ["Offtake volume assumption", `${p.contracts.annual_volume_mwh.toLocaleString(undefined, { maximumFractionDigits: 0 })} MWh/yr × $${p.contracts.price_usd_per_mwh}/MWh for ${p.contracts.term_years} years`],
    ["Indicative annual offtake value", `${usd(p.contracts.illustrative_annual_value_usd)} / yr`],
  ];
  if (p.area.area_acres !== null) rows.push(
    ["Selected area", `${p.area.area_acres.toFixed(1)} acres (${p.area.area_km2?.toFixed(2)} km²)`],
    ["Land needed / area selected", p.area.land_utilization !== null ? pct(p.area.land_utilization) : "—"],
    ["Project capital / selected acre", p.area.capex_usd_per_acre !== null ? `${usd(p.area.capex_usd_per_acre)} / acre` : "—"],
    ["Project emissions / selected acre", p.area.annual_t_co2e_per_acre !== null ? `${p.area.annual_t_co2e_per_acre.toFixed(2)} t CO₂e/acre/yr` : "—"],
  );
  if (r) rows.push(["Critical load supplied during outage", `${pct(r.critical_energy_served_share)} over ${r.outage_hours} h; ${r.unserved_critical_mwh.toFixed(1)} MWh unserved`],
    ["Sustained N-1 firm supply", `${r.n_minus_1_firm_mw.toFixed(1)} MW (${r.n_minus_1_coverage === null ? "—" : pct(r.n_minus_1_coverage)} of critical peak)`]);
  return <details open={expanded} className="rounded border border-zinc-200 p-3 text-xs dark:border-zinc-800 print:break-inside-avoid">
    <summary className="cursor-pointer font-semibold">Project impact, production &amp; contracts</summary>
    <dl className="mt-3 space-y-2">{rows.map(([label, value]) => <div key={label} className="flex justify-between gap-3"><dt className="text-zinc-500">{label}</dt><dd className="max-w-[60%] text-right tabular-nums">{value}</dd></div>)}</dl>
    {p.area.demographics && <div className="mt-3 rounded bg-zinc-50 p-2 dark:bg-zinc-900">
      <p>Selected-zone residents: {p.area.demographics.population?.toLocaleString() ?? "unavailable"}; estimated households: {p.area.demographics.estimated_households?.toLocaleString(undefined, { maximumFractionDigits: 0 }) ?? "unavailable"}.</p>
      <p>Estimated residential demand: {p.area.demographics.residential_demand_mwh_per_year?.toLocaleString(undefined, { maximumFractionDigits: 0 }) ?? "unavailable"} MWh/yr.</p>
      <p className="mt-1 text-zinc-500">{p.area.demographics.caveat}</p>
    </div>}
    <div className="mt-3 space-y-2 text-[11px] text-zinc-500">
      <p>{p.projection.basis}</p><p>{p.jobs.provenance.note} <a className="underline" href={p.jobs.provenance.url ?? undefined} target="_blank" rel="noreferrer">FTE interpretation</a></p>
      <p>{p.carbon.basis}</p><p>{p.contracts.status}. {p.contracts.basis}</p>
      <p>{p.production.basis}</p><p>{p.area.basis}</p>{r && <p>{r.basis}</p>}
      {p.warnings.map(w => <p key={w} className="text-amber-700">{w}</p>)}
    </div>
  </details>;
}
