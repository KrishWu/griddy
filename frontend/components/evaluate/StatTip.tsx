"use client";
// Headline stat tile with a provenance marker beside its label.
// OWNER: workstream C (Evaluate).
import type { ReactNode } from "react";

import type { Provenance } from "@/lib/contract";

import { ProvenanceTip } from "./ProvenanceTip";

export function StatTip({
  label,
  value,
  unit,
  sub,
  provenance,
  tipExtra,
}: {
  label: string;
  value: string;
  /** Small unit suffix after the value, e.g. "/MWh". */
  unit?: string;
  /** One short context line under the value. */
  sub?: ReactNode;
  provenance: Provenance | Provenance[] | null | undefined;
  /** Extra lines inside the provenance card (formula, cross-check). */
  tipExtra?: ReactNode;
}) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1 text-[11px] text-zinc-500">
        <span className="truncate">{label}</span>
        <ProvenanceTip label={label} provenance={provenance}>
          {tipExtra}
        </ProvenanceTip>
      </div>
      <div className="truncate text-lg font-semibold leading-tight text-zinc-900 dark:text-zinc-100">
        {value}
        {unit && value !== "—" && <span className="ml-0.5 text-xs font-normal text-zinc-500">{unit}</span>}
      </div>
      {sub && <div className="mt-0.5 text-[10px] leading-snug text-zinc-500">{sub}</div>}
    </div>
  );
}
