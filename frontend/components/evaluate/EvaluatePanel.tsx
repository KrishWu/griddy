"use client";
// Costs + emissions.  OWNER: workstream C (Evaluate).
// STUB: headline numbers and the cost line table.
import { Panel, Stat } from "@/components/shell/Panel";
import { tons, usd } from "@/lib/format";
import { useGridForge } from "@/lib/store";

export function EvaluatePanel() {
  const { result } = useGridForge();
  if (!result) return null;
  const { economics: e, emissions: em } = result.evaluation;
  return (
    <Panel title="Evaluate" owner="C · Evaluate">
      <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="CAPEX" value={usd(e.capex_total_usd)} />
        <Stat label="Annual OPEX" value={usd(e.annual_opex_usd)} />
        <Stat label="LCOE" value={`$${e.lcoe_usd_per_mwh.toFixed(0)}/MWh`} />
        <Stat label="CO2e / yr" value={tons(em.annual_t_co2e)} />
      </div>
      <table className="w-full text-xs">
        <tbody>
          {e.lines.map((l, i) => (
            <tr key={i} className="border-t border-zinc-100 dark:border-zinc-800">
              <td className="py-1 text-zinc-500">{l.category}</td>
              <td className="py-1">{l.item}</td>
              <td className="py-1 text-right tabular-nums">{usd(l.usd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-[11px] text-zinc-400">{e.financial_boundary}</p>
    </Panel>
  );
}
