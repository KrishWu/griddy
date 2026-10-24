"use client";
// Peak demand trajectory per load region, indexed to the base year so a 700 MW district and a 25 GW
// utility area share one axis. The selected region is the accent line (P50) with its P90 as a band
// and dashed line; the other regions are recessive context lines. Region chips below pick the
// highlighted region and double as the legend.  OWNER: workstream A.
import { useMemo } from "react";
import { Area, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import type { RegionForecast } from "@/lib/contract";
import { mw } from "@/lib/format";

import { regionShort, signedMw, signedPct, trajectory } from "./forecastData";

// Chart colors as CSS variables with light and dark steps (Tailwind's dark: variant, like the other
// panels). Accent = categorical slot 1 (blue), validated against both drawer surfaces.
export const CHART_THEME = [
  "[--fc-accent:#2a78d6] dark:[--fc-accent:#3987e5]",
  "[--fc-dc:#eb6834] dark:[--fc-dc:#d95926]",
  "[--fc-context:#b4b4bc] dark:[--fc-context:#52525b]",
  "[--fc-grid:#f4f4f5] dark:[--fc-grid:#27272a]",
  "[--fc-axis:#d4d4d8] dark:[--fc-axis:#3f3f46]",
  "[--fc-tick:#71717a] dark:[--fc-tick:#a1a1aa]",
  "[--fc-surface:#ffffff] dark:[--fc-surface:#09090b]",
].join(" ");

const TICK = { fill: "var(--fc-tick)", fontSize: 10 } as const;
const P90_SHOWN_MW = 0.5; // P90 above P50 by less than this is drawn as one line

type Row = Record<string, number | number[]>;

interface Series {
  region: string;
  name: string;
  base: number;
}

/** Evenly spaced "nice" percent ticks covering [lo, hi] (fractions), always including 0. */
function pctTicks(lo: number, hi: number): number[] {
  const min = Math.min(0, lo);
  const max = Math.max(hi, min + 0.01);
  const span = max - min;
  const step = [0.01, 0.02, 0.05, 0.1, 0.2, 0.25, 0.5, 1].find((s) => span / s <= 5) ?? 1;
  const out: number[] = [];
  for (let v = Math.floor(min / step) * step; v < max + step - 1e-9; v += step) out.push(Math.round(v * 1000) / 1000);
  return out;
}

function yearTicks(from: number, to: number): number[] {
  if (to <= from) return [from];
  const span = to - from;
  const every = span <= 6 ? 1 : span <= 12 ? 2 : span <= 20 ? 5 : 10;
  const ticks = [from];
  // Interior ticks on round years, never crowding the two end labels.
  for (let y = Math.ceil((from + 1) / every) * every; y < to; y += every) if (y - from >= every * 0.75 && to - y >= every * 0.75) ticks.push(y);
  ticks.push(to);
  return ticks;
}

const pctTick = (v: number) => `${Math.round(v * 100)}%`;

export function RegionChart({ regions, selected, onSelect, baseYear }: { regions: RegionForecast[]; selected: string; onSelect: (r: string) => void; baseYear: number }) {
  const { rows, series, ticks, years, showP90, sel } = useMemo(() => {
    const byYear = new Map<number, Row>();
    const series: Series[] = [];
    let lo = 0;
    let hi = 0;
    let showP90 = false;
    for (const r of regions) {
      const base = r.base_peak_mw;
      if (!(base > 0)) continue;
      series.push({ region: r.region, name: r.name, base });
      for (const t of trajectory(r)) {
        const row = byYear.get(t.year) ?? { year: t.year };
        const p50 = t.p50 / base - 1;
        row[r.region] = p50;
        row[`${r.region}:mw`] = t.p50;
        lo = Math.min(lo, p50);
        hi = Math.max(hi, p50);
        if (r.region === selected) {
          const p90 = t.p90 / base - 1;
          row.band = [p50, p90];
          row.p90 = p90;
          row["p90:mw"] = t.p90;
          hi = Math.max(hi, p90);
          if (t.p90 - t.p50 >= P90_SHOWN_MW) showP90 = true;
        }
        byYear.set(t.year, row);
      }
    }
    const rows = [...byYear.values()].sort((a, b) => (a.year as number) - (b.year as number));
    const first = (rows[0]?.year as number | undefined) ?? baseYear;
    const last = (rows[rows.length - 1]?.year as number | undefined) ?? baseYear;
    return { rows, series, ticks: pctTicks(lo, hi), years: yearTicks(first, last), showP90, sel: series.find((s) => s.region === selected) ?? null };
  }, [regions, selected, baseYear]);

  if (!rows.length || !series.length) return null;
  const selRegion = regions.find((r) => r.region === selected);
  const others = series.filter((s) => s.region !== selected);
  const lastYear = years[years.length - 1];
  const sorted = [...regions].filter((r) => r.base_peak_mw > 0).sort((a, b) => b.growth_peak_mw_p90 - a.growth_peak_mw_p90);

  return (
    <div className={CHART_THEME}>
      {selRegion && (
        <p className="mb-1 text-xs text-zinc-600 dark:text-zinc-400">
          <span className="font-medium text-zinc-900 dark:text-zinc-100">{selRegion.name}</span>: {mw(selRegion.base_peak_mw)} in {baseYear} →{" "}
          <span className="font-medium tabular-nums text-zinc-900 dark:text-zinc-100">{mw(selRegion.peak_mw_p50)}</span> P50
          {selRegion.peak_mw_p90 - selRegion.peak_mw_p50 >= P90_SHOWN_MW && <span className="tabular-nums"> · {mw(selRegion.peak_mw_p90)} P90</span>} by {lastYear}
        </p>
      )}
      <div className="flex justify-between text-[10px] text-zinc-400">
        <span>Peak demand, % change vs {baseYear}</span>
      </div>
      <div className="h-48">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={rows} margin={{ top: 6, right: 16, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--fc-grid)" />
            <XAxis
              dataKey="year"
              type="number"
              domain={[years[0], lastYear]}
              ticks={years}
              interval={0}
              tick={TICK}
              tickLine={false}
              axisLine={{ stroke: "var(--fc-axis)" }}
              allowDecimals={false}
            />
            <YAxis
              width={36}
              domain={[ticks[0], ticks[ticks.length - 1]]}
              ticks={ticks}
              interval={0}
              tickFormatter={pctTick}
              tick={TICK}
              tickLine={false}
              axisLine={false}
            />
            {others.map((s) => (
              <Line
                key={s.region}
                dataKey={s.region}
                name={regionShort(s.region)}
                type="linear"
                stroke="var(--fc-context)"
                strokeWidth={1}
                dot={false}
                activeDot={false}
                isAnimationActive={false}
              />
            ))}
            {showP90 && (
              <Area dataKey="band" type="linear" stroke="none" fill="var(--fc-accent)" fillOpacity={0.15} activeDot={false} isAnimationActive={false} />
            )}
            {showP90 && (
              <Line dataKey="p90" type="linear" stroke="var(--fc-accent)" strokeWidth={1.5} strokeDasharray="4 3" dot={false} activeDot={false} isAnimationActive={false} />
            )}
            {sel && (
              <Line
                dataKey={sel.region}
                name={regionShort(sel.region)}
                type="linear"
                stroke="var(--fc-accent)"
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4, fill: "var(--fc-accent)", stroke: "var(--fc-surface)", strokeWidth: 2 }}
                isAnimationActive={false}
              />
            )}
            <Tooltip
              cursor={{ stroke: "var(--fc-axis)", strokeWidth: 1 }}
              isAnimationActive={false}
              content={(p) => <ChartTooltip active={p.active} label={p.label} rows={rows} sel={sel} others={others} showP90={showP90} />}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <ul className="mt-1.5 flex items-center gap-3 text-[10px] text-zinc-500 dark:text-zinc-400">
        <li className="flex items-center gap-1">
          <span aria-hidden className="inline-block w-4 border-t-2" style={{ borderColor: "var(--fc-accent)" }} />
          {sel ? regionShort(sel.region) : "Selected"} P50
        </li>
        {showP90 && (
          <li className="flex items-center gap-1">
            <span aria-hidden className="inline-block w-4 border-t-2 border-dashed" style={{ borderColor: "var(--fc-accent)" }} />
            P90 (hot-weather peak)
          </li>
        )}
        <li className="flex items-center gap-1">
          <span aria-hidden className="inline-block w-4 border-t" style={{ borderColor: "var(--fc-context)" }} />
          Other regions
        </li>
      </ul>
      {/* Region picker; also the per-region numbers (new P90 peak by the target year). */}
      <div className="mt-2 flex flex-wrap gap-1" role="group" aria-label="Highlight a load region">
        {sorted.map((r) => {
          const on = r.region === selected;
          return (
            <button
              key={r.region}
              type="button"
              onClick={() => onSelect(r.region)}
              aria-pressed={on}
              title={`${r.name}: ${signedMw(r.growth_peak_mw_p90)} P90 peak by ${lastYear}`}
              className={`rounded-full px-2 py-0.5 text-[11px] ring-1 transition-colors ${
                on
                  ? "bg-[color-mix(in_srgb,var(--fc-accent)_12%,transparent)] font-medium text-zinc-900 ring-[var(--fc-accent)] dark:text-zinc-100"
                  : "text-zinc-600 ring-zinc-200 hover:bg-zinc-50 dark:text-zinc-300 dark:ring-zinc-700 dark:hover:bg-zinc-900"
              }`}
            >
              {regionShort(r.region)} <span className="tabular-nums text-zinc-500 dark:text-zinc-400">{signedMw(r.growth_peak_mw_p90)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ChartTooltip(props: { active: boolean; label: string | number | undefined; rows: Row[]; sel: Series | null; others: Series[]; showP90: boolean }) {
  const { active, label, rows, sel, others, showP90 } = props;
  const row = active && label !== undefined ? rows.find((r) => r.year === Number(label)) : undefined;
  if (!row) return null;
  const num = (k: string) => (typeof row[k] === "number" ? (row[k] as number) : null);
  const ranked = others
    .map((s) => ({ s, v: num(s.region) }))
    .filter((x): x is { s: Series; v: number } => x.v !== null)
    .sort((a, b) => b.v - a.v);
  return (
    <div className="w-max max-w-[220px] rounded-md border border-zinc-200 bg-white/95 px-2 py-1.5 text-[11px] leading-snug text-zinc-700 shadow-md dark:border-zinc-700 dark:bg-zinc-900/95 dark:text-zinc-200">
      <div className="mb-0.5 text-zinc-500">{String(row.year)}</div>
      {sel && num(sel.region) !== null && (
        <div>
          <span className="font-semibold">{regionShort(sel.region)}</span>{" "}
          <span className="tabular-nums">
            {mw(num(`${sel.region}:mw`) ?? 0)} P50 ({signedPct(num(sel.region))})
          </span>
          {showP90 && num("p90:mw") !== null && <div className="tabular-nums text-zinc-500">{mw(num("p90:mw") ?? 0)} P90</div>}
        </div>
      )}
      {ranked.length > 0 && (
        <div className="mt-1 grid grid-cols-[auto_auto] gap-x-2 text-zinc-500 dark:text-zinc-400">
          {ranked.map(({ s, v }) => (
            <span key={s.region} className="contents">
              <span>{regionShort(s.region)}</span>
              <span className="text-right tabular-nums">{signedPct(v)}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
