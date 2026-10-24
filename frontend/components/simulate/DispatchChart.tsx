"use client";
// Hourly dispatch chart for one visible window.  OWNER: workstream B (Simulate + Stress Test).
// Renders only the 24 (day) or 168 (week) visible points, never the full year. Supply
// stacks above zero, battery charge and exports stack below zero, curtailment is a pale
// dashed wash on top, demand is the dark line, battery SOC is a dashed line on the right
// axis (0-100% of the battery's MWh). The Y scale is fixed for the whole year so days
// compare while scrubbing.
import { memo, useMemo, useState } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import type { HourlySeries } from "@/lib/contract";

import { SERIES, compact, int, niceTicks, usdPerMwh, valueAt, windowRows, type Row, type YearScan } from "./dispatch";
import type { SimExtras } from "./extras";
import { fmtClock, fmtHour, fmtMonthDay, fmtWeekday, pointLabel, wallAt, type Clock } from "./time";

export type View = "day" | "week";

// Series + chrome colors as CSS variables, light and dark steps (validated together for
// adjacent-pair colorblind separation in the stack order of SERIES). Dark mode follows
// Tailwind's `dark:` variant like every other panel.
const THEME = [
  "[--gf-solar:#eda100] dark:[--gf-solar:#c98500]",
  "[--gf-wind:#1baf7a] dark:[--gf-wind:#199e70]",
  "[--gf-battery:#6250d6] dark:[--gf-battery:#9085e9]",
  "[--gf-gascc:#eb6834] dark:[--gf-gascc:#e46a35]",
  "[--gf-gasct:#a04a1c] dark:[--gf-gasct:#a3461c]",
  "[--gf-grid:#2a78d6] dark:[--gf-grid:#3987e5]",
  "[--gf-unmet:#e34948] dark:[--gf-unmet:#e66767]",
  "[--gf-muted:#a1a1aa] dark:[--gf-muted:#71717a]",
  "[--gf-ink:#18181b] dark:[--gf-ink:#f4f4f5]",
  "[--gf-gridline:#f4f4f5] dark:[--gf-gridline:#27272a]",
  "[--gf-axis:#d4d4d8] dark:[--gf-axis:#52525b]",
  "[--gf-tick:#71717a] dark:[--gf-tick:#a1a1aa]",
  "[--gf-surface:#ffffff] dark:[--gf-surface:#09090b]",
].join(" ");

const TICK = { fill: "var(--gf-tick)", fontSize: 10 };

export interface DispatchChartProps {
  hourly: HourlySeries;
  clock: Clock;
  /** Absolute index of the first visible point. */
  start: number;
  length: number;
  view: View;
  /** Absolute day index to shade in week view. */
  selectedDay: number;
  scan: YearScan;
  /** Battery energy capacity for the SOC axis (MWh). */
  socCapacityMwh: number;
  extras: SimExtras;
}

export const DispatchChart = memo(function DispatchChart(props: DispatchChartProps) {
  const { hourly, clock, start, length, view, selectedDay, scan, socCapacityMwh, extras } = props;
  const rows = useMemo(() => windowRows(hourly, start, length), [hourly, start, length]);
  const defs = useMemo(() => SERIES.filter((d) => scan.present[d.key]), [scan]);
  const showSoc = scan.present.soc || socCapacityMwh > 0;

  const mwTicks = useMemo(() => niceTicks(scan.loMw, scan.hiMw), [scan]);
  // SOC axis ends exactly at the battery's energy capacity (0 / 50 / 100%), so a full
  // battery touches the top of the plot. Round MWh ticks only when the capacity is unknown
  // or the engine's SOC exceeds it (the two disagree on duration).
  const socAxis = useMemo(() => {
    const cap = socCapacityMwh;
    if (cap > 0 && scan.socMaxMwh <= cap * 1.001) {
      return { ticks: [0, cap / 2, cap], fmt: (v: number) => `${Math.round((v / cap) * 100)}%`, unit: `SOC % of ${int(cap)} MWh` };
    }
    return { ticks: niceTicks(0, Math.max(cap, scan.socMaxMwh, 1), 2), fmt: compact, unit: "SOC MWh" };
  }, [socCapacityMwh, scan]);
  const socTicks = socAxis.ticks;

  const per = clock.perDay;
  const xTicks = useMemo(() => {
    if (view === "day") {
      const every = Math.max(1, Math.round(per / 8)); // every 3 h for hourly data
      return Array.from({ length: Math.ceil(length / every) }, (_, k) => k * every);
    }
    // Week view: weekday labels at each day's noon, dividers at midnight.
    return Array.from({ length: Math.ceil(length / per) }, (_, d) => d * per + Math.floor(per / 2)).filter((x) => x < length);
  }, [view, per, length]);
  const midnights = useMemo(
    () => (view === "week" ? Array.from({ length: Math.ceil(length / per) - 1 }, (_, d) => (d + 1) * per) : []),
    [view, per, length],
  );
  const shade = view === "week" ? selectedDay * per - start : -1;

  const tickLabel = (x: number) => {
    const d = wallAt(clock, start + x);
    return view === "day" ? fmtHour(d) : fmtWeekday(d);
  };

  return (
    <div className={THEME}>
      <div className="flex justify-between text-[10px] text-zinc-400">
        <span>MW</span>
        {showSoc && <span>{socAxis.unit}</span>}
      </div>
      <div className="h-60">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={rows} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
            <CartesianGrid yAxisId="mw" vertical={false} stroke="var(--gf-gridline)" />
            <XAxis
              dataKey="x"
              type="number"
              domain={[0, Math.max(1, length - 1)]}
              ticks={xTicks}
              interval={0}
              tickFormatter={tickLabel}
              tick={TICK}
              tickLine={false}
              axisLine={{ stroke: "var(--gf-axis)" }}
              allowDecimals={false}
            />
            <YAxis
              yAxisId="mw"
              width={34}
              domain={[mwTicks[0], mwTicks[mwTicks.length - 1]]}
              ticks={mwTicks}
              interval={0}
              tickFormatter={compact}
              tick={TICK}
              tickLine={false}
              axisLine={false}
            />
            {showSoc && (
              <YAxis
                yAxisId="soc"
                orientation="right"
                width={32} // fits "100%"
                domain={[0, socTicks[socTicks.length - 1]]}
                ticks={socTicks}
                interval={0}
                tickFormatter={socAxis.fmt}
                tick={TICK}
                tickLine={false}
                axisLine={false}
              />
            )}
            {shade >= 0 && shade < length && (
              <ReferenceArea
                yAxisId="mw"
                x1={shade}
                x2={Math.min(shade + per, length - 1)}
                fill="var(--gf-muted)"
                fillOpacity={0.12}
                ifOverflow="hidden"
                zIndex={-50} // behind the data, above the grid
              />
            )}
            {midnights.map((x) => (
              <ReferenceLine key={x} yAxisId="mw" x={x} stroke="var(--gf-gridline)" zIndex={-50} />
            ))}
            {defs.map((d) => {
              const wash = d.key === "curtailed";
              return (
                <Area
                  key={d.key}
                  yAxisId="mw"
                  dataKey={d.key}
                  name={d.label}
                  stackId={d.stack}
                  type="linear"
                  fill={d.color}
                  fillOpacity={wash ? 0.25 : d.stack === "neg" ? 0.55 : 0.85}
                  stroke={wash ? d.color : "var(--gf-surface)"}
                  strokeWidth={wash ? 1 : 0.75}
                  strokeDasharray={wash ? "3 2" : undefined}
                  activeDot={false}
                  isAnimationActive={false}
                />
              );
            })}
            <ReferenceLine yAxisId="mw" y={0} stroke="var(--gf-axis)" />
            <Line
              yAxisId="mw"
              dataKey="demand"
              name="Demand"
              type="linear"
              stroke="var(--gf-ink)"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4, fill: "var(--gf-ink)", stroke: "var(--gf-surface)", strokeWidth: 2 }}
              isAnimationActive={false}
            />
            {showSoc && (
              <Line
                yAxisId="soc"
                dataKey="soc"
                name="Battery SOC"
                type="linear"
                stroke="var(--gf-battery)"
                strokeWidth={1.5}
                strokeDasharray="4 3"
                dot={false}
                activeDot={false}
                isAnimationActive={false}
              />
            )}
            <Tooltip
              cursor={{ stroke: "var(--gf-axis)", strokeWidth: 1 }}
              isAnimationActive={false}
              content={(p) => (
                <DispatchTooltip
                  active={p.active}
                  label={p.label}
                  rows={rows}
                  defs={defs}
                  clock={clock}
                  hourly={hourly}
                  extras={extras}
                  showSoc={showSoc}
                  socCapacityMwh={socCapacityMwh}
                />
              )}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <Legend defs={defs} showSoc={showSoc} />
      <WindowTable rows={rows} defs={defs} clock={clock} hourly={hourly} view={view} showSoc={showSoc} />
    </div>
  );
});

type Defs = typeof SERIES;

function DispatchTooltip(props: {
  active: boolean;
  label: string | number | undefined;
  rows: Row[];
  defs: Defs;
  clock: Clock;
  hourly: HourlySeries;
  extras: SimExtras;
  showSoc: boolean;
  socCapacityMwh: number;
}) {
  const { active, label, rows, defs, clock, hourly, extras, showSoc, socCapacityMwh } = props;
  const r = active && label !== undefined ? rows[Math.round(Number(label))] : undefined;
  if (!r) return null;
  // Only series flowing this hour, so the readout stays short in the narrow column.
  const items = defs.filter((d) => Math.abs(r[d.key]) >= 0.5);
  const temp = extras.temperatureC?.[r.t];
  const cfe = extras.gridCfeShare?.[r.t];
  const context = [
    usdPerMwh(valueAt(hourly.price_usd_per_mwh, r.t)),
    `grid ${int(valueAt(hourly.grid_co2_kg_per_mwh, r.t))} kg CO2/MWh`,
    cfe !== undefined ? `${(cfe * 100).toFixed(0)}% CFE` : null,
    temp !== undefined ? `${temp.toFixed(0)} °C` : null,
  ].filter((s): s is string => s !== null);
  // Capped width so it never hides most of the ~360 px plot; the context line wraps.
  return (
    <div className="w-max max-w-[200px] rounded border border-zinc-200 bg-white/95 px-2 py-1.5 text-[11px] shadow-sm dark:border-zinc-700 dark:bg-zinc-900/95">
      <div className="mb-1 text-zinc-500">{pointLabel(clock, r.t)}</div>
      <div className="grid grid-cols-[auto_auto_1fr] items-center gap-x-1.5 leading-4">
        <Key color="var(--gf-ink)" />
        <span className="text-right font-semibold tabular-nums">{int(r.demand)}</span>
        <span className="text-zinc-500">MW demand</span>
        {items.map((d) => (
          <Row3 key={d.key} color={d.color} value={`${int(Math.abs(r[d.key]))}`} label={d.label} dashed={d.key === "curtailed"} />
        ))}
        {showSoc && (
          <Row3
            color="var(--gf-battery)"
            value={int(r.soc)}
            label={`MWh SOC${socCapacityMwh > 0 ? ` (${((r.soc / socCapacityMwh) * 100).toFixed(0)}%)` : ""}`}
            dashed
          />
        )}
      </div>
      <div className="mt-1 text-[10px] text-zinc-500">{context.join(" · ")}</div>
    </div>
  );
}

function Row3({ color, value, label, dashed }: { color: string; value: string; label: string; dashed?: boolean }) {
  return (
    <>
      <Key color={color} dashed={dashed} />
      <span className="text-right font-medium tabular-nums">{value}</span>
      <span className="text-zinc-500">{label}</span>
    </>
  );
}

/** Short line key: tooltip rows and line series in the legend. */
function Key({ color, dashed }: { color: string; dashed?: boolean }) {
  return <span className={`inline-block w-2.5 border-t-2 ${dashed ? "border-dashed" : ""}`} style={{ borderColor: color }} />;
}

/** "Battery ±" only when both halves are drawn; a lone below-zero half names itself. */
function legendText(d: Defs[number], defs: Defs) {
  if (defs.some((x) => x.legend === d.legend && x.stack !== d.stack)) {
    return (
      <>
        {d.legend} <span className="text-zinc-400">±</span>
      </>
    );
  }
  return d.stack === "neg" ? d.label : d.legend;
}

function Legend({ defs, showSoc }: { defs: Defs; showSoc: boolean }) {
  const seen = new Set<string>();
  const areas = defs.filter((d) => (seen.has(d.legend) ? false : (seen.add(d.legend), true)));
  return (
    <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-zinc-500">
      {areas.map((d) => (
        <li key={d.legend} className="flex items-center gap-1">
          <span
            className={`inline-block h-2 w-2 rounded-sm ${d.key === "curtailed" ? "border border-dashed" : ""}`}
            style={d.key === "curtailed" ? { borderColor: d.color, background: "transparent" } : { background: d.color }}
          />
          {legendText(d, defs)}
        </li>
      ))}
      <li className="flex items-center gap-1">
        <Key color="var(--gf-ink)" />
        Demand
      </li>
      {showSoc && (
        <li className="flex items-center gap-1">
          <Key color="var(--gf-battery)" dashed />
          SOC (right axis)
        </li>
      )}
    </ul>
  );
}

/** Table twin of the visible window. Rendered only while open (168 rows in week view). */
function WindowTable(props: { rows: Row[]; defs: Defs; clock: Clock; hourly: HourlySeries; view: View; showSoc: boolean }) {
  const { rows, defs, clock, hourly, view, showSoc } = props;
  const [open, setOpen] = useState(false);
  return (
    <details className="mt-2 text-[11px]" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="cursor-pointer select-none text-zinc-500">Table view ({rows.length} hours, MW)</summary>
      {open && (
        <div className="mt-1 max-h-64 overflow-auto">
          <table className="w-full text-right tabular-nums">
            <thead className="sticky top-0 bg-white text-zinc-500 dark:bg-zinc-950">
              <tr>
                <th className="py-0.5 pr-2 text-left font-normal">PST</th>
                <th className="px-1 font-normal">Demand</th>
                {defs.map((d) => (
                  <th key={d.key} className="px-1 font-normal">
                    {d.short}
                  </th>
                ))}
                {showSoc && <th className="px-1 font-normal">SOC MWh</th>}
                <th className="pl-1 font-normal">$/MWh</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const d = wallAt(clock, r.t);
                return (
                  <tr key={r.t} className="border-t border-zinc-100 dark:border-zinc-800">
                    <td className="py-0.5 pr-2 text-left whitespace-nowrap text-zinc-500">
                      {view === "week" ? `${fmtMonthDay(d)} ` : ""}
                      {fmtClock(d)}
                    </td>
                    <td className="px-1">{int(r.demand)}</td>
                    {defs.map((s) => (
                      <td key={s.key} className="px-1">
                        {int(Math.abs(r[s.key]))}
                      </td>
                    ))}
                    {showSoc && <td className="px-1">{int(r.soc)}</td>}
                    <td className="pl-1">{int(valueAt(hourly.price_usd_per_mwh, r.t))}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </details>
  );
}
