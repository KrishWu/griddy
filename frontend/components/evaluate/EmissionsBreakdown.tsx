"use client";
// Emissions: by-source bars with a toggle between the two import-accounting methods
// (CAISO hourly average vs CARB's default for unspecified imports), intensity, an
// intensity comparison against the grid and eGRID CAMX, NOx/PM2.5, and the honest note
// that on-site gas CC can be dirtier per MWh than average CAISO imports.
// Works on the contract fields alone; extras add the CARB toggle, cross-check and NOx.
// OWNER: workstream C (Evaluate).
import { useId, useState } from "react";

import { Term } from "@/components/glossary/Term";
import type { Provenance, ScenarioResult } from "@/lib/contract";
import type { GlossaryKey } from "@/lib/glossary";

import { CHART_VARS } from "./chartTheme";
import { carbFactorText, type EvalExtras, type ProvenanceMetric } from "./extras";
import { DASH, finite, tonsFine } from "./fmt";
import { ProvenanceTip } from "./ProvenanceTip";
import { StatTip } from "./StatTip";
import { CarbonLedger } from "./CarbonLedger";

const SOURCE_LABEL: Record<string, string> = {
  gas_cc: "On-site gas CC",
  gas_ct: "On-site gas CT",
  grid_imports: "Grid imports",
  upstream_methane: "Upstream methane",
};
const sourceLabel = (k: string) => SOURCE_LABEL[k] ?? k.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
// Glossary entry per source row (the first place each of these words shows up in the panel).
const SOURCE_TERM: Record<string, GlossaryKey> = {
  gas_cc: "gas_cc",
  gas_ct: "gas_ct",
  grid_imports: "imports",
  upstream_methane: "upstream_methane",
};

interface BarRow {
  key: string;
  label: string;
  value: number;
  display: string;
  color: string;
  emphasis?: boolean;
  /** Glossary entry explaining the label. */
  term?: GlossaryKey;
}

/** Labeled horizontal bars in HTML: every value is printed, so no hover is needed to read it. */
function BarList({ rows, max, labelWidth = "w-[42%]" }: { rows: BarRow[]; max: number; labelWidth?: string }) {
  return (
    <ul className="space-y-1">
      {rows.map((r) => (
        <li key={r.key} className="flex items-center gap-2 text-[11px]">
          <span className={`${labelWidth} shrink-0 truncate ${r.emphasis ? "font-medium text-zinc-900 dark:text-zinc-100" : "text-zinc-600 dark:text-zinc-400"}`} title={r.label}>
            {r.term ? <Term k={r.term}>{r.label}</Term> : r.label}
          </span>
          <span className="relative h-2.5 flex-1">
            <span
              className="absolute inset-y-0 left-0 rounded-r-[3px] transition-[width] duration-300"
              style={{ width: `${max > 0 ? Math.max(0.5, (100 * Math.max(0, r.value)) / max) : 0}%`, background: r.color }}
            />
          </span>
          <span className={`w-16 shrink-0 text-right tabular-nums ${r.emphasis ? "font-semibold text-zinc-900 dark:text-zinc-100" : "text-zinc-700 dark:text-zinc-300"}`}>
            {r.display}
          </span>
        </li>
      ))}
    </ul>
  );
}

const mean = (a: number[] | undefined) => {
  if (!a?.length) return undefined;
  let s = 0;
  let n = 0;
  for (const v of a) {
    if (Number.isFinite(v)) {
      s += v;
      n++;
    }
  }
  return n ? s / n : undefined;
};

export function EmissionsBreakdown({
  result,
  ex,
  prov,
}: {
  result: ScenarioResult;
  ex: EvalExtras;
  prov: Record<ProvenanceMetric, Provenance[]>;
}) {
  const [method, setMethod] = useState<"caiso" | "carb">("caiso");
  const headingId = useId();
  const em = result.evaluation.emissions;
  const sim = result.simulation;
  const carb = ex.emissions_import_methods?.carb_unspecified;
  const useCarb = method === "carb" && carb !== undefined;

  // ---- by source -----------------------------------------------------------
  const base: Record<string, number> = {};
  for (const [k, v] of Object.entries(em.by_source_t_co2e ?? {})) {
    const n = finite(v);
    if (n !== undefined) base[k] = n;
  }
  const bySource = { ...base };
  if (useCarb) bySource.grid_imports = carb.grid_imports_t;
  const total = useCarb ? carb.annual_t_co2e : finite(em.annual_t_co2e);
  const intensity = useCarb ? carb.intensity_kg_per_mwh : finite(em.intensity_kg_per_mwh);
  // One scale for both methods, so flipping the toggle visibly lengthens the imports bar.
  const sourceMax = Math.max(0, ...Object.values(base), carb?.grid_imports_t ?? 0);
  const sourceRows: BarRow[] = Object.entries(bySource)
    .filter(([, v]) => Math.abs(v) >= 0.5)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => ({ key: k, label: sourceLabel(k), value: v, display: tonsFine(v), color: "var(--ev-accent)", term: SOURCE_TERM[k] }));

  // ---- intensity comparison (kg CO2e per MWh) --------------------------------
  const gen = sim.summary.generation_mwh ?? {};
  const rate = (t: number | undefined, mwhVal: number | undefined) =>
    t !== undefined && mwhVal !== undefined && mwhVal > 0 ? (t * 1000) / mwhVal : undefined;
  const gasCc = rate(base.gas_cc, finite(gen.gas_cc));
  const gasCt = rate(base.gas_ct, finite(gen.gas_ct));
  const xc = ex.emissions_crosscheck;
  const importsMwh = finite(sim.summary.imports_mwh) ?? 0;
  const importWeighted =
    xc?.sim_import_weighted_kg_per_mwh !== undefined
      ? (xc.sim_import_weighted_kg_per_mwh ?? undefined)
      : importsMwh > 0
        ? rate(base.grid_imports, importsMwh)
        : undefined;
  const gridMean = xc?.sim_grid_mean_kg_per_mwh ?? mean(sim.hourly.grid_co2_kg_per_mwh);
  const carbFactor = carb?.factor_t_per_mwh !== undefined ? carb.factor_t_per_mwh * 1000 : undefined;
  const carbText = carbFactorText(carb);
  const year = finite(result.scenario.assumptions?.weather_year) ?? 2024;

  const ctx = "var(--ev-context)";
  const intensityCandidates: (Omit<BarRow, "display" | "value"> & { value: number | undefined })[] = [
    { key: "scenario", label: "This scenario (per MWh served)", value: intensity, color: "var(--ev-accent)", emphasis: true },
    { key: "gas_cc", label: "On-site gas CC", value: gasCc, color: ctx },
    { key: "gas_ct", label: "On-site gas CT", value: gasCt, color: ctx },
    { key: "imports", label: "Grid imports, import-weighted", value: importWeighted, color: ctx },
    { key: "grid_mean", label: `CAISO grid, ${year} hourly mean`, value: gridMean, color: ctx, term: "caiso" },
    { key: "egrid", label: `eGRID CAMX${xc?.egrid_year ? ` ${xc.egrid_year}` : ""}`, value: xc?.egrid_camx_kg_per_mwh, color: ctx, term: "egrid" },
    { key: "carb", label: "CARB unspecified-import default", value: carbFactor, color: ctx, term: "carb" },
  ];
  const intensityRows: BarRow[] = intensityCandidates
    .filter((r): r is Omit<BarRow, "display"> & { value: number } => r.value !== undefined && Number.isFinite(r.value))
    .map((r) => ({ ...r, display: Math.round(r.value).toLocaleString() }));
  const intensityMax = Math.max(0, ...intensityRows.map((r) => r.value));

  const crosscheckProv: Provenance[] = [
    ...(xc?.egrid_camx_kg_per_mwh !== undefined
      ? [
          {
            kind: "observed" as const,
            source: `EPA eGRID${xc.egrid_year ? ` ${xc.egrid_year}` : ""}, WECC California (CAMX) subregion output emission rate`,
            note: xc.note ?? null,
          },
        ]
      : []),
    {
      kind: "simulated",
      source: "Grid rows use the simulation's hourly CAISO grid CO2 intensity",
      note: "Import-weighted = Σ(imports × hourly intensity) ÷ Σ imports. On-site gas rows = that unit's CO2 ÷ its MWh.",
    },
    ...(carbFactor !== undefined
      ? [
          {
            kind: "assumption" as const,
            source: "CARB Mandatory Reporting Regulation default emission factor for unspecified imports",
            note: carbText ?? null,
          },
        ]
      : []),
  ];

  // ---- the honest note -------------------------------------------------------
  const gasMwh = (finite(gen.gas_cc) ?? 0) + (finite(gen.gas_ct) ?? 0);
  let honest: string;
  if (gasMwh <= 0) {
    honest = (total ?? 0) === 0
      ? "No modeled operational emissions: no on-site combustion or emissions from grid imports in this run. Construction carbon is a separate estimate below."
      : "No on-site combustion: annual operational CO2e comes from grid imports. Solar and wind produce no direct operating CO2; imports can supply demand and charge batteries when renewables fall short.";
  } else if ((gasCc ?? gasCt) !== undefined && gridMean !== undefined) {
    const gasI = (gasCc ?? gasCt) as number;
    const dirtier = gasI > gridMean;
    honest =
      `On-site gas ${gasCc !== undefined ? "CC" : "CT"} emits about ${Math.round(gasI)} kg CO2/MWh, ${dirtier ? "more" : "less"} than the ${year} CAISO grid average ` +
      `(${Math.round(gridMean)} kg/MWh). ${
        dirtier ? "Serving load from on-site gas instead of grid imports can raise emissions: that is physics, not a model error. " : ""
      }No factor is tuned to force an ordering between presets; compare both import-accounting methods instead.`;
  } else {
    honest =
      "On-site gas combustion can be more carbon-intensive per MWh than CAISO's average grid mix, so adding gas can raise emissions. No factor is tuned to force an ordering between presets.";
  }

  const methane = ex.upstream_methane_t_co2e;

  return (
    <section className={`${CHART_VARS} space-y-3`} aria-labelledby={headingId}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={headingId} className="text-xs font-semibold text-zinc-700 dark:text-zinc-300">
          Annual operational emissions
        </h3>
        {carb && (
          <div role="group" aria-label="Import accounting method" className="flex rounded border border-zinc-200 p-0.5 text-[10px] dark:border-zinc-700">
            {(
              [
                ["caiso", "CAISO hourly avg"],
                ["carb", `CARB unspecified${carb.factor_t_per_mwh !== undefined ? ` ${carb.factor_t_per_mwh.toFixed(3)} t/MWh` : ""}`],
              ] as const
            ).map(([m, text]) => (
              <button
                key={m}
                type="button"
                aria-pressed={method === m}
                onClick={() => setMethod(m)}
                className={`rounded px-1.5 py-0.5 focus-visible:outline-2 focus-visible:outline-sky-500 ${
                  method === m
                    ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                    : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
                }`}
              >
                {text}
              </button>
            ))}
          </div>
        )}
      </div>

      <p className="flex flex-wrap items-baseline gap-x-1.5 text-[11px] text-zinc-600 dark:text-zinc-400">
        <span className="text-base font-semibold text-zinc-900 dark:text-zinc-100">{total !== undefined ? tonsFine(total) : DASH}</span>
        <span>CO2e/yr ·</span>
        <span className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
          {intensity !== undefined ? Math.round(intensity).toLocaleString() : DASH}
        </span>
        <span>kg/MWh served</span>
        <ProvenanceTip
          label="Emissions total"
          provenance={
            useCarb
              ? [
                  ...prov.annual_t_co2e,
                  {
                    kind: "assumption",
                    source: "Imports re-counted at CARB's default factor for unspecified imports",
                    note: `${carbText ?? "CARB default factor"}, applied to every imported MWh instead of the hourly CAISO intensity.`,
                  },
                ]
              : prov.annual_t_co2e
          }
        />
        <span className="basis-full text-[10px] text-zinc-500">
          Imports counted at {useCarb ? "CARB's default for unspecified imports" : "the CAISO hourly average intensity"}.
        </span>
      </p>

      {sourceRows.length > 0 && (
        <div>
          <div className="mb-1 text-[10px] uppercase tracking-wide text-zinc-500">
            By source, <Term k="t_co2e">t CO2e</Term>/yr
          </div>
          <BarList rows={sourceRows} max={sourceMax} />
        </div>
      )}
      {methane !== undefined && methane > 0 && !ex.upstream_methane_included && (
        <p className="text-[10px] text-zinc-500">
          Upstream methane is excluded by default; including it (scenario option <code>include_upstream_methane</code>) would add{" "}
          {tonsFine(methane)} CO2e/yr.
        </p>
      )}

      {intensityRows.length > 1 && (
        <div>
          <div className="mb-1 flex items-center gap-1 text-[10px] uppercase tracking-wide text-zinc-500">
            Intensity comparison, kg CO2e/MWh
            <ProvenanceTip label="Intensity comparison" provenance={crosscheckProv} />
          </div>
          <BarList rows={intensityRows} max={intensityMax} labelWidth="w-[52%]" />
        </div>
      )}

      <p className="rounded bg-zinc-50 px-2 py-1.5 text-[11px] leading-snug text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400">{honest}</p>

      {ex.nox_t_per_yr !== undefined && (
        <div>
          <div className="mb-1 text-[10px] uppercase tracking-wide text-zinc-500">Air quality, on-site combustion</div>
          <div className="grid grid-cols-2 gap-3">
            <StatTip
              label="NOx / yr"
              term="nox"
              value={tonsFine(ex.nox_t_per_yr)}
              provenance={prov.nox_t_per_yr}
              sub={
                gasMwh <= 0
                  ? "no on-site combustion"
                  : ex.nox_t_per_yr_scr !== undefined
                    ? (
                        <>
                          {tonsFine(ex.nox_t_per_yr_scr)} with <Term k="scr_bact">SCR (CA BACT)</Term>
                        </>
                      )
                    : (
                        <>
                          <Term k="ap42">AP-42</Term> lean-premix
                        </>
                      )
              }
              tipExtra={ex.nox_basis}
            />
            <StatTip
              label="PM2.5 / yr"
              term="pm25"
              value={ex.pm25_t_per_yr !== undefined ? tonsFine(ex.pm25_t_per_yr) : DASH}
              provenance={prov.pm25_t_per_yr}
              sub={
                <>
                  <Term k="ap42">AP-42</Term> natural-gas turbines
                </>
              }
            />
          </div>
        </div>
      )}

      <p className="text-[10px] text-zinc-500">Charging has no direct on-site emissions; emissions from charging electricity are included in gas or imports. Exports earn no avoided-emissions credit. Construction carbon is excluded from the annual figure.</p>
      <CarbonLedger result={result} />
    </section>
  );
}
