"use client";
// Contract cost lines grouped by category with subtotals; each line carries its own
// provenance marker. CAPEX is year-0 spend; every other category is a year-1 amount.
// OWNER: workstream C (Evaluate).
import type { ReactNode } from "react";

import { Term } from "@/components/glossary/Term";
import type { CostLine } from "@/lib/contract";

import { finite, signedUsd } from "./fmt";
import { ProvenanceTip } from "./ProvenanceTip";

const ORDER: { cat: CostLine["category"]; label: ReactNode }[] = [
  {
    cat: "capex",
    label: (
      <>
        <Term k="capex">Capital</Term>, year 0
      </>
    ),
  },
  {
    cat: "fixed_om",
    label: (
      <>
        Fixed <Term k="om">O&amp;M</Term>, per year
      </>
    ),
  },
  { cat: "var_om", label: "Variable O&M, per year" },
  { cat: "fuel", label: "Fuel, per year" },
  {
    cat: "purchased_power",
    label: (
      <>
        <Term k="imports">Purchased power</Term>, per year
      </>
    ),
  },
  {
    cat: "carbon",
    label: (
      <>
        <Term k="carbon_price">Carbon cost</Term>, per year
      </>
    ),
  },
  {
    cat: "export_revenue",
    label: (
      <>
        <Term k="exports">Export credit</Term>, per year
      </>
    ),
  },
];

export function CostLinesTable({ lines }: { lines: CostLine[] }) {
  const known = new Set(ORDER.map((o) => o.cat));
  const groups = [
    ...ORDER.map((o) => ({ ...o, rows: lines.filter((l) => l.category === o.cat) })),
    { cat: "other", label: "Other", rows: lines.filter((l) => !known.has(l.category)) },
  ].filter((g) => g.rows.length > 0);

  if (!groups.length) return <p className="text-xs text-zinc-500">No cost lines reported.</p>;

  return (
    <table className="w-full text-[11px]">
      <caption className="sr-only">Cost lines by category</caption>
      {groups.map((g) => {
        const subtotal = g.rows.reduce((s, l) => s + (finite(l.usd) ?? 0), 0);
        return (
          <tbody key={g.cat}>
            <tr>
              <th scope="rowgroup" className="pt-2 text-left text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
                {g.label}
              </th>
              <td className="pt-2 text-right text-[10px] font-semibold tabular-nums text-zinc-500">{g.rows.length > 1 ? signedUsd(subtotal) : ""}</td>
              <td className="w-5" />
            </tr>
            {g.rows.map((l, i) => {
              const v = finite(l.usd);
              return (
                <tr key={i} className="border-t border-zinc-100 align-top dark:border-zinc-800">
                  <td className="py-1 pr-2 text-zinc-700 dark:text-zinc-300">{l.item}</td>
                  <td className="whitespace-nowrap py-1 text-right tabular-nums text-zinc-900 dark:text-zinc-100">{v !== undefined ? signedUsd(v) : "—"}</td>
                  <td className="py-1 pl-1.5 text-right">
                    <ProvenanceTip label={l.item} provenance={l.provenance} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        );
      })}
    </table>
  );
}
