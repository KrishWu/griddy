"use client";
// Hourly dispatch chart + simulation summary.  OWNER: workstream B (Simulate + Stress Test).
// STUB: one selectable day as a stacked area chart.
import { useState } from "react";
import { Area, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { Panel, Stat } from "@/components/shell/Panel";
import { mw, mwh, pct } from "@/lib/format";
import { useGridForge } from "@/lib/store";

const SERIES: { key: string; label: string; color: string }[] = [
  { key: "solar_pv", label: "Solar", color: "#f59e0b" },
  { key: "onshore_wind", label: "Wind", color: "#0ea5e9" },
  { key: "battery", label: "Battery", color: "#8b5cf6" },
  { key: "gas_cc", label: "Gas CC", color: "#6b7280" },
  { key: "gas_ct", label: "Gas CT", color: "#9ca3af" },
  { key: "imports", label: "Grid imports", color: "#ef4444" },
];

export function SimulatePanel() {
  const { result } = useGridForge();
  const [day, setDay] = useState(196); // mid-July
  if (!result) return null;
  const h = result.simulation.hourly;
  const s = result.simulation.summary;
  const days = Math.floor(h.demand_mw.length / 24);
  const data = Array.from({ length: 24 }, (_, i) => {
    const t = day * 24 + i;
    return {
      hour: i,
      demand: h.demand_mw[t],
      solar_pv: h.generation_mw.solar_pv?.[t] ?? 0,
      onshore_wind: h.generation_mw.onshore_wind?.[t] ?? 0,
      battery: h.battery_discharge_mw[t],
      gas_cc: h.generation_mw.gas_cc?.[t] ?? 0,
      gas_ct: h.generation_mw.gas_ct?.[t] ?? 0,
      imports: h.imports_mw[t],
    };
  });
  return (
    <Panel title="Simulate" owner="B · Simulate">
      <div className="mb-3 grid grid-cols-3 gap-3">
        <Stat label="Demand" value={mwh(s.demand_mwh)} />
        <Stat label="On-site clean share" value={pct(s.onsite_clean_share)} />
        <Stat label="Peak import" value={mw(s.peak_import_mw)} />
      </div>
      <label className="mb-2 block text-xs text-zinc-500">
        Day {day + 1} of {days}
        <input type="range" min={0} max={days - 1} value={day} onChange={(e) => setDay(Number(e.target.value))} className="w-full" />
      </label>
      <div className="h-56">
        <ResponsiveContainer>
          <ComposedChart data={data}>
            <XAxis dataKey="hour" fontSize={11} />
            <YAxis fontSize={11} />
            <Tooltip />
            {SERIES.map((x) => (
              <Area key={x.key} dataKey={x.key} name={x.label} stackId="1" stroke={x.color} fill={x.color} fillOpacity={0.7} />
            ))}
            <Line dataKey="demand" name="Demand" stroke="#111827" dot={false} strokeWidth={2} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </Panel>
  );
}
