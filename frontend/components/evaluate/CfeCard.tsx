"use client";
// 24/7 carbon-free energy: the hourly-matched score (SVCE's question), energy-weighted
// hourly matching vs annual netting, and the hour-of-day / month profile of matched hours.
// Renders nothing when the backend didn't report cfe_score_24_7.
// OWNER: workstream C (Evaluate).
import { useState } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis, type TooltipContentProps } from "recharts";

import type { Provenance } from "@/lib/contract";
import { pct } from "@/lib/format";

import { CHART_VARS, TICK, TOOLTIP_CARD } from "./chartTheme";
import type { EvalExtras } from "./extras";
import { pct1 } from "./fmt";
import { ProvenanceTip } from "./ProvenanceTip";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const hh = (h: number) => `${String(h).padStart(2, "0")}:00`;

interface Point {
  i: number;
  tick: string;
  share: number;
  title: string;
}

function ShareTooltip({ active, payload }: TooltipContentProps) {
  const p = payload?.[0]?.payload as Point | undefined;
  if (!active || !p) return null;
  return (
    <div className={TOOLTIP_CARD}>
      <div className="text-sm font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">{pct(p.share)}</div>
      <div className="text-zinc-500">{p.title}</div>
    </div>
  );
}

function Meter({ label, value, emphasis }: { label: string; value: number; emphasis?: boolean }) {
  return (
    <div className="flex items-center gap-2 text-[11px]">
      <span className={`w-[42%] shrink-0 ${emphasis ? "font-medium text-zinc-900 dark:text-zinc-100" : "text-zinc-600 dark:text-zinc-400"}`}>{label}</span>
      <span className="relative h-2 flex-1 overflow-hidden rounded-full bg-green-100 dark:bg-green-950">
        <span className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${Math.min(100, value * 100)}%`, background: "var(--ev-clean)" }} />
      </span>
      <span className={`w-10 shrink-0 text-right tabular-nums ${emphasis ? "font-semibold" : ""}`}>{pct(value)}</span>
    </div>
  );
}

export function CfeCard({ ex, provenance }: { ex: EvalExtras; provenance: Provenance[] }) {
  const hourly = ex.cfe_by_hour_of_day;
  const monthly = ex.cfe_by_month;
  const [view, setView] = useState<"hour" | "month">(hourly ? "hour" : "month");
  const score = ex.cfe_score_24_7;
  if (score === undefined) return null;

  const active = view === "hour" ? hourly : monthly;
  const data: Point[] = (active ?? []).map((share, i) =>
    view === "hour"
      ? { i, tick: String(i), share, title: `${hh(i)}–${hh((i + 1) % 24)} PST · share of days fully clean` }
      : { i, tick: MONTHS[i].slice(0, 1), share, title: `${MONTHS[i]} · share of hours fully clean` },
  );
  const energy = ex.cfe_hourly_energy_share;
  const netting = ex.cfe_annual_netting_share;
  const gap = energy !== undefined && netting !== undefined ? netting - energy : undefined;
  // No hour of the year fully clean: an all-zero profile chart says less than one sentence.
  const noneMatched = score === 0 && [...(hourly ?? []), ...(monthly ?? [])].every((v) => v <= 0);

  return (
    <section className={`${CHART_VARS} space-y-2`}>
      <h3 className="text-xs font-semibold text-zinc-700 dark:text-zinc-300">24/7 carbon-free energy</h3>
      <div className="flex items-end gap-3">
        <div className="flex items-center gap-1">
          <span className="text-3xl font-semibold leading-none text-zinc-900 dark:text-zinc-100">{pct(score)}</span>
          <ProvenanceTip label="24/7 CFE score" provenance={provenance}>
            An hour counts only if on-site clean output, the clean share of battery discharge and the clean share of grid imports
            cover all demand in that hour. Exact score: {pct1(score)}.
          </ProvenanceTip>
        </div>
        <p className="pb-0.5 text-[11px] leading-snug text-zinc-500">of hours fully matched by clean supply (hourly matching, not annual netting)</p>
      </div>

      {(energy !== undefined || netting !== undefined) && (
        <div className="space-y-1">
          {energy !== undefined && <Meter label="Hourly-matched energy" value={energy} emphasis />}
          {netting !== undefined && <Meter label="Annual netting" value={netting} />}
          {gap !== undefined && netting !== undefined && gap > 0.005 && (
            <p className="text-[10px] text-zinc-500">
              Annual netting would claim {pct(netting)}, {(gap * 100).toFixed(0)} points more clean energy than hour-by-hour matching delivers.
            </p>
          )}
        </div>
      )}

      {noneMatched && (
        <p className="rounded bg-zinc-50 px-2 py-1.5 text-[11px] leading-snug text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400">
          No hour of the year is fully met by clean supply, so the hour-of-day and monthly profiles are empty.
          {energy !== undefined && energy > 0 && ` Clean energy still covers ${pct(energy)} of demand on an hourly basis.`}
        </p>
      )}

      {data.length > 0 && !noneMatched && (
        <div>
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="text-[10px] uppercase tracking-wide text-zinc-500">
              {view === "hour" ? "Fully clean days, by hour (PST)" : "Fully clean hours, by month"}
            </span>
            {hourly && monthly && (
              <div role="group" aria-label="CFE profile" className="flex rounded border border-zinc-200 p-0.5 text-[10px] dark:border-zinc-700">
                {(
                  [
                    ["hour", "Hour"],
                    ["month", "Month"],
                  ] as const
                ).map(([v, text]) => (
                  <button
                    key={v}
                    type="button"
                    aria-pressed={view === v}
                    onClick={() => setView(v)}
                    className={`rounded px-1.5 py-0.5 focus-visible:outline-2 focus-visible:outline-sky-500 ${
                      view === v
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
          <div className="h-32">
            <ResponsiveContainer>
              <BarChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }} barCategoryGap={view === "hour" ? 2 : 4}>
                <CartesianGrid vertical={false} stroke="var(--ev-grid)" />
                <XAxis dataKey="tick" tick={TICK} tickLine={false} axisLine={{ stroke: "var(--ev-axis)" }} interval={view === "hour" ? 5 : 0} />
                <YAxis
                  domain={[0, 1]}
                  ticks={[0, 0.5, 1]}
                  tickFormatter={(v: number) => pct(v)}
                  tick={TICK}
                  tickLine={false}
                  axisLine={false}
                  width={34}
                />
                <Tooltip content={ShareTooltip} cursor={{ fill: "var(--ev-cursor)" }} isAnimationActive={false} />
                <Bar dataKey="share" fill="var(--ev-clean)" radius={[2, 2, 0, 0]} maxBarSize={16} isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      <p className="text-[10px] leading-snug text-zinc-500">
        {ex.cfe_grid_share_source === "inferred_from_grid_co2"
          ? "Clean share of grid imports inferred hour by hour from grid CO2 intensity against a gas-fleet rate (inferred; Simulate did not report it)."
          : ex.cfe_grid_share_source === "simulate"
            ? "Clean share of grid imports per hour from the simulation."
            : "Clean share of grid imports per hour as reported by the evaluation backend."}{" "}
        Hours are hour-beginning PST.
      </p>
    </section>
  );
}
