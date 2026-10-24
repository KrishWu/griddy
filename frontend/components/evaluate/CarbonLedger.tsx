"use client";

import type { ScenarioResult } from "@/lib/contract";
import { usd } from "@/lib/format";
import { tonsFine } from "./fmt";
import { projectOf } from "./project";
import { ProvenanceTip } from "./ProvenanceTip";

/** One consistent carbon boundary in Basic, Advanced and the printable report. */
export function CarbonLedger({ result, compact = false }: { result: ScenarioResult; compact?: boolean }) {
  const c = projectOf(result)?.carbon;
  // Previously exported/saved results may predate the construction inventory.
  if (!c || c.upfront_t_co2e === undefined) return null;
  return <div className="space-y-2 text-xs">
    <p className="text-zinc-600 dark:text-zinc-400">
      Annual operations: {tonsFine(c.annual_direct_t_co2e)} on-site + {tonsFine(c.annual_imports_t_co2e)} from grid imports
      {c.annual_upstream_t_co2e > 0 ? ` + ${tonsFine(c.annual_upstream_t_co2e)} upstream methane` : ""} CO₂e.
      <ProvenanceTip label="Annual operational emissions" provenance={result.evaluation.emissions.provenance} />
    </p>
    <p className="text-zinc-500">Solar, wind and batteries emit no direct CO₂ during operation. Imports and gas backup can still emit.</p>
    <div className="grid grid-cols-2 gap-2">
      <div className="rounded bg-zinc-50 p-2 dark:bg-zinc-900">
        <p className="text-[11px] text-zinc-500">Upfront carbon, estimate <ProvenanceTip label="Upfront carbon" provenance={c.assets.map(a => a.provenance)} /></p>
        <p className="font-semibold tabular-nums">{tonsFine(c.upfront_t_co2e)} CO₂e</p><p className="text-[10px] text-zinc-500">one-time construction inventory</p>
      </div>
      <div className="rounded bg-zinc-50 p-2 dark:bg-zinc-900">
        <p className="text-[11px] text-zinc-500">Modeled carbon, {c.analysis_years} years <ProvenanceTip label="Cumulative carbon" provenance={[c.provenance]} /></p>
        <p className="font-semibold tabular-nums">{tonsFine(c.modeled_total_t_co2e)} CO₂e</p><p className="text-[10px] text-zinc-500">construction + operations + replacements</p>
      </div>
    </div>
    <p className="text-[11px] text-zinc-500">Partial inventory: grid works, gas-plant construction, maintenance and end of life are not automatically estimated. The cumulative estimate repeats the simulated year.</p>
    <details open={!compact}>
      <summary className="cursor-pointer font-medium">Carbon assumptions &amp; price sensitivity</summary>
      <div className="mt-2 space-y-2">
        <dl className="space-y-1 tabular-nums">
          <div className="flex justify-between gap-2"><dt>Upfront carbon exposure</dt><dd>{usd(c.upfront_exposure_usd)}</dd></div>
          <div className="flex justify-between gap-2"><dt>{c.analysis_years}-year modeled carbon exposure</dt><dd>{usd(c.modeled_total_exposure_usd)}</dd></div>
          <div className="flex justify-between gap-2"><dt>Replacement carbon over horizon</dt><dd>{tonsFine(c.replacement_t_co2e)} CO₂e</dd></div>
        </dl>
        <p className="text-zinc-500">At ${c.carbon_price_usd_per_t.toLocaleString()}/t CO₂e. These are undiscounted sensitivities, separate from booked CAPEX/OPEX; they do not imply a tax or allowance obligation. Edit factors and price under Plan → Upfront carbon.</p>
        <ul className="space-y-2">{c.assets.map(a => <li key={a.asset_id}>
          <p>{a.kind.replaceAll("_", " ")} ({a.asset_id}): {tonsFine(a.upfront_t_co2e)} CO₂e upfront <ProvenanceTip label={`${a.asset_id} carbon estimate`} provenance={[a.provenance]} /></p>
          <p className="text-[10px] text-zinc-500">{a.quantity.toLocaleString(undefined, { maximumFractionDigits: 2 })} {a.quantity_unit} × {a.factor.toLocaleString(undefined, { maximumFractionDigits: 2 })} {a.factor_unit}; {a.replacement_count} full replacements.</p>
        </li>)}</ul>
        {c.other_upfront_t_co2e > 0 && <p>Other entered construction carbon: {tonsFine(c.other_upfront_t_co2e)} CO₂e.</p>}
        {c.unmodeled_asset_ids.length > 0 && <p className="text-zinc-500">Assets without an automatic construction estimate: {c.unmodeled_asset_ids.join(", ")}.</p>}
        <p className="text-[10px] text-zinc-500">{c.basis}</p>
      </div>
    </details>
  </div>;
}
