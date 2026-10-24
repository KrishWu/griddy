"use client";
// Why the site-location model gave this GriddyGrade: rank among California cells, each technology's
// learned suitability, and the features that drive it. Shown first in the GriddyGrade details.
// OWNER: workstream B.
import { ProvenanceTip } from "@/components/evaluate/ProvenanceTip";

import type { MlGrade } from "./useMlGrade";

const KIND_LABEL: Record<string, string> = { solar_pv: "Solar", onshore_wind: "Wind", battery: "Battery", gas_cc: "Gas" };

function fmtDriver(value: number, unit: string, key: string): string {
  if (key === "in_nonattainment") return value >= 0.5 ? "Yes" : "No";
  const digits = unit === "km" || unit === "m/s" || unit === "kWh/m²/day" ? 1 : 0;
  return `${value.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits })}${unit ? ` ${unit}` : ""}`;
}

export function MlGradeDetails({ grade }: { grade: MlGrade }) {
  if (!grade.in_coverage || grade.score === null) {
    return <p className="text-xs text-zinc-500 dark:text-zinc-400">{grade.note ?? "The site-location model has no score for this point."}</p>;
  }
  const m = grade.model;
  return (
    <section aria-label="Site-location model">
      <h3 className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
        Site-location model
        <ProvenanceTip label="Site-location model" provenance={grade.provenance}>
          <span className="block">{grade.method}</span>
        </ProvenanceTip>
      </h3>
      <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-300">
        Better than <span className="font-semibold tabular-nums">{grade.percentile?.toFixed(1)}%</span> of {grade.n_cells.toLocaleString()} California
        sites (rank {grade.rank?.toLocaleString()}), projected for {m.year} ({m.scenario} demand).
      </p>
      <ul className="mt-2 space-y-1">
        {Object.entries(grade.suitability).map(([k, v]) => (
          <li key={k} className="flex items-center gap-2 text-[11px] text-zinc-600 dark:text-zinc-300">
            <span className="w-14 shrink-0">{KIND_LABEL[k] ?? k}</span>
            <span className="relative block h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800" aria-hidden>
              <span className="block h-full rounded-full bg-sky-600 dark:bg-sky-400" style={{ width: `${Math.max(0, Math.min(1, v)) * 100}%` }} />
            </span>
            <span className="w-10 shrink-0 text-right tabular-nums">{v.toFixed(2)}</span>
          </li>
        ))}
      </ul>
      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
        {grade.drivers.map((d) => (
          <div key={d.key} className="flex min-w-0 justify-between gap-2">
            <dt className="truncate text-zinc-500 dark:text-zinc-400">{d.label}</dt>
            <dd className="shrink-0 tabular-nums text-zinc-700 dark:text-zinc-300">{fmtDriver(d.value, d.unit, d.key)}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-2 text-[10px] leading-snug text-zinc-500 dark:text-zinc-400">
        Suitability = how much this place looks like where each kind of plant was actually built (learned from EIA-860, grid distances,
        resource, demand growth, queue and air quality). Screening only: capacity still needs a utility study.
      </p>
    </section>
  );
}
