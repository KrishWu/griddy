"use client";
// Cost versus carbon for every design the optimizer tested: grey = screening estimates,
// solid = exact finalists, a line through the cost/CO2 frontier, a star on the
// recommendation, and labeled markers for the rule-based plan and presets, so judges see
// how far the search moved. Shapes and labels carry identity (the team palette is low
// chroma), and the candidates table in OptimizePanel is the chart's table view.
// OWNER: workstream D.
import {
  CartesianGrid,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipContentProps,
} from "recharts";
import type { ReactElement } from "react";

import { TICK, TOOLTIP_CARD } from "@/components/evaluate/chartTheme";
import type { Scenario } from "@/lib/contract";

import { mixText, num, type CleanMetric, type Mix } from "./optimizeTypes";

export type PointKind = "rejected" | "screened" | "exact" | "recommended" | "baseline" | "preset";

export interface ChartPoint {
  key: string;
  /** LCOE, $/MWh (a screening estimate unless exact). */
  x: number;
  /** Annual CO2e, kt. */
  y: number;
  kind: PointKind;
  exact: boolean;
  label?: string;
  mix?: Mix;
  batteryMwh?: number | null;
  clean?: number;
  /** Why it wasn't chosen, in plain words. */
  reason?: string | null;
  scenario?: Scenario | null;
  /** Drawn at the plot edge because the real value is far off-scale. */
  pinned?: boolean;
  trueX?: number;
  trueY?: number;
  /** Label placement for labeled markers, set by placeMarkers(). */
  labelLeft?: boolean;
  labelDy?: number;
}

// Team palette (#011936 #465362 #82A3A1 #9FC490 #C0DFA1) on the app's surfaces: white
// panels in light mode, navy (#0c182a) in dark, where #011936 would vanish. Context marks
// (estimates) use the neutral tone ramp, one step quieter in dark mode.
const VARS = [
  "[--op-exact:#465362] dark:[--op-exact:#9FC490]",
  "[--op-line:#011936] dark:[--op-line:#C0DFA1]",
  "[--op-best:#011936] dark:[--op-best:#C0DFA1]",
  "[--op-plan:#82A3A1] dark:[--op-plan:#82A3A1]",
  "[--op-preset:#465362] dark:[--op-preset:#82A3A1]",
  "[--op-screened:var(--tone-300)] dark:[--op-screened:var(--tone-600)]",
  "[--op-rejected:var(--tone-300)] dark:[--op-rejected:var(--tone-700)]",
  "[--op-surface:#ffffff] dark:[--op-surface:var(--tone-950)]",
  "[--op-label:var(--tone-800)] dark:[--op-label:var(--tone-100)]",
  "[--ev-grid:var(--tone-100)] dark:[--ev-grid:var(--tone-900)]",
  "[--ev-axis:var(--tone-200)] dark:[--ev-axis:var(--tone-700)]",
  "[--ev-muted:var(--tone-500)] dark:[--ev-muted:var(--tone-400)]",
].join(" ");

const star = (cx: number, cy: number, r: number) =>
  Array.from({ length: 10 }, (_, i) => {
    const a = (Math.PI / 5) * i - Math.PI / 2;
    const rr = i % 2 ? r * 0.45 : r;
    return `${(cx + rr * Math.cos(a)).toFixed(1)},${(cy + rr * Math.sin(a)).toFixed(1)}`;
  }).join(" ");

/** One shape renderer for every series: the point's kind picks the mark. */
function PointShape(props: unknown): ReactElement {
  const { cx, cy, payload } = props as { cx?: number; cy?: number; payload?: ChartPoint };
  if (cx === undefined || cy === undefined || !payload) return <g />;
  const hit = <circle cx={cx} cy={cy} r={7} fill="transparent" />; // hit target bigger than the mark
  switch (payload.kind) {
    case "rejected":
      return <g>{hit}<circle cx={cx} cy={cy} r={2.5} fill="none" stroke="var(--op-rejected)" strokeWidth={1} /></g>;
    case "screened":
      return <g>{hit}<circle cx={cx} cy={cy} r={2.75} fill="var(--op-screened)" /></g>;
    case "exact":
      return (
        <g style={{ cursor: "pointer" }}>
          {hit}
          <circle cx={cx} cy={cy} r={3.5} fill="var(--op-exact)" stroke="var(--op-surface)" strokeWidth={1.5} />
        </g>
      );
    case "recommended":
      return (
        <g style={{ cursor: "pointer" }}>
          <circle cx={cx} cy={cy} r={11} fill="transparent" />
          <polygon points={star(cx, cy, 9)} fill="var(--op-best)" stroke="var(--op-surface)" strokeWidth={1.5} />
        </g>
      );
    case "baseline":
    case "preset": {
      const r = 5;
      const mark =
        payload.kind === "baseline" ? (
          <polygon points={`${cx},${cy - r - 0.5} ${cx + r + 0.5},${cy} ${cx},${cy + r + 0.5} ${cx - r - 0.5},${cy}`} fill="var(--op-plan)" stroke="var(--op-surface)" strokeWidth={1.5} />
        ) : (
          <polygon points={`${cx},${cy - r} ${cx + r},${cy + r * 0.8} ${cx - r},${cy + r * 0.8}`} fill="var(--op-surface)" stroke="var(--op-preset)" strokeWidth={1.75} />
        );
      const left = payload.labelLeft;
      return (
        <g>
          {hit}
          {mark}
          <text
            x={left ? cx - 8 : cx + 8}
            y={cy + 3 + (payload.labelDy ?? 0)}
            textAnchor={left ? "end" : "start"}
            fontSize={9}
            fill="var(--op-label)"
            stroke="var(--op-surface)"
            strokeWidth={3}
            strokeLinejoin="round"
            paintOrder="stroke"
          >
            {payload.label}
            {payload.pinned ? " →" : ""}
          </text>
        </g>
      );
    }
  }
}

const NoShape = () => <g />;

const pct = (v: number) => `${Math.round(v * 100)}%`;

function makeTooltip(metric: CleanMetric) {
  return function PointTooltip({ active, payload }: TooltipContentProps) {
    const p = payload?.find((x) => x?.payload)?.payload as ChartPoint | undefined;
    if (!active || !p) return null;
    const x = p.trueX ?? p.x;
    const y = p.trueY ?? p.y;
    const title =
      p.kind === "recommended" ? "Recommended" : p.kind === "baseline" || p.kind === "preset" ? p.label : p.exact ? "Finalist (exact run)" : "Screening estimate";
    return (
      <div className={`${TOOLTIP_CARD} max-w-[230px]`}>
        <div className="font-semibold text-zinc-900 dark:text-zinc-100">{title}</div>
        {p.mix && <div>{mixText(p.mix, p.batteryMwh)}</div>}
        <div className="tabular-nums text-zinc-500">
          ${x.toFixed(0)}/MWh{p.exact ? "" : " est."} · {y.toLocaleString("en-US", { maximumFractionDigits: 0 })} kt CO₂e/yr
          {p.clean !== undefined && ` · ${pct(p.clean)} ${metric === "cfe_24_7" ? "24/7 CFE" : "on-site clean"}`}
        </div>
        {p.pinned && <div className="text-[10px] text-zinc-500">Off the chart&apos;s scale; drawn at its edge.</div>}
        {p.reason && <div className="text-amber-800 dark:text-amber-300">Not chosen: {p.reason}</div>}
        {(p.kind === "exact" || p.kind === "recommended") && <div className="text-[10px] text-zinc-500">Click to load this design</div>}
      </div>
    );
  };
}

/** Round a domain outward on a step that gives ~4 ticks (the low end on half steps, to skip empty space). */
function niceDomain(lo: number, hi: number): [number, number] {
  if (!(hi > lo)) return [Math.max(0, lo - 1), hi + 1];
  const span = hi - lo;
  const raw = span / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  return [Math.max(0, Math.floor((lo - span * 0.04) / (step / 2)) * (step / 2)), Math.ceil((hi + span * 0.04) / step) * step];
}

/** Pull far-off markers (e.g. a rule-based plan at 4x the cost) onto the plot edge, then keep labels apart. */
function placeMarkers(points: ChartPoint[], markers: ChartPoint[]): { all: ChartPoint[]; x: [number, number]; y: [number, number] } {
  const core = points.length ? points : markers;
  const xs = core.map((p) => p.x);
  const ys = core.map((p) => p.y);
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
  const [y0, y1] = [Math.min(...ys), Math.max(...ys)];
  const near = markers.filter((m) => m.x <= x1 + (x1 - x0) * 0.6 + 5 && m.y <= y1 + (y1 - y0) * 0.6 + 5);
  const x = niceDomain(Math.min(x0, ...near.map((m) => m.x)), Math.max(x1, ...near.map((m) => m.x)));
  const y = niceDomain(Math.min(y0, ...near.map((m) => m.y)), Math.max(y1, ...near.map((m) => m.y)));
  const placed = markers.map((m) =>
    near.includes(m) ? { ...m } : { ...m, pinned: true, trueX: m.x, trueY: m.y, x: Math.min(m.x, x[1]), y: Math.min(m.y, y[1]) },
  );
  // Approximate plot pixels (~195 x 220 in the 300 px sidebar): enough to stack labels that would collide.
  const px = (p: ChartPoint) => ((p.x - x[0]) / (x[1] - x[0] || 1)) * 195;
  const py = (p: ChartPoint) => (1 - (p.y - y[0]) / (y[1] - y[0] || 1)) * 220;
  const taken: { a: number; b: number; y: number }[] = [];
  for (const m of [...placed].sort((p, q) => py(p) - py(q))) {
    m.labelLeft = m.pinned || px(m) > 110;
    const w = ((m.label ?? "").length + (m.pinned ? 2 : 0)) * 4.7; // 9 px text
    const [a, b] = m.labelLeft ? [px(m) - 8 - w, px(m) - 8] : [px(m) + 8, px(m) + 8 + w];
    let ly = py(m);
    for (let i = 0; i < 6 && taken.some((t) => t.a < b && a < t.b && Math.abs(t.y - ly) < 11); i++) ly += 11;
    m.labelDy = ly - py(m);
    taken.push({ a, b, y: ly });
  }
  return { all: [...points, ...placed], x, y };
}

function Key({ kind }: { kind: PointKind | "line" }) {
  const shape: Record<string, ReactElement> = {
    rejected: <circle cx={6} cy={6} r={2.5} fill="none" stroke="var(--op-rejected)" />,
    screened: <circle cx={6} cy={6} r={2.75} fill="var(--op-screened)" />,
    exact: <circle cx={6} cy={6} r={3.5} fill="var(--op-exact)" />,
    line: <line x1={0} y1={6} x2={12} y2={6} stroke="var(--op-line)" strokeWidth={2} />,
    recommended: <polygon points={star(6, 6, 5.5)} fill="var(--op-best)" />,
    baseline: <polygon points="6,1 11,6 6,11 1,6" fill="var(--op-plan)" />,
    preset: <polygon points="6,1.5 11,10 1,10" fill="none" stroke="var(--op-preset)" strokeWidth={1.5} />,
  };
  return (
    <svg width={12} height={12} aria-hidden className="shrink-0">
      {shape[kind]}
    </svg>
  );
}

const LEGEND: [PointKind | "line", string][] = [
  ["rejected", "Missed a target"],
  ["screened", "Estimate"],
  ["exact", "Exact finalist"],
  ["line", "Frontier"],
  ["recommended", "Recommended"],
  ["baseline", "Rule-based plan"],
  ["preset", "Preset"],
];

export function TradeoffChart({
  points,
  frontier,
  markers,
  metric,
  onPick,
}: {
  points: ChartPoint[];
  frontier: { x: number; y: number }[];
  markers: ChartPoint[];
  metric: CleanMetric;
  onPick: (p: ChartPoint) => void;
}) {
  const { all, x, y } = placeMarkers(points, markers);
  const by = (k: PointKind) => all.filter((p) => p.kind === k);
  const line = frontier.filter((p) => num(p.x) !== undefined && num(p.y) !== undefined).sort((a, b) => a.x - b.x);
  const legend = LEGEND.filter(([k]) => (k === "line" ? line.length > 1 : by(k).length > 0));
  const pick = (item: unknown) => {
    const p = (item as { payload?: ChartPoint } | undefined)?.payload;
    if (p && (p.kind === "exact" || p.kind === "recommended")) onPick(p);
  };
  const scatter = (kind: PointKind, click = false) =>
    by(kind).length ? (
      <Scatter key={kind} data={by(kind)} shape={PointShape} isAnimationActive={false} legendType="none" onClick={click ? pick : undefined} />
    ) : null;

  return (
    // The frontier line draws over the finalists; it must not swallow their hover and click.
    <figure className={`${VARS} [&_.recharts-scatter-line]:pointer-events-none [&_.recharts-surface:focus:not(:focus-visible)]:outline-none`} aria-label="Cost versus CO2 for every tested design">
      <figcaption className="mb-1 flex items-baseline justify-between gap-2 text-[10px] text-zinc-500">
        <span className="font-semibold text-zinc-700 dark:text-zinc-300">Cost vs CO₂, every tested design</span>
        <span>kt CO₂e/yr ↑</span>
      </figcaption>
      <ul className="mb-1 flex flex-wrap gap-x-2.5 gap-y-0.5 text-[10px] text-zinc-600 dark:text-zinc-400" aria-label="Legend">
        {legend.map(([kind, label]) => (
          <li key={kind} className="flex items-center gap-1">
            <Key kind={kind} />
            {label}
          </li>
        ))}
      </ul>
      <div className="h-64">
        <ResponsiveContainer>
          <ScatterChart margin={{ top: 8, right: 10, bottom: 2, left: 0 }}>
            <CartesianGrid stroke="var(--ev-grid)" />
            <XAxis
              type="number"
              dataKey="x"
              domain={x}
              allowDataOverflow
              tick={TICK}
              tickLine={false}
              axisLine={{ stroke: "var(--ev-axis)" }}
              tickFormatter={(v: number) => `$${v}`}
              tickCount={5}
              name="LCOE"
            />
            <YAxis
              type="number"
              dataKey="y"
              domain={y}
              allowDataOverflow
              tick={TICK}
              tickLine={false}
              axisLine={false}
              width={38}
              tickFormatter={(v: number) => v.toLocaleString("en-US")}
              tickCount={5}
              name="CO2"
            />
            <Tooltip content={makeTooltip(metric)} cursor={false} isAnimationActive={false} />
            {scatter("rejected")}
            {scatter("screened")}
            {scatter("exact", true)}
            {/* The frontier runs through the finalists, so it draws over them. */}
            {line.length > 1 && (
              <Scatter data={line} line={{ stroke: "var(--op-line)", strokeWidth: 1.75, pointerEvents: "none" }} shape={NoShape} tooltipType="none" isAnimationActive={false} legendType="none" />
            )}
            {scatter("baseline")}
            {scatter("preset")}
            {scatter("recommended", true)}
          </ScatterChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-0.5 text-right text-[10px] text-zinc-500">Levelized cost, $/MWh →</div>
    </figure>
  );
}
