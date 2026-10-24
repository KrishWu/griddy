"use client";
// Shared Griddy Home charts, in the style of simulate/DispatchChart.tsx: thin 2px lines, recessive grid
// and axes, colors as CSS variables (chartTheme.ts + theme.ts) so Light, Dark and Mixed all work, a
// legend for every multi-series chart and a custom tooltip. Horizontal bar lists are plain HTML (value
// labels always visible, readable at 390 px). OWNER: household (frontend).
import { useMemo, type ReactElement, type ReactNode } from "react";
import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  ReferenceArea,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { CHART_VARS, TICK, TOOLTIP_CARD } from "@/components/evaluate/chartTheme";
import { usePanelActive } from "@/components/shell/panelActive";

import { hourLabel, hourTick, niceTicks, num } from "./fmt";
import { HH_VARS, MONTHS, periodBand, periodLabel } from "./theme";
import { LegendRow } from "./ui";

/** A ResponsiveContainer that renders only while its sidebar panel shows: hidden panels stay
 *  mounted (display: none) and would measure 0 x 0. The sized wrapper around it stays. */
export function ActiveChart({ children }: { children: ReactElement }) {
  return usePanelActive() ? (
    <ResponsiveContainer width="100%" height="100%">
      {children}
    </ResponsiveContainer>
  ) : null;
}

export const CHART_WRAP = `${CHART_VARS} ${HH_VARS}`;
const AXIS = { stroke: "var(--ev-axis)" };
const HOUR_TICKS = [0, 3, 6, 9, 12, 15, 18, 21, 24];

/** Contiguous runs of banded TOU periods over 24 hours: [{start, end, period}] with end exclusive. */
export function periodRuns(periods: string[] | undefined): { start: number; end: number; period: string }[] {
  if (!periods || periods.length !== 24) return [];
  const runs: { start: number; end: number; period: string }[] = [];
  for (let h = 0; h < 24; h++) {
    const p = periods[h];
    if (periodBand(p) <= 0) continue;
    const last = runs[runs.length - 1];
    if (last && last.end === h && last.period === p) last.end = h + 1;
    else runs.push({ start: h, end: h + 1, period: p });
  }
  return runs;
}

export interface DaySeries {
  key: string;
  label: string;
  color: string;
  values: number[];
  kind?: "line" | "area";
  dashed?: boolean;
  /** Thinner, for a de-emphasised comparison line. */
  thin?: boolean;
}

/** One average day, hour-beginning values drawn at mid-hour so a 4-9 pm band covers exactly 16:00-21:00. */
export function DayChart({
  series,
  periods,
  unit,
  format,
  height = "h-56",
  highlightHours,
  bandNote,
}: {
  series: DaySeries[];
  /** Weekday TOU periods for the bands (24 names). */
  periods?: string[];
  unit: string;
  format: (v: number) => string;
  height?: string;
  /** Hours to wash green (e.g. the cleanest hours). */
  highlightHours?: number[];
  bandNote?: ReactNode;
}) {
  const rows = useMemo(
    () =>
      Array.from({ length: 24 }, (_, h) => {
        const r: Record<string, number> = { x: h + 0.5, h };
        for (const s of series) r[s.key] = num(s.values[h]);
        return r;
      }),
    [series],
  );
  const runs = useMemo(() => periodRuns(periods), [periods]);
  const hl = useMemo(() => [...new Set(highlightHours ?? [])].filter((h) => h >= 0 && h < 24), [highlightHours]);
  const yTicks = useMemo(() => niceTicks(0, Math.max(0, ...series.flatMap((s) => s.values.map(num))), 4), [series]);
  return (
    <div className={CHART_WRAP}>
      <div className="text-[10px] text-zinc-500 dark:text-zinc-400">{unit}</div>
      <div className={height}>
        <ActiveChart>
          <ComposedChart data={rows} margin={{ top: 14, right: 6, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--ev-grid)" />
            {runs.map((r) => (
              <ReferenceArea
                key={`${r.period}-${r.start}`}
                x1={r.start}
                x2={r.end}
                fill="var(--hh-band)"
                fillOpacity={periodBand(r.period)}
                ifOverflow="hidden"
                label={{ value: periodLabel(r.period), position: "insideTop", fontSize: 9, fill: "var(--ev-muted)", offset: -12 }}
              />
            ))}
            {hl.map((h) => (
              <ReferenceArea key={`hl-${h}`} x1={h} x2={h + 1} fill="var(--hh-clean)" fillOpacity={0.12} ifOverflow="hidden" />
            ))}
            <XAxis
              dataKey="x"
              type="number"
              domain={[0, 24]}
              ticks={HOUR_TICKS}
              interval={0}
              tickFormatter={hourTick}
              tick={TICK}
              tickLine={false}
              axisLine={AXIS}
            />
            <YAxis
              width={36}
              tick={TICK}
              tickLine={false}
              axisLine={false}
              ticks={yTicks}
              domain={[yTicks[0], yTicks[yTicks.length - 1]]}
              interval={0}
              tickFormatter={(v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1))}
            />
            {series.map((s) =>
              s.kind === "area" ? (
                <Area
                  key={s.key}
                  dataKey={s.key}
                  name={s.label}
                  type="monotone"
                  stroke={s.color}
                  strokeWidth={1.5}
                  fill={s.color}
                  fillOpacity={0.3}
                  activeDot={false}
                  isAnimationActive={false}
                />
              ) : (
                <Line
                  key={s.key}
                  dataKey={s.key}
                  name={s.label}
                  type="monotone"
                  stroke={s.color}
                  strokeWidth={s.thin ? 1.25 : 2}
                  strokeDasharray={s.dashed ? "4 3" : undefined}
                  dot={false}
                  activeDot={{ r: 4, fill: s.color, stroke: "var(--hh-surface)", strokeWidth: 2 }}
                  isAnimationActive={false}
                />
              ),
            )}
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
                      {hourLabel(h)}–{hourLabel(h + 1)}
                      {periods?.[h] ? ` · ${periodLabel(periods[h])}` : ""}
                    </div>
                    {series.map((s) => (
                      <div key={s.key} className="flex items-center gap-1.5 tabular-nums">
                        <span className="inline-block w-2.5 border-t-2" style={{ borderColor: s.color }} />
                        <span className="font-medium">{format(r[s.key])}</span>
                        <span className="text-zinc-500 dark:text-zinc-400">{s.label}</span>
                      </div>
                    ))}
                  </div>
                );
              }}
            />
          </ComposedChart>
        </ActiveChart>
      </div>
      <LegendRow
        items={[
          ...series.map((s) => ({ key: s.key, label: s.label, color: s.color, line: s.kind !== "area", dashed: s.dashed })),
          ...(runs.length ? [{ key: "band", label: bandNote ?? "Shaded: peak-price hours (weekday)", color: "var(--hh-band)" }] : []),
        ]}
      />
    </div>
  );
}

/** Twelve monthly bars. */
export function MonthBars({ values, color, unit, format, height = "h-44" }: { values: number[]; color: string; unit: string; format: (v: number) => string; height?: string }) {
  const rows = useMemo(() => MONTHS.map((m, i) => ({ m, v: num(values[i]) })), [values]);
  const ticks = useMemo(() => niceTicks(0, Math.max(0, ...rows.map((r) => r.v)), 4), [rows]);
  return (
    <div className={CHART_WRAP}>
      <div className="text-[10px] text-zinc-500 dark:text-zinc-400">{unit}</div>
      <div className={height}>
        <ActiveChart>
          <BarChart data={rows} margin={{ top: 4, right: 4, bottom: 0, left: 0 }} barCategoryGap="18%">
            <CartesianGrid vertical={false} stroke="var(--ev-grid)" />
            <XAxis dataKey="m" tick={TICK} tickLine={false} axisLine={AXIS} interval={0} tickFormatter={(m: string) => m.slice(0, 1)} />
            <YAxis
              width={40}
              tick={TICK}
              tickLine={false}
              axisLine={false}
              ticks={ticks}
              domain={[ticks[0], ticks[ticks.length - 1]]}
              interval={0}
              tickFormatter={(v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(Math.round(v)))}
            />
            <Bar dataKey="v" fill={color} radius={[3, 3, 0, 0]} isAnimationActive={false} />
            <Tooltip
              cursor={{ fill: "var(--ev-cursor)" }}
              isAnimationActive={false}
              content={(p) => {
                const r = p.active ? rows.find((x) => x.m === p.label) : undefined;
                if (!r) return null;
                return (
                  <div className={TOOLTIP_CARD}>
                    <span className="text-zinc-500 dark:text-zinc-400">{r.m}</span> <span className="font-medium tabular-nums">{format(r.v)}</span>
                  </div>
                );
              }}
            />
          </BarChart>
        </ActiveChart>
      </div>
    </div>
  );
}

/** 24 hourly bars, each colored by a function of its hour (e.g. cleanest hours green). */
export function HourBars({ values, colorOf, unit, format, height = "h-48", legend }: { values: number[]; colorOf: (h: number) => string; unit: string; format: (v: number) => string; height?: string; legend?: ReactNode }) {
  const rows = useMemo(() => Array.from({ length: 24 }, (_, h) => ({ h, v: num(values[h]) })), [values]);
  const ticks = useMemo(() => niceTicks(0, Math.max(0, ...rows.map((r) => r.v)), 4), [rows]);
  return (
    <div className={CHART_WRAP}>
      <div className="text-[10px] text-zinc-500 dark:text-zinc-400">{unit}</div>
      <div className={height}>
        <ActiveChart>
          <BarChart data={rows} margin={{ top: 4, right: 4, bottom: 0, left: 0 }} barCategoryGap="12%">
            <CartesianGrid vertical={false} stroke="var(--ev-grid)" />
            <XAxis dataKey="h" tick={TICK} tickLine={false} axisLine={AXIS} ticks={[0, 3, 6, 9, 12, 15, 18, 21]} interval={0} tickFormatter={hourTick} />
            <YAxis width={40} tick={TICK} tickLine={false} axisLine={false} ticks={ticks} domain={[ticks[0], ticks[ticks.length - 1]]} interval={0} tickFormatter={(v: number) => String(Number(v.toFixed(3)))} />
            <Bar dataKey="v" radius={[2, 2, 0, 0]} isAnimationActive={false}>
              {rows.map((r) => (
                <Cell key={r.h} fill={colorOf(r.h)} />
              ))}
            </Bar>
            <Tooltip
              cursor={{ fill: "var(--ev-cursor)" }}
              isAnimationActive={false}
              content={(p) => {
                const r = p.active ? rows[Number(p.label)] : undefined;
                if (!r) return null;
                return (
                  <div className={TOOLTIP_CARD}>
                    <div className="text-zinc-500 dark:text-zinc-400">
                      {hourLabel(r.h)}–{hourLabel(r.h + 1)}
                    </div>
                    <div className="font-medium tabular-nums">{format(r.v)}</div>
                  </div>
                );
              }}
            />
          </BarChart>
        </ActiveChart>
      </div>
      {legend}
    </div>
  );
}

export interface HBarRow {
  key: string;
  label: ReactNode;
  value: number;
  display: string;
  color: string;
  /** Second line under the label. */
  note?: ReactNode;
  emphasis?: boolean;
  muted?: boolean;
}

/** Horizontal bars as HTML: label, bar, value; the longest bar spans the track. */
export function HBars({ rows, max, ariaLabel }: { rows: HBarRow[]; max?: number; ariaLabel: string }) {
  const top = Math.max(1e-9, max ?? Math.max(...rows.map((r) => Math.abs(num(r.value))), 0));
  return (
    <ul aria-label={ariaLabel} className={`space-y-1.5 ${CHART_WRAP}`}>
      {rows.map((r) => (
        <li key={r.key} className={`grid grid-cols-[minmax(6.5rem,38%)_minmax(0,1fr)_auto] items-center gap-2 text-xs ${r.muted ? "opacity-60" : ""}`}>
          <div className="min-w-0">
            <div className={`truncate ${r.emphasis ? "font-semibold text-zinc-900 dark:text-zinc-50" : "text-zinc-700 dark:text-zinc-300"}`}>{r.label}</div>
            {r.note && <div className="line-clamp-2 text-[10px] leading-tight text-zinc-500 dark:text-zinc-400" title={typeof r.note === "string" ? r.note : undefined}>{r.note}</div>}
          </div>
          <div className="h-2.5 rounded-sm bg-zinc-100 dark:bg-zinc-900">
            <div className="h-full rounded-sm" style={{ width: `${Math.max(0, Math.min(100, (Math.abs(num(r.value)) / top) * 100))}%`, background: r.color }} />
          </div>
          <div className={`text-right tabular-nums ${r.emphasis ? "font-semibold text-zinc-900 dark:text-zinc-50" : "text-zinc-700 dark:text-zinc-300"}`}>{r.display}</div>
        </li>
      ))}
    </ul>
  );
}

/** Collapsible table twin for a chart. */
export function TableView({ summary, head, rows }: { summary: string; head: string[]; rows: (string | number)[][] }) {
  return (
    <details className="mt-2 text-[11px]">
      <summary className="cursor-pointer select-none text-zinc-500 dark:text-zinc-400">{summary}</summary>
      <div className="mt-1 max-h-64 overflow-auto">
        <table className="w-full text-right tabular-nums">
          <thead className="sticky top-0 bg-white text-zinc-500 dark:bg-zinc-950 dark:text-zinc-400">
            <tr>
              {head.map((h, i) => (
                <th key={h} className={`px-1 py-0.5 font-normal ${i === 0 ? "text-left" : ""}`}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-t border-zinc-100 dark:border-zinc-800">
                {r.map((c, j) => (
                  <td key={j} className={`px-1 py-0.5 ${j === 0 ? "text-left text-zinc-500 dark:text-zinc-400" : "text-zinc-700 dark:text-zinc-300"}`}>
                    {c}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
