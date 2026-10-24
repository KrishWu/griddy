"use client";
// Side-by-side comparison of the presets (plus "Your scenario" when it differs),
// all on the same site and demand.  OWNER: workstream D (Build + Report + UI).
import { useEffect } from "react";
import { Area, ComposedChart, Line, ResponsiveContainer } from "recharts";

import { ComparisonTable } from "@/components/evaluate/ComparisonTable";
import { Panel } from "@/components/shell/Panel";
import type { ScenarioResult } from "@/lib/contract";
import { pct, tons, usd } from "@/lib/format";
import { useGridForge } from "@/lib/store";

import { ASSET_META } from "./assetMeta";

const JULY_DAY = 196;
const STACK = [
  { key: "solar_pv", color: ASSET_META.solar_pv.color },
  { key: "onshore_wind", color: ASSET_META.onshore_wind.color },
  { key: "battery", color: ASSET_META.battery.color },
  { key: "gas_cc", color: ASSET_META.gas_cc.color },
  { key: "gas_ct", color: ASSET_META.gas_ct.color },
  { key: "imports", color: "#ef4444" },
] as const;

function dayData(r: ScenarioResult) {
  const h = r.simulation.hourly;
  return Array.from({ length: 24 }, (_, i) => {
    const t = JULY_DAY * 24 + i;
    return {
      demand: h.demand_mw[t],
      solar_pv: h.generation_mw.solar_pv?.[t] ?? 0,
      onshore_wind: h.generation_mw.onshore_wind?.[t] ?? 0,
      battery: h.battery_discharge_mw[t],
      gas_cc: h.generation_mw.gas_cc?.[t] ?? 0,
      gas_ct: h.generation_mw.gas_ct?.[t] ?? 0,
      imports: h.imports_mw[t],
    };
  });
}

function ScenarioCard({ r, onLoad }: { r: ScenarioResult; onLoad?: () => void }) {
  const s = r.simulation.summary;
  const e = r.evaluation.economics;
  return (
    <div className="flex flex-col rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
      <div className="mb-1">
        <h3 className="truncate text-sm font-semibold" title={r.scenario.name}>
          {r.scenario.name}
        </h3>
        {onLoad ? (
          <button className="text-[11px] text-emerald-700 hover:underline dark:text-emerald-400" onClick={onLoad}>
            Load into builder
          </button>
        ) : (
          <span className="text-[11px] text-zinc-500">Current builder settings</span>
        )}
      </div>
      <div className="h-24">
        <ResponsiveContainer>
          <ComposedChart data={dayData(r)} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
            {STACK.map((x) => (
              <Area key={x.key} dataKey={x.key} stackId="1" stroke="none" fill={x.color} fillOpacity={0.8} isAnimationActive={false} />
            ))}
            <Line dataKey="demand" stroke="currentColor" dot={false} strokeWidth={1.5} isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <p className="mb-2 text-[10px] text-zinc-500">A July day, hour by hour</p>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
        <dt className="text-zinc-500">CAPEX</dt>
        <dd className="text-right tabular-nums">{usd(e.capex_total_usd)}</dd>
        <dt className="text-zinc-500">LCOE</dt>
        <dd className="text-right tabular-nums">${e.lcoe_usd_per_mwh.toFixed(0)}/MWh</dd>
        <dt className="text-zinc-500">CO2e / yr</dt>
        <dd className="text-right tabular-nums">{tons(r.evaluation.emissions.annual_t_co2e)}</dd>
        <dt className="text-zinc-500">On-site clean</dt>
        <dd className="text-right tabular-nums">{pct(s.onsite_clean_share)}</dd>
        <dt className="text-zinc-500">Unmet hours</dt>
        <dd className={`text-right tabular-nums ${s.hours_unmet ? "font-semibold text-red-600" : ""}`}>{s.hours_unmet}</dd>
      </dl>
    </div>
  );
}

export function CompareView() {
  const { compareResults, comparing, compareStale, runCompare, setScenario, setView, scenario } = useGridForge();

  // First visit: compute the comparison once; after that the user re-runs explicitly.
  useEffect(() => {
    if (!compareResults && scenario) void runCompare();
  }, [compareResults, scenario, runCompare]);

  return (
    <div className="space-y-3 p-3">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-base font-semibold">Compare scenarios</h2>
        <span className="text-xs text-zinc-500">Same site and demand · illustrative configurations</span>
        {compareStale && !comparing && <span className="text-xs text-amber-600">Your scenario changed since this comparison</span>}
        <button
          className="ml-auto rounded bg-emerald-600 px-3 py-1 text-sm font-semibold text-white disabled:opacity-50"
          onClick={() => void runCompare()}
          disabled={comparing}
        >
          {comparing ? "Comparing..." : compareResults ? "Re-run comparison" : "Run comparison"}
        </button>
      </div>

      {!compareResults ? (
        <p className="text-sm text-zinc-500">{comparing ? "Simulating every scenario..." : "Run the comparison to see the presets side by side."}</p>
      ) : (
        <>
          <div className={`grid gap-3 ${compareResults.length > 3 ? "md:grid-cols-4" : "md:grid-cols-3"}`}>
            {compareResults.map((r) => (
              <ScenarioCard
                key={r.scenario.id}
                r={r}
                onLoad={
                  r.scenario.id === "custom"
                    ? undefined
                    : () => {
                        setScenario(r.scenario);
                        setView("single");
                      }
                }
              />
            ))}
          </div>
          <Panel title="Side by side" owner="C · Evaluate">
            <ComparisonTable results={compareResults} />
          </Panel>
        </>
      )}
    </div>
  );
}
