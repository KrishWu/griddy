"use client";
// Net-present-cost waterfall from extras.npc_breakdown: CAPEX by asset -> replacements
// -> salvage -> PV of each OPEX category -> NPC total. Horizontal (rows read top to
// bottom) so long asset names fit the ~360px column. Floating steps use the invisible
// stacked-base technique: a transparent bar from 0 to the step's low end, then the
// visible step on top, so negative steps (salvage, export credit) go back down.
// OWNER: workstream C (Evaluate).
import {
  Bar,
  BarChart,
  CartesianGrid,
  LabelList,
  Rectangle,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type BarShapeProps,
  type TooltipContentProps,
  type YAxisTickContentProps,
} from "recharts";

import { Term } from "@/components/glossary/Term";
import { usePanelActive } from "@/components/shell/panelActive";
import { usd } from "@/lib/format";

import { CHART_VARS, TICK, TOOLTIP_CARD } from "./chartTheme";
import type { NpcCategory, NpcItem } from "./extras";
import { compactUsd, signedUsd } from "./fmt";

type Group = "capital" | "operating" | "credit" | "total";

interface Row {
  key: string;
  /** Full label (tooltip). */
  label: string;
  /** Axis label, short enough for the ~118px category axis. */
  short: string;
  group: Group;
  usd: number;
  /** Transparent stacked base: the step's low end. */
  base: number;
  /** Visible step length (always >= 0). */
  delta: number;
  /** Running total after this step. */
  end: number;
  parts: { label: string; usd: number }[];
  display: string;
}

const GROUP_OF: Record<NpcCategory, Group> = {
  capex: "capital",
  replacement: "capital",
  salvage: "credit",
  fixed_om: "operating",
  var_om: "operating",
  fuel: "operating",
  purchased_power: "operating",
  carbon: "operating",
  export_revenue: "credit",
};

const GROUP_LABEL: Record<Group, string> = {
  capital: "Capital",
  operating: "Operating (PV)",
  credit: "Credits",
  total: "Net present cost",
};

const AGG_LABEL: Record<Exclude<NpcCategory, "capex">, string> = {
  replacement: "Replacements",
  salvage: "Salvage value",
  fixed_om: "Fixed O&M",
  var_om: "Variable O&M",
  fuel: "Fuel",
  purchased_power: "Purchased power",
  carbon: "Carbon cost",
  export_revenue: "Export credit",
};

const AGG_ORDER: Exclude<NpcCategory, "capex">[] = [
  "replacement",
  "salvage",
  "fixed_om",
  "var_om",
  "fuel",
  "purchased_power",
  "carbon",
  "export_revenue",
];

const cleanLabel = (s: string) => s.replace(/^\s*capex\s*[:\-–·]\s*/i, "").trim() || s;

const KIND_SHORT: [RegExp, string][] = [
  [/^gas combined[- ]cycle\b/i, "Gas CC"],
  [/^gas combustion turbine\b/i, "Gas CT"],
  [/^battery storage\b/i, "Battery"],
  [/^onshore wind\b/i, "Wind"],
];
const num = (s: string) => Number(s.replace(/,/g, ""));
const trimNum = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1).replace(/\.0$/, ""));

/**
 * Compact axis label for a CAPEX row: "Battery storage 300 MW / 1,200 MWh (batt-1)" ->
 * "Battery 300 MW × 4 h", "Interconnection: 230 kV double-circuit lattice line (15.0 km)"
 * -> "230 kV line, 15 km". Labels it doesn't recognize pass through (the axis truncates them).
 */
export function shortCapexLabel(label: string, keepId = false): string {
  const s = cleanLabel(label);
  const ic = s.match(/^interconnection:\s*(.+)$/i);
  if (ic) {
    const rest = ic[1];
    const kv = rest.match(/(\d+(?:\.\d+)?)\s*kV/i)?.[1];
    const km = rest.match(/\(([\d.,]+)\s*km\)/i)?.[1];
    if (/substation|switching station/i.test(rest)) return kv ? `${kv} kV substation` : "Substation";
    if (/\bline\b/i.test(rest)) return `${kv ? `${kv} kV ` : ""}line${km ? `, ${trimNum(num(km))} km` : ""}`;
    return rest;
  }
  const id = s.match(/\s*(\([A-Za-z0-9_.:-]+\))\s*$/);
  let out = id ? s.slice(0, id.index).trim() : s;
  for (const [re, abbr] of KIND_SHORT) out = out.replace(re, abbr);
  const batt = out.match(/^(.*?)([\d,.]+)\s*MW\s*\/\s*([\d,.]+)\s*MWh\s*$/i);
  if (batt && num(batt[2]) > 0) out = `${batt[1]}${batt[2]} MW × ${trimNum(num(batt[3]) / num(batt[2]))} h`;
  return keepId && id ? `${out} ${id[1]}` : out;
}

/** Inside a category's tooltip, "Salvage: Solar PV ..." reads better as "Solar PV ...". */
const partLabel = (s: string) => s.replace(/^(replacement|salvage|fixed o&m|variable o&m|natural gas|fuel|carbon|export)\s*:\s*/i, "");

/** Order and aggregate the breakdown, then compute each floating step. */
export function buildWaterfall(items: NpcItem[]): { rows: Row[]; total: number } {
  const steps: Omit<Row, "base" | "delta" | "end" | "display">[] = [];
  const capex = items.filter((i) => i.category === "capex");
  const shorts = capex.map((i) => shortCapexLabel(i.label));
  capex.forEach((i, n) => {
    // Two assets of one kind and size would share a short label: keep their ids to tell them apart.
    const dup = shorts.indexOf(shorts[n]) !== shorts.lastIndexOf(shorts[n]);
    steps.push({
      key: `capex-${n}`,
      label: cleanLabel(i.label),
      short: dup ? shortCapexLabel(i.label, true) : shorts[n],
      group: "capital",
      usd: i.usd,
      parts: [],
    });
  });
  for (const cat of AGG_ORDER) {
    const parts = items.filter((i) => i.category === cat);
    if (!parts.length) continue;
    const sum = parts.reduce((s, i) => s + i.usd, 0);
    steps.push({
      key: cat,
      label: AGG_LABEL[cat],
      short: AGG_LABEL[cat],
      group: GROUP_OF[cat],
      usd: sum,
      parts: parts.map((p) => ({ label: partLabel(p.label), usd: p.usd })),
    });
  }
  const rows: Row[] = [];
  let run = 0;
  for (const s of steps) {
    if (Math.abs(s.usd) < 0.5) continue; // a $0 step (e.g. no carbon price) is noise
    const start = run;
    run += s.usd;
    rows.push({ ...s, base: Math.min(start, run), delta: Math.abs(s.usd), end: run, display: signedUsd(s.usd) });
  }
  rows.push({
    key: "npc",
    label: "Net present cost",
    short: "Net present cost",
    group: "total",
    usd: run,
    base: Math.min(0, run),
    delta: Math.abs(run),
    end: run,
    parts: [],
    display: usd(run),
  });
  return { rows, total: run };
}

const truncate = (s: string, n = 22) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** Single-line category label (Recharts' default tick wraps to the axis width); full text on hover. */
function CategoryTick({ x, y, payload }: YAxisTickContentProps) {
  const full = String(payload?.value ?? "");
  return (
    <text x={Number(x)} y={Number(y)} dy={3.5} textAnchor="end" fill="var(--ev-muted)" fontSize={10}>
      <title>{full}</title>
      {truncate(full)}
    </text>
  );
}

function StepShape(p: BarShapeProps) {
  const row = p.payload as Row | undefined;
  const r = 3;
  // Round only the data end: the right end for increases and totals, the left end for credits.
  const radius: [number, number, number, number] = row && row.usd < 0 && row.group !== "total" ? [r, 0, 0, r] : [0, r, r, 0];
  const width = Math.max(p.width, 1.5);
  return (
    <Rectangle
      x={p.x}
      y={p.y}
      width={width}
      height={p.height}
      radius={radius}
      fill={`var(--ev-${row?.group ?? "capital"})`}
      opacity={p.isActive ? 0.85 : 1}
    />
  );
}

function StepTooltip({ active, payload }: TooltipContentProps) {
  const row = payload?.find((x) => x?.payload)?.payload as Row | undefined;
  if (!active || !row) return null;
  const parts = row.parts.length > 1 ? [...row.parts].sort((a, b) => Math.abs(b.usd) - Math.abs(a.usd)).slice(0, 6) : [];
  return (
    <div className={`${TOOLTIP_CARD} max-w-[240px]`}>
      <div className="text-sm font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">{row.display}</div>
      <div className="text-zinc-700 dark:text-zinc-300">{row.label}</div>
      <div className="text-[10px] text-zinc-500">
        {GROUP_LABEL[row.group]} · present value{row.group !== "total" && <> · running total {usd(row.end)}</>}
      </div>
      {parts.length > 0 && (
        <ul className="mt-1 space-y-0.5 border-t border-zinc-100 pt-1 dark:border-zinc-800">
          {parts.map((p, i) => (
            <li key={i} className="flex justify-between gap-2">
              <span className="min-w-0 text-zinc-500">{p.label}</span>
              <span className="shrink-0 whitespace-nowrap tabular-nums">{signedUsd(p.usd)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function CostWaterfall({
  breakdown,
  npcUsd,
  years,
  rate,
  dollarYear,
}: {
  breakdown: NpcItem[];
  npcUsd: number;
  years: number;
  rate: number;
  dollarYear?: number;
}) {
  const { rows, total } = buildWaterfall(breakdown);
  const shown = usePanelActive(); // hidden sidebar tab: no chart (it would measure 0 x 0)
  const groups = (["capital", "operating", "credit", "total"] as Group[]).filter((g) => rows.some((r) => r.group === g));
  const mismatch = Math.abs(total - npcUsd) > Math.max(1, Math.abs(npcUsd) * 0.005);
  const height = rows.length * 24 + 26;

  return (
    <figure className={CHART_VARS}>
      <figcaption className="mb-1 flex flex-wrap items-baseline justify-between gap-x-2">
        <span className="text-xs font-semibold text-zinc-700 dark:text-zinc-300">
          <Term k="npc">Net present cost</Term> build-up
        </span>
        <span className="text-[10px] text-zinc-500">
          PV, {years} yr @ {(rate * 100).toFixed(1).replace(/\.0$/, "")}% real{dollarYear ? `, ${dollarYear} $` : ""}
        </span>
      </figcaption>
      <ul className="mb-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-zinc-600 dark:text-zinc-400" aria-label="Legend">
        {groups.map((g) => (
          <li key={g} className="flex items-center gap-1">
            <span className="h-2 w-2.5 rounded-[2px]" style={{ background: `var(--ev-${g})` }} aria-hidden />
            {GROUP_LABEL[g]}
          </li>
        ))}
      </ul>
      <div style={{ height }}>
        {shown && (
          <ResponsiveContainer>
            <BarChart data={rows} layout="vertical" margin={{ top: 2, right: 54, bottom: 0, left: 0 }} barSize={14}>
              <CartesianGrid horizontal={false} stroke="var(--ev-grid)" />
              <XAxis
                type="number"
                tickFormatter={compactUsd}
                tick={TICK}
                tickLine={false}
                axisLine={{ stroke: "var(--ev-axis)" }}
                tickCount={4}
              />
              <YAxis
                type="category"
                dataKey="short"
                width={118}
                interval={0}
                tick={CategoryTick}
                tickLine={false}
                axisLine={false}
              />
              <Tooltip content={StepTooltip} cursor={{ fill: "var(--ev-cursor)" }} isAnimationActive={false} />
              <Bar dataKey="base" stackId="w" fill="transparent" activeBar={false} legendType="none" tooltipType="none" isAnimationActive={false} />
              <Bar dataKey="delta" stackId="w" shape={StepShape} activeBar={StepShape} isAnimationActive={false}>
                <LabelList dataKey="display" position="right" fill="var(--ev-label)" fontSize={10} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
      {mismatch && (
        <p className="mt-1 text-[10px] text-amber-700 dark:text-amber-400">
          Breakdown sums to {usd(total)} but NPC is {usd(npcUsd)}; check the evaluation backend.
        </p>
      )}
    </figure>
  );
}
