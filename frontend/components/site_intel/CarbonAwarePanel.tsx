"use client";
// Carbon-aware flexible load: each day's flexible share moves to its cleanest hours.  OWNER: workstream E.
// Green Software Foundation: Carbon Aware SDK-style best window + SCI per GPU-hour.
import { useEffect, useRef, useState } from "react";
import { Area, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { Panel, Stat } from "@/components/shell/Panel";
import { post } from "@/lib/api";
import type { Provenance } from "@/lib/contract";
import { mwh, tons } from "@/lib/format";
import { useGridForge } from "@/lib/store";

// Response of POST /api/site/carbon-aware (backend/app/site_intel/carbon.py).
interface HourPoint {
  hour: number;
  baseline_mw: number;
  shifted_mw: number;
  marginal_kg_per_mwh: number;
  grid_kg_per_mwh: number;
}
interface DataPoint {
  location: string;
  timestamp: string;
  duration: number;
  value: number;
}
interface CarbonAwareResult {
  flexible_share: number;
  shifted_mwh_per_yr: number;
  baseline_t_co2e: number;
  shifted_t_co2e: number;
  avoided_t_co2e: number;
  avoided_pct: number;
  sci_g_per_gpu_hour_before: number | null;
  sci_g_per_gpu_hour_after: number | null;
  sci_inputs: Record<string, number>;
  day: number;
  hours: HourPoint[];
  best_window: { windowSize: number; optimalDataPoints: DataPoint[] };
  notes: string[];
  provenance: Provenance[];
}

const DEBOUNCE_MS = 250;

function dayLabel(year: number, day: number): string {
  return new Date(Date.UTC(year, 0, 1 + day)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function windowLabel(w: CarbonAwareResult["best_window"]): string | null {
  const p = w.optimalDataPoints[0];
  if (!p) return null;
  const start = Number(p.timestamp.slice(11, 13)); // timestamps are fixed UTC-8, "YYYY-MM-DDTHH:..."
  const end = (start + p.duration / 60) % 24;
  const hh = (h: number) => `${String(h).padStart(2, "0")}:00`;
  return `${hh(start)}–${hh(end)} PST at ${Math.round(p.value)} g CO₂/kWh`;
}

export function CarbonAwarePanel() {
  const { result } = useGridForge();
  const [share, setShare] = useState(() => result?.scenario.demand.flexible_share || 0.3);
  const [data, setData] = useState<CarbonAwareResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);

  // Re-run on every new result (auto-run replaces it without remounting) and slider move.
  useEffect(() => {
    if (!result) return;
    const my = ++seq.current;
    const timer = setTimeout(() => {
      setLoading(true);
      post<CarbonAwareResult>("/site/carbon-aware", { scenario: result.scenario, simulation: result.simulation, flexible_share: share })
        .then((r) => {
          if (my !== seq.current) return; // a newer request won
          setData(r);
          setError(null);
        })
        .catch((e: Error) => {
          if (my === seq.current) setError(e.message);
        })
        .finally(() => {
          if (my === seq.current) setLoading(false);
        });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [result, share]);

  if (!result) return null;
  const year = result.scenario.assumptions?.weather_year ?? 2024;
  const chart = data?.hours.map((h) => ({ hour: h.hour, baseline: h.baseline_mw, shifted: h.shifted_mw, marginal: h.marginal_kg_per_mwh })) ?? [];
  const sciBefore = data?.sci_g_per_gpu_hour_before;
  const sciAfter = data?.sci_g_per_gpu_hour_after;
  const best = data ? windowLabel(data.best_window) : null;

  return (
    <Panel title="Carbon-aware load" owner="E · Green Software">
      <label className="mb-3 block text-xs text-zinc-500">
        Flexible share of load: <span className="font-semibold text-zinc-800 dark:text-zinc-200">{Math.round(share * 100)}%</span>
        {loading && <span className="ml-2 text-zinc-400">updating…</span>}
        <input type="range" min={0} max={0.6} step={0.05} value={share} onChange={(e) => setShare(Number(e.target.value))} className="w-full" />
      </label>
      {error && <p className="mb-2 text-xs text-red-600">Carbon-aware shift failed: {error}</p>}
      {data && (
        <>
          <div className="mb-3 grid grid-cols-3 gap-3">
            <Stat label="Avoided CO₂e / yr" value={`${tons(data.avoided_t_co2e)} (${(data.avoided_pct * 100).toFixed(1)}%)`} />
            <Stat label="Load shifted / yr" value={mwh(data.shifted_mwh_per_yr)} />
            <Stat
              label="SCI, g CO₂e / GPU-hour"
              value={sciBefore != null && sciAfter != null ? `${Math.round(sciBefore)} → ${Math.round(sciAfter)}` : "–"}
            />
          </div>
          {data.avoided_pct < 0.01 && (
            <p className="mb-2 text-[11px] text-amber-700 dark:text-amber-400">
              Little to shift here: try Grid-connected or Renewable-heavy, where hourly carbon swings more.
            </p>
          )}
          <div className="mb-1 text-[11px] text-zinc-500">
            {dayLabel(year, data.day)} (the day this saves most){best && <> · best 4-h window {best}</>}
          </div>
          <div className="h-44">
            <ResponsiveContainer>
              <ComposedChart data={chart} margin={{ top: 4, right: 4, bottom: 0, left: -8 }}>
                <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.3} />
                <XAxis dataKey="hour" fontSize={11} tickFormatter={(h: number) => `${h}h`} />
                <YAxis yAxisId="mw" fontSize={11} domain={["auto", "auto"]} />
                <YAxis yAxisId="kg" orientation="right" fontSize={11} />
                <Tooltip
                  formatter={(v, name) => [name === "Marginal CO₂" ? `${Math.round(Number(v))} kg/MWh` : `${Math.round(Number(v))} MW`, name]}
                  labelFormatter={(h) => `${String(h).padStart(2, "0")}:00 PST`}
                />
                <Area yAxisId="mw" dataKey="shifted" name="Shifted load" stroke="#059669" fill="#10b981" fillOpacity={0.3} />
                <Line yAxisId="mw" dataKey="baseline" name="Baseline load" stroke="#52525b" strokeDasharray="4 3" dot={false} />
                <Line yAxisId="kg" dataKey="marginal" name="Marginal CO₂" stroke="#ea580c" dot={false} strokeWidth={1.5} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          <details className="mt-2 text-[11px] text-zinc-500">
            <summary className="cursor-pointer">Method and sources</summary>
            <ul className="mt-1 list-disc space-y-1 pl-4">
              {data.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
              {data.provenance.map((p) => (
                <li key={p.source}>
                  <span className="uppercase text-zinc-400">{p.kind}</span>{" "}
                  {p.url ? (
                    <a href={p.url} target="_blank" rel="noreferrer" className="underline">
                      {p.source}
                    </a>
                  ) : (
                    p.source
                  )}
                  {p.note && <span className="text-zinc-400"> · {p.note}</span>}
                </li>
              ))}
            </ul>
          </details>
        </>
      )}
    </Panel>
  );
}
