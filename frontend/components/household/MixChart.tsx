"use client";
// CAISO average-day generation mix (2024), stacked by resource group, in GW. Battery charging goes
// below zero (stackOffset "sign"), so the stack above zero is what serves load. OWNER: household.
import { useMemo } from "react";
import { Area, AreaChart, CartesianGrid, ReferenceLine, Tooltip, XAxis, YAxis } from "recharts";

import { TICK, TOOLTIP_CARD } from "@/components/evaluate/chartTheme";

import { ActiveChart, CHART_WRAP, TableView } from "./charts";
import { hourLabel, hourTick, niceTicks, num, pct0 } from "./fmt";
import { RESOURCE_GROUPS, resourceGroup, type ResourceGroup } from "./theme";
import { LegendRow } from "./ui";

export function MixChart({ mix, cleanShare }: { mix: Record<string, number[]>; cleanShare: number[] }) {
  const { rows, groups, ticks } = useMemo(() => {
    const sums: Record<ResourceGroup, number[]> = Object.fromEntries(RESOURCE_GROUPS.map((g) => [g.key, Array(24).fill(0)])) as Record<ResourceGroup, number[]>;
    for (const [k, series] of Object.entries(mix ?? {})) {
      const g = resourceGroup(k);
      for (let h = 0; h < 24; h++) sums[g][h] += num(series?.[h]) / 1000;
    }
    const present = RESOURCE_GROUPS.filter((g) => sums[g.key].some((v) => Math.abs(v) > 0.01));
    const rows = Array.from({ length: 24 }, (_, h) => {
      const r: Record<string, number> = { x: h + 0.5, h };
      for (const g of present) r[g.key] = sums[g.key][h];
      return r;
    });
    let lo = 0;
    let hi = 0;
    for (const r of rows) {
      let pos = 0;
      let neg = 0;
      for (const g of present) {
        if (r[g.key] >= 0) pos += r[g.key];
        else neg += r[g.key];
      }
      hi = Math.max(hi, pos);
      lo = Math.min(lo, neg);
    }
    return { rows, groups: present, ticks: niceTicks(lo, hi, 4) };
  }, [mix]);

  return (
    <div className={CHART_WRAP}>
      <div className="text-[10px] text-zinc-500 dark:text-zinc-400">GW, CAISO-wide (local Pacific clock time)</div>
      <div className="h-56">
        <ActiveChart>
          <AreaChart data={rows} stackOffset="sign" margin={{ top: 4, right: 6, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--ev-grid)" />
            <XAxis dataKey="x" type="number" domain={[0, 24]} ticks={[0, 3, 6, 9, 12, 15, 18, 21, 24]} interval={0} tickFormatter={hourTick} tick={TICK} tickLine={false} axisLine={{ stroke: "var(--ev-axis)" }} />
            <YAxis width={30} tick={TICK} tickLine={false} axisLine={false} ticks={ticks} domain={[ticks[0], ticks[ticks.length - 1]]} interval={0} tickFormatter={(v: number) => String(Math.round(v))} />
            {groups.map((g) => (
              <Area key={g.key} dataKey={g.key} name={g.label} stackId="mix" type="monotone" fill={g.color} fillOpacity={0.85} stroke="var(--hh-surface)" strokeWidth={0.75} activeDot={false} isAnimationActive={false} />
            ))}
            <ReferenceLine y={0} stroke="var(--ev-axis)" />
            <Tooltip
              cursor={{ stroke: "var(--ev-axis)", strokeWidth: 1 }}
              isAnimationActive={false}
              content={(p) => {
                if (!p.active || p.label === undefined) return null;
                const h = Math.floor(Number(p.label));
                const r = rows[h];
                if (!r) return null;
                return (
                  <div className={TOOLTIP_CARD}>
                    <div className="mb-0.5 text-zinc-500 dark:text-zinc-400">
                      {hourLabel(h)}–{hourLabel(h + 1)} · {pct0(num(cleanShare?.[h]))} carbon-free
                    </div>
                    {[...groups].reverse().map((g) => (
                      <div key={g.key} className="flex items-center gap-1.5 tabular-nums">
                        <span className="inline-block h-2 w-2 rounded-sm" style={{ background: g.color }} />
                        <span className="font-medium">{r[g.key].toFixed(1)} GW</span>
                        <span className="text-zinc-500 dark:text-zinc-400">{g.label}</span>
                      </div>
                    ))}
                  </div>
                );
              }}
            />
          </AreaChart>
        </ActiveChart>
      </div>
      <LegendRow items={[...groups].reverse().map((g) => ({ key: g.key, label: g.label, color: g.color }))} />
      <TableView
        summary="Table view (GW by hour, carbon-free share)"
        head={["Hour", ...groups.map((g) => g.label), "Carbon-free"]}
        rows={rows.map((r) => [hourLabel(r.h), ...groups.map((g) => r[g.key].toFixed(1)), pct0(num(cleanShare?.[r.h]))])}
      />
    </div>
  );
}
