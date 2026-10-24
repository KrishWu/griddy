"use client";
// Side-by-side scenario comparison.  OWNER: workstream C (Evaluate).
// D's compare view imports this; keep the props stable. STUB: headline metrics only.
import type { ScenarioResult } from "@/lib/contract";
import { tons, usd } from "@/lib/format";

export function ComparisonTable({ results }: { results: ScenarioResult[] }) {
  if (!results.length) return null;
  const rows: { label: string; value: (r: ScenarioResult) => string }[] = [
    { label: "CAPEX", value: (r) => usd(r.evaluation.economics.capex_total_usd) },
    { label: "LCOE", value: (r) => `$${r.evaluation.economics.lcoe_usd_per_mwh.toFixed(0)}/MWh` },
    { label: "CO2e / yr", value: (r) => tons(r.evaluation.emissions.annual_t_co2e) },
    { label: "Unmet hours", value: (r) => String(r.simulation.summary.hours_unmet) },
  ];
  return (
    <table className="w-full text-xs">
      <thead>
        <tr>
          <th />
          {results.map((r) => (
            <th key={r.scenario.id} className="px-2 text-right font-semibold">
              {r.scenario.name}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.label} className="border-t border-zinc-100 dark:border-zinc-800">
            <td className="py-1 text-zinc-500">{row.label}</td>
            {results.map((r) => (
              <td key={r.scenario.id} className="px-2 py-1 text-right tabular-nums">
                {row.value(r)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
