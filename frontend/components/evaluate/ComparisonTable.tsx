"use client";
// Side-by-side scenario comparison.  OWNER: workstream C (Evaluate).
// D's compare view imports this; keep the props stable. Values that a result's
// evaluation backend didn't report (extras missing) show "—". The best value in each
// row is set in bold when at least two scenarios report it.
import { Term } from "@/components/glossary/Term";
import type { ScenarioResult } from "@/lib/contract";
import { pct, usd } from "@/lib/format";
import type { GlossaryKey } from "@/lib/glossary";

import { evalExtras, landAcres, landAcresDirect, type EvalExtras } from "./extras";
import { DASH, finite, perMwh } from "./fmt";

interface Row {
  label: string;
  /** Glossary entry explaining the row header. */
  term?: GlossaryKey;
  unit?: string;
  get: (r: ScenarioResult, ex: EvalExtras) => number | undefined;
  /** `row` holds every value reported in this row, so a row can share one scale (e.g. all Mt). */
  fmt: (v: number, row: number[]) => string;
  better: "low" | "high";
  /** Optional small second line under a cell's value. */
  sub?: (r: ScenarioResult, ex: EvalExtras) => { text: string; title?: string } | undefined;
}

/** One unit for the whole row, so 1.96 Mt and 0.84 Mt read side by side (not "840,910 t"). */
const co2Row = (v: number, row: number[]) => {
  const max = Math.max(0, ...row.map(Math.abs));
  if (max >= 1e6) return `${(v / 1e6).toFixed(2)} Mt`;
  if (max >= 1e4) return `${Math.round(v / 1e3).toLocaleString()}k t`;
  return `${Math.round(v).toLocaleString()} t`;
};

const smallTons = (v: number) => (v === 0 ? "0" : v >= 100 ? Math.round(v).toLocaleString() : v.toFixed(v >= 10 ? 1 : 2));
const int = (v: number) => Math.round(v).toLocaleString();

const ROWS: Row[] = [
  { label: "CAPEX", term: "capex", get: (r) => finite(r.evaluation.economics.capex_total_usd), fmt: usd, better: "low" },
  { label: "NPC", term: "npc", get: (r) => finite(r.evaluation.economics.npc_usd), fmt: usd, better: "low" },
  { label: "LCOE", term: "lcoe", get: (r) => finite(r.evaluation.economics.lcoe_usd_per_mwh), fmt: perMwh, better: "low" },
  { label: "CO2e / yr", term: "co2e", get: (r) => finite(r.evaluation.emissions.annual_t_co2e), fmt: co2Row, better: "low" },
  { label: "CO2 intensity", term: "co2_intensity", unit: "kg/MWh", get: (r) => finite(r.evaluation.emissions.intensity_kg_per_mwh), fmt: int, better: "low" },
  { label: "Unmet hours", term: "unmet", get: (r) => finite(r.simulation.summary.hours_unmet), fmt: int, better: "low" },
  {
    label: "Land",
    unit: "acres",
    get: (r, ex) => landAcres(r.evaluation, ex),
    fmt: int,
    better: "low",
    sub: (r, ex) => {
      const total = landAcres(r.evaluation, ex);
      const direct = landAcresDirect(r.evaluation, ex);
      return direct !== undefined && total !== undefined && total > 0
        ? {
            text: `${int(direct)} direct`,
            title: "Direct (exclusive-use) footprint. The main figure is total project area, which includes the spacing between wind turbines.",
          }
        : undefined;
    },
  },
  { label: "24/7 CFE", term: "cfe_247", get: (_r, ex) => ex.cfe_score_24_7, fmt: pct, better: "high" },
  { label: "NOx", term: "nox", unit: "t/yr", get: (_r, ex) => ex.nox_t_per_yr, fmt: smallTons, better: "low" },
];

export function ComparisonTable({ results }: { results: ScenarioResult[] }) {
  if (!results.length) return null;
  const extras = results.map((r) => evalExtras(r.evaluation));
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <caption className="sr-only">Scenario comparison; the best value in each row is bold</caption>
        <thead>
          <tr>
            <th scope="col" className="text-left font-normal text-zinc-400">
              <span className="sr-only">Metric</span>
            </th>
            {results.map((r, i) => (
              <th key={`${r.scenario.id}-${i}`} scope="col" className="px-2 pb-1 text-right align-bottom font-semibold">
                {r.scenario.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ROWS.map((row) => {
            const values = results.map((r, i) => row.get(r, extras[i]));
            const present = values.filter((v): v is number => v !== undefined);
            const best =
              present.length >= 2 && new Set(present).size > 1 ? (row.better === "low" ? Math.min(...present) : Math.max(...present)) : undefined;
            return (
              <tr key={row.label} className="border-t border-zinc-100 align-top dark:border-zinc-800">
                <th scope="row" className="whitespace-nowrap py-1 pr-2 text-left font-normal text-zinc-500">
                  {row.term ? <Term k={row.term}>{row.label}</Term> : row.label}
                  {row.unit && <span className="ml-1 text-[10px] text-zinc-400 dark:text-zinc-500">{row.unit}</span>}
                </th>
                {values.map((v, i) => {
                  const sub = row.sub?.(results[i], extras[i]);
                  return (
                    <td
                      key={`${results[i].scenario.id}-${i}`}
                      className={`px-2 py-1 text-right tabular-nums ${
                        v !== undefined && v === best ? "font-semibold text-zinc-900 dark:text-zinc-50" : "text-zinc-700 dark:text-zinc-300"
                      }`}
                    >
                      {v !== undefined ? row.fmt(v, present) : DASH}
                      {sub && (
                        <span className="block text-[10px] font-normal text-zinc-500" title={sub.title}>
                          {sub.text}
                        </span>
                      )}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
