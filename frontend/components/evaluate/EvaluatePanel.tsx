"use client";
// Costs + emissions.  OWNER: workstream C (Evaluate).
// Headline stats (each with a provenance marker), NPC waterfall, emissions breakdown,
// 24/7 CFE card, collapsible cost lines / BOM / methodology. Everything beyond the
// contract fields comes from EvaluationResult.extras via evalExtras(); when extras are
// missing (older backend) the panel degrades to the headline stats + cost-line table.
import type { ReactNode } from "react";

import { Term } from "@/components/glossary/Term";
import { Panel } from "@/components/shell/Panel";
import type { Provenance, ScenarioResult } from "@/lib/contract";
import { pct, tons, usd } from "@/lib/format";
import type { GlossaryKey } from "@/lib/glossary";
import { useGridForge } from "@/lib/store";

import { BomTable } from "./BomTable";
import { CfeCard } from "./CfeCard";
import { CostLinesTable } from "./CostLinesTable";
import { CostWaterfall } from "./CostWaterfall";
import { Disclosure } from "./Disclosure";
import { EmissionsBreakdown } from "./EmissionsBreakdown";
import { assumptionsOf, evalExtras, headlineProvenance, landAcres, landAcresDirect, servedMwh } from "./extras";
import { acres, DASH, finite, perMwh } from "./fmt";
import { Methodology } from "./Methodology";
import { ProvenanceTip } from "./ProvenanceTip";
import { StatTip } from "./StatTip";

export function EvaluatePanel() {
  const { result } = useGridForge();
  if (!result) return null;
  return <EvaluateBody result={result} />;
}

const pctRate = (r: number) => `${(r * 100).toFixed(1).replace(/\.0$/, "")}%`;

function Input({ label, children, provenance, term }: { label: string; children: ReactNode; provenance?: Provenance[]; term?: GlossaryKey }) {
  return (
    <div className="flex items-baseline justify-between gap-2 border-t border-zinc-100 py-1 first:border-t-0 dark:border-zinc-800">
      <dt className="flex items-center gap-1 text-zinc-500">
        {term ? <Term k={term}>{label}</Term> : label}
        {provenance && <ProvenanceTip label={label} provenance={provenance} />}
      </dt>
      <dd className="text-right tabular-nums text-zinc-800 dark:text-zinc-200">{children}</dd>
    </div>
  );
}

function EvaluateBody({ result }: { result: ScenarioResult }) {
  const { economics: e } = result.evaluation;
  const em = result.evaluation.emissions;
  const ex = evalExtras(result.evaluation);
  const prov = headlineProvenance(result, ex);
  const a = assumptionsOf(result);
  const land = landAcres(result.evaluation, ex);
  const landDirect = landAcresDirect(result.evaluation, ex);
  const showDirect = landDirect !== undefined && land !== undefined && land > 0;
  const served = servedMwh(result, ex);
  // With no gas burned the backend reports the input price as the "effective" price; don't present it as burn-weighted.
  const burnsGas = ex.fuel_mmbtu_per_yr === undefined || ex.fuel_mmbtu_per_yr > 0;

  const capex = finite(e.capex_total_usd);
  const opex = finite(e.annual_opex_usd);
  const npc = finite(e.npc_usd);
  const lcoe = finite(e.lcoe_usd_per_mwh);
  const co2 = finite(em.annual_t_co2e);
  const intensity = finite(em.intensity_kg_per_mwh);
  const lines = e.lines ?? [];
  const bom = e.bom ?? [];
  const hasDetail = ex.npc_breakdown !== undefined || ex.cfe_score_24_7 !== undefined;

  const gasShape =
    ex.gas_price_monthly_usd_per_mmbtu === undefined
      ? null
      : ex.gas_price_monthly_usd_per_mmbtu === null
        ? "flat all year"
        : `${a.weatherYear} PG&E Citygate monthly shape, mean = input`;

  return (
    <Panel title="Evaluate" owner="C · Evaluate">
      <p className="-mt-1 mb-3 text-[10px] text-zinc-500">
        {ex.dollar_year ? (
          <>
            <Term k="real_dollars">Real {ex.dollar_year} USD</Term> ·{" "}
          </>
        ) : (
          ""
        )}
        {a.years}-yr horizon · {pctRate(a.rate)} <Term k="discount_rate">real discount rate</Term>
      </p>

      <div className="@container">
        <div className="grid grid-cols-2 gap-3 @xs:grid-cols-3 @lg:grid-cols-4">
          <StatTip label="CAPEX" term="capex" value={capex !== undefined ? usd(capex) : DASH} provenance={prov.capex_total_usd} sub="year 0" />
          <StatTip label="NPC" term="npc" value={npc !== undefined ? usd(npc) : DASH} provenance={prov.npc_usd} sub={`${a.years}-yr present value`} />
          <StatTip
            label="LCOE"
            term="lcoe"
            value={lcoe !== undefined ? `$${lcoe.toFixed(0)}` : DASH}
            unit="/MWh"
            provenance={prov.lcoe_usd_per_mwh}
            sub={
              ex.lcoe_crf_usd_per_mwh !== undefined ? (
                <>
                  <Term k="crf">CRF</Term> check {perMwh(ex.lcoe_crf_usd_per_mwh)}
                </>
              ) : (
                "NPC ÷ discounted MWh"
              )
            }
            tipExtra={
              ex.lcoe_crf_usd_per_mwh !== undefined
                ? `Cross-check: annualizing each asset's CAPEX with its own capital recovery factor gives ${perMwh(ex.lcoe_crf_usd_per_mwh)}.`
                : undefined
            }
          />
          <StatTip label="Annual OPEX" term="opex" value={opex !== undefined ? usd(opex) : DASH} provenance={prov.annual_opex_usd} sub="year 1" />
          <StatTip label="CO2e / yr" term="co2e" value={co2 !== undefined ? tons(co2) : DASH} provenance={prov.annual_t_co2e} sub="CAISO hourly imports" />
          <StatTip
            label="CO2 intensity"
            term="co2_intensity"
            value={intensity !== undefined ? Math.round(intensity).toLocaleString() : DASH}
            unit="kg/MWh"
            provenance={prov.intensity_kg_per_mwh}
            sub={
              served !== undefined ? (
                <>
                  {(served / 1e6).toFixed(2)} <Term k="twh">TWh</Term>/yr served
                </>
              ) : (
                "per MWh served"
              )
            }
          />
          <StatTip
            label="24/7 CFE"
            term="cfe_247"
            value={ex.cfe_score_24_7 !== undefined ? pct(ex.cfe_score_24_7) : DASH}
            provenance={prov.cfe_score_24_7}
            sub={ex.cfe_score_24_7 !== undefined ? "hours fully clean" : "not reported"}
          />
          <StatTip
            label="Land"
            value={land !== undefined ? Math.round(land).toLocaleString() : DASH}
            unit="acres"
            provenance={prov.land_acres_total}
            sub={
              <>
                total project area
                {showDirect && <span className="block">{acres(landDirect)} direct footprint</span>}
              </>
            }
            tipExtra={
              showDirect
                ? `Project area counts the full spacing between wind turbines; that land stays usable (e.g. grazing). The direct footprint, ${acres(landDirect)}, is exclusive-use land only: wind pads and roads, plus every other asset's area.`
                : undefined
            }
          />
        </div>
      </div>

      <div className="mt-4 space-y-4">
        {ex.npc_breakdown && npc !== undefined && (
          <CostWaterfall breakdown={ex.npc_breakdown} npcUsd={npc} years={a.years} rate={a.rate} dollarYear={ex.dollar_year} />
        )}

        <dl className="text-[11px]">
          <Input
            label="Gas price"
            provenance={[
              {
                kind: "assumption",
                source: "Scenario input: annual-average gas price (editable in assumptions)",
                note: ex.methodology.fuel ?? null,
              },
            ]}
          >
            ${a.gasPrice.toFixed(2)}/<Term k="mmbtu">MMBtu</Term> avg
            {ex.fuel_effective_usd_per_mmbtu !== undefined && burnsGas && (
              <span className="text-zinc-500"> · burn-weighted ${ex.fuel_effective_usd_per_mmbtu.toFixed(2)}</span>
            )}
            {!burnsGas && <span className="text-zinc-500"> · no gas burned</span>}
            {gasShape && <span className="block text-[10px] text-zinc-500">{gasShape}</span>}
          </Input>
          <Input
            label="Import delivery adder"
            term="import_adder"
            provenance={[
              {
                kind: "assumption",
                source: "Scenario input: added to the hourly price for every imported MWh (transmission access + delivery)",
                note: ex.methodology.imports ?? null,
              },
            ]}
          >
            ${a.importAdder.toFixed(0)}/MWh
          </Input>
          <Input
            label="Carbon price"
            term="carbon_price"
            provenance={[
              {
                kind: "assumption",
                source: "Scenario input: applied to on-site combustion CO2 only",
                note: ex.methodology.carbon ?? "CAISO prices already embed cap-and-trade, so pricing imports again would double count.",
              },
            ]}
          >
            ${a.carbonPrice.toFixed(0)}/t
            {ex.ca_allowance_reference_usd_per_t !== undefined && (
              <span className="text-zinc-500"> · CA allowance ref ${ex.ca_allowance_reference_usd_per_t.toFixed(2)}/t</span>
            )}
          </Input>
        </dl>

        <EmissionsBreakdown result={result} ex={ex} prov={prov} />

        <CfeCard ex={ex} provenance={prov.cfe_score_24_7} />

        {!hasDetail && (
          <p className="text-[10px] text-zinc-500">
            This evaluation backend reports headline numbers and cost lines only; the cost waterfall and 24/7 CFE appear once it reports
            the full breakdown.
          </p>
        )}

        <div className="space-y-2">
          <Disclosure title="Cost lines" meta={`${lines.length} lines`} defaultOpen={!ex.npc_breakdown}>
            <CostLinesTable lines={lines} />
          </Disclosure>
          <Disclosure title="Bill of materials" meta={`${bom.length} items`}>
            <BomTable bom={bom} />
          </Disclosure>
          <Disclosure title="Methodology">
            <Methodology methodology={ex.methodology} />
          </Disclosure>
        </div>
      </div>

      <p className="mt-3 text-[10px] text-zinc-400">
        <span className="font-medium">Financial boundary:</span> {e.financial_boundary}
      </p>
    </Panel>
  );
}

