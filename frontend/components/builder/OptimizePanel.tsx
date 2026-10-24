"use client";
// Griddy Optimizer: tests ~190 solar / wind / battery / gas mixes on Griddy's hourly
// dispatch (POST /api/projects/optimize) and recommends the cheapest one that meets the
// user's targets. Basic mode shows the target, the run button and the recommendation
// card; Advanced adds the other targets, the cost-vs-CO2 chart, alternatives and the
// table of every tested design.  OWNER: workstream D.
import { useState } from "react";

import { Panel } from "@/components/shell/Panel";
import { post } from "@/lib/api";
import type { Scenario, ScenarioResult, Severity } from "@/lib/contract";
import { usd } from "@/lib/format";
import { useGridForge } from "@/lib/store";

import { NumberField } from "./NumberField";
import {
  assetsKey,
  batteryHours,
  cleanOf,
  exactOf,
  isRemote,
  KIND_LABEL,
  KIND_ORDER,
  mainReason,
  mixText,
  num,
  placementOf,
  reasonText,
  scenarioFromMix,
  trimH,
  type Candidate,
  type CleanMetric,
  type Design,
  type Metrics,
  type OptimizeRequest,
  type OptimizeResult,
  type PlacementMode,
} from "./optimizeTypes";
import { SliderField } from "./SliderField";
import { TradeoffChart, type ChartPoint } from "./TradeoffChart";

export type RevealTarget = "simulate" | "stress";

const CAPTION = "Least-cost among the designs we tested on Griddy's simulator, not a certified design.";
const DEV = process.env.NODE_ENV === "development";
/** Optional request keys: sent only when not the default, dropped if the server doesn't know them yet. */
const OPTIONAL_KEYS = ["clean_metric", "placement"] as const;
const SEV_DOT: Record<Severity, string> = { pass: "bg-emerald-500", info: "bg-sky-500", warn: "bg-amber-500", fail: "bg-red-500" };

/** The base search grid: 7 solar x 3 wind x (no battery + 4 sizes x 2 durations). The backend adds a level
 *  for site-model cells and widens the grid when nothing reaches the target, so the busy label says "+". */
const designCount = (wind: boolean) => 7 * (wind ? 3 : 1) * (1 + 4 * 2);

const kt = (t: number) => `${(t / 1000).toLocaleString("en-US", { maximumFractionDigits: t < 10000 ? 1 : 0 })} kt`;
const pct = (v: number) => `${Math.round(v * 100)}%`;
/** Capacity factor: one decimal below 10% (Kern's campus wind runs at 1.4%, not "1%"). */
const cfPct = (v: number) => `${v < 0.1 ? (v * 100).toFixed(1) : Math.round(v * 100)}%`;
const secs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`);
const metricLabel = (m: CleanMetric) => (m === "cfe_24_7" ? "24/7 CFE" : "on-site clean");

/** ProjectOptions defaults (backend/app/evaluate/project.py), so {} and a filled-in copy compare equal. */
const PROJECT_DEFAULTS: Record<string, unknown> = {
  annual_demand_growth: 0.02, projection_years: 5, critical_load_share: 1, outage_hours: 24, budget_usd: null,
  construction_years: 2, construction_labor_share: 0.2, operations_labor_share: 0.35, annual_compensation_usd: 120000,
  local_labor_share: 0.6, contract_price_usd_per_mwh: 80, contract_years: 10, contracted_share: 0,
};

const IGNORED_OPTIONS = new Set(["sizing", "project", "optimizer"]);

/** What the result depends on, like the backend's request_hash: the search ignores the scenario's assets,
 *  name and preset, and the sizing/project options a used design writes back, so using it isn't "stale".
 *  For the 24/7 CFE target the backend turns grid charging off itself, so a used design's
 *  grid_charging = false doesn't change the request either. */
function requestKey(body: OptimizeRequest): string {
  const cfe = body.clean_metric === "cfe_24_7";
  const options = Object.fromEntries(
    Object.entries(body.scenario.options ?? {}).filter(([k, v]) => !IGNORED_OPTIONS.has(k) && !(cfe && k === "grid_charging" && v === false)),
  );
  return JSON.stringify({
    ...body,
    project: { ...PROJECT_DEFAULTS, ...body.project },
    scenario: { ...body.scenario, assets: [], id: "", name: "", preset: null, options },
  });
}

interface Outcome {
  res: OptimizeResult;
  key: string;
  metric: CleanMetric;
  sample: boolean;
  dropped: string[];
}

function Check({ label, checked, onChange, hint }: { label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string }) {
  return (
    <label className="flex items-start gap-2 text-xs text-zinc-700 dark:text-zinc-300" title={hint}>
      <input type="checkbox" className="mt-0.5 accent-emerald-700" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

/** The backend's own words for a failed request (422 detail, or the first validation message). */
function friendlyError(msg: string): string {
  const m = msg.match(/-> (\d+): ([\s\S]*)$/);
  if (!m) return /failed to fetch|networkerror/i.test(msg) ? `Couldn't reach the optimizer (${msg}). Is the backend running?` : msg;
  try {
    const detail = (JSON.parse(m[2]) as { detail?: unknown }).detail;
    if (typeof detail === "string") return detail;
    if (Array.isArray(detail) && detail[0]?.msg) return `${detail[0].msg}${detail[0].loc ? ` (${detail[0].loc.slice(1).join(".")})` : ""}`;
  } catch {
    // Not JSON: fall through to the raw text.
  }
  return `The optimizer failed (HTTP ${m[1]}): ${m[2].slice(0, 300)}`;
}

/** POST, retrying once without optional keys an older server rejects (its models forbid extra fields). */
async function runOptimize(body: OptimizeRequest): Promise<{ res: OptimizeResult; dropped: string[] }> {
  try {
    return { res: await post<OptimizeResult>("/projects/optimize", body), dropped: [] };
  } catch (e) {
    const msg = (e as Error).message;
    const unknown = OPTIONAL_KEYS.filter((k) => k in body && msg.includes("extra_forbidden") && msg.includes(`"${k}"`));
    if (!unknown.length) throw e;
    const retry = { ...body };
    for (const k of unknown) delete retry[k];
    return { res: await post<OptimizeResult>("/projects/optimize", retry), dropped: [...unknown] };
  }
}

export function OptimizePanel({ advanced = false, onReveal }: { advanced?: boolean; onReveal?: (target: RevealTarget) => void }) {
  const { scenario, setScenario, compareResults, compareStale } = useGridForge();
  const [share, setShare] = useState(0.8);
  const [metric, setMetric] = useState<CleanMetric>("onsite_share");
  const [unmetHours, setUnmetHours] = useState(0);
  const [firm, setFirm] = useState(true);
  const [n1, setN1] = useState(false);
  const [wind, setWind] = useState(true);
  const [siteModel, setSiteModel] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  if (!scenario) return <Panel title="Optimize the mix">Loading…</Panel>;

  // The planner's project options (growth, horizon, budget), so both size for the same projected demand.
  const project = (scenario.options?.project ?? {}) as Record<string, unknown>;
  const placement: PlacementMode = siteModel ? "site_model" : "campus_only";
  const body: OptimizeRequest = {
    scenario,
    project,
    min_clean_share: share,
    max_unmet_hours: unmetHours,
    require_reserve_margin: firm,
    require_n_minus_1: n1,
    include_wind: wind,
    ...(placement !== "site_model" ? { placement } : {}),
    ...(metric !== "onsite_share" ? { clean_metric: metric } : {}),
  };
  const key = requestKey(body);
  const stale = !!outcome && !outcome.sample && outcome.key !== key;

  const optimize = async () => {
    setBusy(true);
    setError(null);
    try {
      const { res, dropped } = await runOptimize(body);
      setOutcome({ res, key, metric, sample: false, dropped });
    } catch (e) {
      setError(friendlyError((e as Error).message));
    } finally {
      setBusy(false);
    }
  };
  // Development only: a saved response, to work on the UI while the route is unavailable.
  const showSample = async () => {
    if (process.env.NODE_ENV !== "development") return; // inline, so production builds drop the import
    const sample = (await import("./__fixtures__/optimize.json")).default as unknown as OptimizeResult;
    setOutcome({ res: sample, key, metric: "onsite_share", sample: true, dropped: [] });
    setError(null);
  };

  const apply = (s: Scenario | null | undefined, target: RevealTarget = "simulate") => {
    if (!s) return;
    setScenario(s);
    onReveal?.(target);
  };
  const res = outcome?.res;
  const template = res?.recommended?.scenario ?? scenario;
  const pickPoint = (p: ChartPoint) => apply(p.scenario ?? (p.mix ? scenarioFromMix(template, p.mix, p.batteryMwh) : null));

  return (
    <Panel title="Optimize the mix">
      <div className="space-y-3">
        <p className="text-xs text-zinc-500">
          Tests solar, wind, battery and gas mixes on Griddy&apos;s hourly simulator and picks the cheapest one that meets your targets.
        </p>
        {advanced && (
          <div role="group" aria-label="Clean energy measure" className="flex overflow-hidden rounded border border-zinc-300 text-[11px] dark:border-zinc-700">
            {(
              [
                ["onsite_share", "On-site clean share"],
                ["cfe_24_7", "24/7 clean (CFE)"],
              ] as const
            ).map(([v, label]) => (
              <button
                key={v}
                type="button"
                aria-pressed={metric === v}
                onClick={() => setMetric(v)}
                className={`flex-1 px-2 py-1 ${metric === v ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900" : "text-zinc-600 dark:text-zinc-400"}`}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        <SliderField
          label={metric === "cfe_24_7" ? "24/7 clean target (hours matched)" : "On-site clean energy target"}
          value={share}
          onChange={setShare}
          min={0}
          max={1}
          inputMax={1}
          step={0.05}
          displayScale={100}
          unit="%"
          hint={
            advanced
              ? metric === "cfe_24_7"
                ? "Share of hours fully met by clean supply: on-site solar and wind, the battery, and the grid's clean share."
                : "Share of the campus's demand served by its own solar and wind, directly or through the battery."
              : undefined
          }
        />
        {advanced && (
          <div className="space-y-2">
            <NumberField label="Max unmet hours" unit="h / yr" value={unmetHours} min={0} max={8784} step={1} onChange={(v) => setUnmetHours(Math.round(v))} />
            <Check label="Keep a 15% firm-capacity margin" checked={firm} onChange={setFirm} hint="The firm-capacity stress check must pass." />
            <Check label="Survive losing the largest gas unit (N-1)" checked={n1} onChange={setN1} hint="The N-1 stress check must pass." />
            <Check label="Consider wind" checked={wind} onChange={setWind} />
            <Check
              label="Use site-model locations for solar and wind"
              checked={siteModel}
              onChange={setSiteModel}
              hint="Place solar and wind at the site model's ranked parcels when that is cheaper than the campus. Gas and batteries stay at the campus."
            />
          </div>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={() => void optimize()}
          className="w-full rounded bg-emerald-700 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {busy ? `Testing ${designCount(wind)}+ designs…` : outcome && !outcome.sample ? "Optimize again" : "Find the least-cost mix"}
        </button>
        {error && (
          <div role="alert" className="space-y-1 text-xs">
            <p className="break-words text-red-600">{error}</p>
            {DEV && (
              <button type="button" className="underline" onClick={() => void showSample()}>
                Show sample result (development only)
              </button>
            )}
          </div>
        )}
        {res && outcome && (
          <Result
            outcome={outcome}
            advanced={advanced}
            stale={stale}
            current={scenario}
            onUse={apply}
            onPick={pickPoint}
            onReveal={onReveal}
            presets={presetMarkers(res, compareResults, compareStale, outcome.metric)}
          />
        )}
      </div>
    </Panel>
  );
}

/** Preset markers: from the response if it sends them, else from Compare when it ran on the same demand. */
/** Why a judged design (preset, rule-based plan) wasn't chosen: its failed checks in plain words. */
const failedText = (failed: string[] | null | undefined, res: OptimizeResult) =>
  failed?.length ? failed.map((r) => reasonText(r, res.reasons)).join("; ") : null;

function presetMarkers(res: OptimizeResult, compared: ScenarioResult[] | null, compareStale: boolean, metric: CleanMetric): ChartPoint[] {
  const own = (res.presets ?? []).flatMap((p, i) => {
    const x = num(p.lcoe_usd_per_mwh);
    const y = num(p.annual_t_co2e);
    return x !== undefined && y !== undefined
      ? [
          {
            key: `preset-${p.id ?? i}`,
            x,
            y: y / 1000,
            kind: "preset" as const,
            exact: true,
            label: p.label ?? p.name ?? "Preset",
            mix: p.assets_mw,
            clean: cleanOf(p, metric),
            reason: failedText(p.failed_checks, res),
          },
        ]
      : [];
  });
  if (own.length) return own;
  // Compare runs every preset on today's demand; the optimizer judges at the projected peak.
  const factor = num(res.projection?.factor);
  if (!compared || compareStale || factor === undefined || Math.abs(factor - 1) > 1e-6) return [];
  return compared.flatMap((r) => {
    if (!r.scenario.preset) return [];
    const x = num(r.evaluation.economics.lcoe_usd_per_mwh);
    const y = num(r.evaluation.emissions.annual_t_co2e);
    return x !== undefined && y !== undefined ? [{ key: `preset-${r.scenario.preset}`, x, y: y / 1000, kind: "preset" as const, exact: true, label: r.scenario.name }] : [];
  });
}

const TURNED_DOWN = new Set(["rejected", "failed"]);

/** Every tested design as a chart point: exact numbers where it was judged, else the screening estimate. */
function chartPoints(res: OptimizeResult, metric: CleanMetric): { points: ChartPoint[]; frontier: { x: number; y: number }[] } {
  const demandMwh = num(res.projection?.demand_mwh);
  const points: ChartPoint[] = [];
  (res.candidates ?? []).forEach((c, i) => {
    const status = (c.status ?? "").toLowerCase();
    if (status === "recommended") return; // drawn as the star
    const ex = exactOf(c);
    const estCost = num(c.est_cost_usd_per_yr);
    const x = ex ? num(ex.lcoe_usd_per_mwh) : (num(c.est_lcoe_usd_per_mwh) ?? (estCost !== undefined && demandMwh ? estCost / demandMwh : undefined));
    const y = ex ? num(ex.annual_t_co2e) : num(c.est_t_co2e);
    if (x === undefined || y === undefined) return;
    const down = TURNED_DOWN.has(status);
    points.push({
      key: `c-${i}`,
      x,
      y: y / 1000,
      kind: ex ? "exact" : down ? "rejected" : "screened",
      exact: !!ex,
      mix: ex?.assets_mw ?? c.assets_mw,
      batteryMwh: c.battery_mwh,
      clean: cleanOf(ex ?? c, metric),
      reason: down ? reasonText(c.reason ?? "rejected", res.reasons) : null,
      scenario: c.scenario,
    });
  });
  const frontier = (res.frontier ?? []).flatMap((f) => {
    const x = num(f.lcoe_usd_per_mwh);
    const y = num(f.annual_t_co2e);
    return x !== undefined && y !== undefined ? [{ x, y: y / 1000, f }] : [];
  });
  // Candidates without exact numbers: the frontier's (exact) points stand in as the finalists.
  if (!points.some((p) => p.exact)) {
    const list = Array.isArray(res.finalists) ? res.finalists : frontier.filter((p) => !p.f.recommended).map((p) => p.f);
    list.forEach((f, i) => {
      const x = num(f.lcoe_usd_per_mwh);
      const y = num(f.annual_t_co2e);
      if (x !== undefined && y !== undefined)
        points.push({ key: `f-${i}`, x, y: y / 1000, kind: "exact", exact: true, mix: f.assets_mw, batteryMwh: f.battery_mwh, clean: cleanOf(f, metric), scenario: f.scenario });
    });
  }
  const rec = res.recommended;
  const rx = num(rec?.lcoe_usd_per_mwh);
  const ry = num(rec?.annual_t_co2e);
  if (rec && rx !== undefined && ry !== undefined)
    points.push({ key: "rec", x: rx, y: ry / 1000, kind: "recommended", exact: true, mix: rec.assets_mw, batteryMwh: rec.battery_mwh, clean: cleanOf(rec, metric), scenario: rec.scenario });
  return { points, frontier: frontier.map(({ x, y }) => ({ x, y })) };
}

function Result({
  outcome,
  advanced,
  stale,
  current,
  onUse,
  onPick,
  onReveal,
  presets,
}: {
  outcome: Outcome;
  advanced: boolean;
  stale: boolean;
  current: Scenario;
  onUse: (s: Scenario | null | undefined, target?: RevealTarget) => void;
  onPick: (p: ChartPoint) => void;
  onReveal?: (target: RevealTarget) => void;
  presets: ChartPoint[];
}) {
  const { res, metric, sample, dropped } = outcome;
  const rec = res.recommended ?? null;
  const tested = num(res.tested) ?? res.candidates?.length ?? 0;
  const baseline = res.baseline?.available === false ? null : res.baseline;
  const { points, frontier } = chartPoints(res, metric);
  const bx = num(baseline?.lcoe_usd_per_mwh);
  const by = num(baseline?.annual_t_co2e);
  const markers: ChartPoint[] = [
    ...(baseline && bx !== undefined && by !== undefined
      ? [
          {
            key: "baseline",
            x: bx,
            y: by / 1000,
            kind: "baseline" as const,
            exact: true,
            label: baseline.label ?? "Rule-based plan",
            mix: baseline.assets_mw,
            batteryMwh: baseline.battery_mwh,
            clean: cleanOf(baseline, metric),
            reason: failedText(baseline.failed_checks, res),
          },
        ]
      : []),
    ...presets,
  ];
  const notes = (res.notes ?? []).filter((n) => typeof n === "string" && n);

  return (
    <div className="space-y-3">
      {sample && (
        <p className="rounded bg-amber-100 px-2 py-1 text-[11px] text-amber-900 dark:bg-amber-950 dark:text-amber-300">
          Sample result saved from a Kern run (development only). It does not reflect your current inputs.
        </p>
      )}
      {dropped.length > 0 && (
        <p className="text-[11px] text-amber-800 dark:text-amber-300">
          This server doesn&apos;t support {dropped.map((k) => (k === "clean_metric" ? "the 24/7 CFE target" : "the placement choice")).join(" or ")} yet, so it used its default.
        </p>
      )}
      {rec ? (
        <DesignCard d={rec} res={res} metric={metric} tested={tested} stale={stale} current={current} advanced={advanced} onUse={onUse} onReveal={onReveal} />
      ) : (
        <NoDesign res={res} metric={metric} tested={tested} />
      )}
      <p className="text-[11px] text-zinc-500">{CAPTION}</p>
      {advanced && (
        <>
          {points.length > 0 && <TradeoffChart points={points} frontier={frontier} markers={markers} metric={metric} onPick={onPick} />}
          {(res.alternatives ?? []).length > 0 && (
            <div className="space-y-1.5">
              <h3 className="text-xs font-semibold text-zinc-700 dark:text-zinc-300">Alternatives</h3>
              {(res.alternatives ?? []).map((a, i) => (
                <div key={`${a.label}-${i}`} className="flex items-start justify-between gap-2 rounded border border-zinc-200 p-1.5 text-[11px] dark:border-zinc-800">
                  <div className="min-w-0">
                    <div className="font-medium">{a.label ?? `Alternative ${i + 1}`}</div>
                    <div className="text-zinc-500">{mixText(a.assets_mw, a.battery_mwh)}</div>
                    <div className="tabular-nums text-zinc-500">{metricLine(a, metric)}</div>
                  </div>
                  <button
                    type="button"
                    disabled={stale || !a.scenario}
                    onClick={() => onUse(a.scenario)}
                    className="shrink-0 rounded border border-zinc-300 px-1.5 py-0.5 disabled:opacity-40 dark:border-zinc-700"
                  >
                    Use
                  </button>
                </div>
              ))}
            </div>
          )}
          {(res.candidates ?? []).length > 0 && <CandidatesTable res={res} metric={metric} />}
          {notes.length > 0 && (
            <ul className="space-y-0.5 text-[11px] text-amber-700 dark:text-amber-500">
              {notes.map((n, i) => (
                <li key={`${i}-${n}`}>Note: {n}</li>
              ))}
            </ul>
          )}
          <p className="text-[10px] text-zinc-500">
            {res.basis}
            {num(res.runtime_ms) !== undefined && !res.precomputed && ` Ran in ${secs(res.runtime_ms ?? 0)}.`}
          </p>
        </>
      )}
    </div>
  );
}

function metricLine(m: Metrics, metric: CleanMetric): string {
  const lcoe = num(m.lcoe_usd_per_mwh);
  const co2 = num(m.annual_t_co2e);
  const clean = cleanOf(m, metric);
  return [
    lcoe !== undefined ? `$${lcoe.toFixed(0)}/MWh` : null,
    co2 !== undefined ? `${kt(co2)} CO₂e/yr` : null,
    clean !== undefined ? `${pct(clean)} ${metricLabel(metric)}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** "$421/MWh cheaper and 584 kt/yr less CO₂e than the rule-based plan" */
function deltaText(d: Design, base: OptimizeResult["baseline"]): string | null {
  if (!base || base.available === false) return null;
  const parts: string[] = [];
  const dl = (num(base.lcoe_usd_per_mwh) ?? NaN) - (num(d.lcoe_usd_per_mwh) ?? NaN);
  const dc = (num(base.annual_t_co2e) ?? NaN) - (num(d.annual_t_co2e) ?? NaN);
  if (Number.isFinite(dl) && Math.abs(dl) >= 0.5) parts.push(`$${Math.abs(dl).toFixed(0)}/MWh ${dl > 0 ? "cheaper" : "more expensive"}`);
  if (Number.isFinite(dc) && Math.abs(dc) >= 500) parts.push(`${kt(Math.abs(dc))}/yr ${dc > 0 ? "less" : "more"} CO₂e`);
  if (!parts.length) return null;
  const fails = base.passes_checks === false || base.meets_targets === false;
  return `${parts.join(" and ")} than the ${(base.label ?? "rule-based plan").toLowerCase()}${fails ? ", which misses your checks" : ""}.`;
}

/** One line of why: how the winner was picked and what ruled most designs out. */
function whyLine(res: OptimizeResult, tested: number): string {
  const judged = Array.isArray(res.finalists) ? res.finalists.length : num(res.finalists);
  const passing = num(res.passing);
  const counts = Object.entries(res.rejected_by_reason ?? {}).filter(([, n]) => (num(n) ?? 0) > 0).sort((a, b) => b[1] - a[1]);
  const out = counts.reduce((t, [, n]) => t + n, 0);
  const n = passing ?? judged;
  const pool = n ? `the ${n} finalists that passed every check you set in an exact run${judged && passing !== undefined && passing < judged ? ` (${judged} judged)` : ""}` : "the finalists that passed every check you set";
  const ruled = counts.length ? ` ${out} of ${tested} designs were ruled out, mostly: ${reasonText(counts[0][0], res.reasons).toLowerCase()}.` : "";
  const wider = res.search?.widened ? " Nothing on the standard grid reached the target, so the search widened to more solar and longer storage." : "";
  return `Cheapest of ${pool}.${ruled}${wider}`;
}

function DesignCard({
  d,
  res,
  metric,
  tested,
  stale,
  current,
  advanced,
  onUse,
  onReveal,
}: {
  d: Design;
  res: OptimizeResult;
  metric: CleanMetric;
  tested: number;
  stale: boolean;
  current: Scenario;
  advanced: boolean;
  onUse: (s: Scenario | null | undefined, target?: RevealTarget) => void;
  onReveal?: (target: RevealTarget) => void;
}) {
  const mix = d.assets_mw ?? {};
  const inUse = !!d.scenario && assetsKey(d.scenario.assets) === assetsKey(current.assets);
  const lcoe = num(d.lcoe_usd_per_mwh);
  const capex = num(d.capex_total_usd);
  const npc = num(d.npc_usd);
  const co2 = num(d.annual_t_co2e);
  const onsite = num(d.onsite_clean_share);
  const cfe = num(d.cfe_score_24_7);
  const unmet = num(d.hours_unmet);
  const counts = d.findings_count ?? {};
  const flagged = (d.findings ?? []).filter((f) => f.severity === "fail" || f.severity === "warn");
  const delta = deltaText(d, res.baseline);
  const years = num(res.projection?.years) ?? num((current.options?.project as Record<string, unknown> | undefined)?.projection_years);
  const peak = num(res.projection?.peak_mw);
  const stat = (label: string, value: string) => (
    <div>
      <div className="text-[10px] text-zinc-500">{label}</div>
      <div className="text-sm font-semibold tabular-nums">{value}</div>
    </div>
  );

  return (
    <div className="space-y-2 rounded border border-[#82A3A1] bg-[#C0DFA1]/15 p-2 text-xs dark:border-[#465362] dark:bg-[#011936]/40">
      <div>
        <p className="flex items-baseline justify-between gap-2 font-semibold">
          Least-cost design for your targets
          {res.precomputed && <span className="shrink-0 rounded bg-zinc-200 px-1 text-[10px] font-medium text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">precomputed</span>}
        </p>
        {peak !== undefined && (
          <p className="text-[11px] text-zinc-500">
            Sized for {years !== undefined ? `year ${years}: ` : ""}
            {peak.toLocaleString("en-US", { maximumFractionDigits: 0 })} MW projected peak
          </p>
        )}
      </div>
      <ul className="space-y-0.5">
        {KIND_ORDER.map((k) => {
          const mw = num(mix[k]) ?? 0;
          if (mw < 0.05) return null;
          const h = k === "battery" ? batteryHours(mix, d.battery_mwh) : null;
          const e = num(d.battery_mwh);
          return (
            <li key={k} className="flex justify-between gap-2">
              <span>{KIND_LABEL[k]}</span>
              <span className="tabular-nums">
                {Math.round(mw).toLocaleString("en-US")} MW
                {k === "battery" && h ? ` × ${trimH(h)} h${e !== undefined ? ` (${(e / 1000).toFixed(1)} GWh)` : ""}` : ""}
              </span>
            </li>
          );
        })}
      </ul>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
        {lcoe !== undefined && stat("Levelized cost", `$${lcoe.toFixed(0)}/MWh`)}
        {capex !== undefined && stat("Capital cost", usd(capex))}
        {co2 !== undefined && stat("CO₂e per year", kt(co2))}
        {metric === "cfe_24_7" ? cfe !== undefined && stat("24/7 clean (CFE)", pct(cfe)) : onsite !== undefined && stat("On-site clean share", pct(onsite))}
      </div>
      <p className="text-[11px] text-zinc-500">
        {[
          npc !== undefined ? `Net present cost ${usd(npc)}` : null,
          metric === "cfe_24_7" ? (onsite !== undefined ? `${pct(onsite)} on-site clean` : null) : cfe !== undefined ? `${pct(cfe)} 24/7 CFE` : null,
          unmet !== undefined ? `${unmet.toLocaleString("en-US")} unmet hours` : null,
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>
      {delta && <p className="font-medium text-emerald-800 dark:text-[#C0DFA1]">{delta}</p>}
      <p className="text-[11px] text-zinc-600 dark:text-zinc-400">{whyLine(res, tested)}</p>
      {Object.keys(counts).length > 0 && (
        <div className="space-y-1 text-[11px]">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {(["fail", "warn", "info", "pass"] as Severity[]).map((s) =>
              num(counts[s]) !== undefined ? (
                <span key={s} className="flex items-center gap-1 tabular-nums">
                  <span className={`h-2 w-2 rounded-full ${SEV_DOT[s]}`} aria-hidden />
                  {counts[s]} {s}
                </span>
              ) : null,
            )}
            <button
              type="button"
              disabled={stale || !d.scenario}
              className="ml-auto underline disabled:opacity-40"
              onClick={() => (inUse ? onReveal?.("stress") : onUse(d.scenario, "stress"))}
            >
              {inUse ? "Open stress test" : "Use it and see the checks"}
            </button>
          </div>
          {advanced && flagged.length > 0 && <p className="text-zinc-500">To review: {flagged.map((f) => f.title).join("; ")}.</p>}
        </div>
      )}
      <PlacementBlock d={d} res={res} metric={metric} />
      {inUse && peak !== undefined && (
        <p className="text-[11px] text-zinc-500">
          In use. Simulate and Stress run it at today&apos;s {current.demand.peak_mw.toLocaleString("en-US", { maximumFractionDigits: 0 })} MW peak; the numbers above are for the projected{" "}
          {peak.toLocaleString("en-US", { maximumFractionDigits: 0 })} MW.
        </p>
      )}
      <button
        type="button"
        disabled={stale || !d.scenario || inUse}
        onClick={() => onUse(d.scenario)}
        className="rounded bg-zinc-900 px-3 py-1.5 text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-black"
      >
        {stale ? "Inputs changed — optimize again" : inUse ? "In use" : "Use this design"}
      </button>
    </div>
  );
}

/** Where the solar and wind go, and what the site model's locations saved against an all-campus build. */
function PlacementBlock({ d, res, metric }: { d: Design; res: OptimizeResult; metric: CleanMetric }) {
  const rows = placementOf(res, d).filter((p) => p.kind === "solar_pv" || p.kind === "onshore_wind");
  const info = res.placement && typeof res.placement === "object" && !Array.isArray(res.placement) ? res.placement : null;
  if (!rows.length && !info) return null;
  const remote = rows.filter(isRemote);
  const campus = d.campus_only ?? res.campus_only;
  const saved = (num(campus?.npc_usd) ?? NaN) - (num(d.npc_usd) ?? NaN);
  const savedCo2 = (num(campus?.annual_t_co2e) ?? NaN) - (num(d.annual_t_co2e) ?? NaN);
  const unavailable = info?.requested === "site_model" && info.used === "campus_only";
  // A kind's capacity factor at the campus, from the locations the backend ranked.
  const campusCf = (kind: string) => num(info?.options?.[kind]?.find((o) => o.id === "campus")?.annual_cf);
  const where = (p: (typeof rows)[number]) => {
    const cf = isRemote(p) ? num(p.candidate?.annual_cf) : campusCf(p.kind);
    const cfText = cf !== undefined ? `${cfPct(cf)} capacity factor` : null;
    if (!isRemote(p)) return ["at the campus", cfText].filter(Boolean).join(", ");
    const county = p.county ?? (typeof p.candidate?.county === "string" ? p.candidate.county : null);
    const suit = num(p.suitability);
    const tie = num(p.gen_tie_usd);
    const cell = p.site_id && p.site_id !== "campus" ? `site-model cell ${p.site_id}` : "site-model parcel";
    return [`${cell}${county ? ` in ${county} County` : ""}`, cfText, suit !== undefined ? `suitability ${suit.toFixed(2)}` : null, tie ? `${usd(tie)} gen-tie` : null]
      .filter(Boolean)
      .join(", ");
  };
  // Kinds placed only at remote cells: say what the campus would have given them.
  const offsite = (["solar_pv", "onshore_wind"] as const).filter((k) => remote.some((p) => p.kind === k) && !rows.some((p) => p.kind === k && !isRemote(p)));
  let verdict: string | null = null;
  if (unavailable) verdict = info?.notes?.[0] ?? "Site-model locations weren't available, so every MW is at the campus.";
  else if (info?.requested === "campus_only" || info?.used === "campus_only") verdict = "Every MW is at the campus (site-model locations off).";
  else if (Number.isFinite(saved) && saved > 0.5) {
    const failed = campus?.passes_checks === false ? (campus.failed_checks ?? []) : [];
    const clean = cleanOf(campus, metric);
    const miss = failed.some((r) => r === "clean_share_below_target" || r === "cfe_below_target") && clean !== undefined
      ? ` All at the campus, the same mix reaches only ${pct(clean)} ${metricLabel(metric)}, short of your target.`
      : failed.length
        ? ` All at the campus, the same mix fails: ${(failedText(failed, res) ?? "").toLowerCase()}.`
        : "";
    verdict = `The site model's locations save ${usd(saved)} in net present cost${Number.isFinite(savedCo2) && savedCo2 >= 500 ? ` and ${kt(savedCo2)}/yr of CO₂e` : ""} against putting it all at the campus.${miss}`;
  } else if (!remote.length) verdict = "None of the site model's locations beat the campus for this mix, so it all stays on site.";
  else if (Number.isFinite(saved)) verdict = "The site model's locations cost about the same as the campus for this mix.";

  return (
    <div className="space-y-0.5 border-t border-[#82A3A1]/50 pt-1.5 text-[11px]">
      <p className="font-medium">Where the solar and wind go</p>
      {rows.length > 0 && (
        <ul className="space-y-0.5 text-zinc-600 dark:text-zinc-400">
          {rows.map((p, i) => (
            <li key={`${p.asset_id ?? p.kind}-${i}`}>
              {KIND_LABEL[p.kind as keyof typeof KIND_LABEL] ?? p.kind} {Math.round(p.mw).toLocaleString("en-US")} MW: {where(p)}
            </li>
          ))}
        </ul>
      )}
      {offsite.map((k) => {
        const cf = campusCf(k);
        return cf !== undefined ? (
          <p key={k} className="text-zinc-500">
            At the campus, {k === "onshore_wind" ? "wind" : "solar"} would run at a {cfPct(cf)} capacity factor.
          </p>
        ) : null;
      })}
      {verdict && <p className="text-zinc-600 dark:text-zinc-400">{verdict}</p>}
      {remote.length > 0 && (
        <p className="text-zinc-500">Site-model parcels are screening candidates, not buildable sites. Delivering their output to the campus needs a utility study.</p>
      )}
    </div>
  );
}

function NoDesign({ res, metric, tested }: { res: OptimizeResult; metric: CleanMetric; tested: number }) {
  const reason = mainReason(res);
  const best = Math.max(-1, ...(res.candidates ?? []).map((c) => cleanOf(exactOf(c) ?? c, metric) ?? -1));
  return (
    <div role="status" className="space-y-1 rounded border border-amber-300 bg-amber-50 p-2 text-xs dark:border-amber-800 dark:bg-amber-950/30">
      <p className="font-semibold">{res.available === false ? "The optimizer isn't available right now." : `None of the ${tested || ""} tested designs meets these targets.`}</p>
      {res.message ? (
        <p>{res.message}</p>
      ) : (
        <>
          {reason && <p>Main reason: {reasonText(reason, res.reasons).toLowerCase()}.</p>}
          {best >= 0 && (
            <p>
              The best {metricLabel(metric)} among the tested designs is {pct(best)}.
            </p>
          )}
          <p className="text-zinc-600 dark:text-zinc-400">Try a lower clean target, allow a few unmet hours, or turn wind back on.</p>
        </>
      )}
    </div>
  );
}

const STATUS_RANK: Record<string, number> = { recommended: 0, passed: 1, finalist: 1, failed: 2, screened: 3, rejected: 4 };

function CandidatesTable({ res, metric }: { res: OptimizeResult; metric: CleanMetric }) {
  const candidates = res.candidates ?? [];
  const demandMwh = num(res.projection?.demand_mwh);
  const cost = (c: Candidate) => {
    const ex = exactOf(c);
    if (ex) return num(ex.lcoe_usd_per_mwh);
    const est = num(c.est_cost_usd_per_yr);
    return num(c.est_lcoe_usd_per_mwh) ?? (demandMwh && est !== undefined ? est / demandMwh : undefined);
  };
  const rows = [...candidates].sort(
    (a, b) => (STATUS_RANK[a.status ?? ""] ?? 3) - (STATUS_RANK[b.status ?? ""] ?? 3) || (cost(a) ?? Infinity) - (cost(b) ?? Infinity),
  );
  return (
    <details className="text-[11px]">
      <summary className="cursor-pointer font-medium">All {candidates.length} tested designs</summary>
      <div className="mt-1 max-h-72 overflow-auto rounded border border-zinc-200 dark:border-zinc-800">
        <table className="w-full text-left tabular-nums">
          <thead className="sticky top-0 bg-zinc-100 text-[10px] text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400">
            <tr>
              <th className="px-1 py-0.5 font-medium">Mix (MW)</th>
              <th className="px-1 py-0.5 text-right font-medium">$/MWh</th>
              <th className="px-1 py-0.5 text-right font-medium">kt</th>
              <th className="px-1 py-0.5 text-right font-medium">{metric === "cfe_24_7" ? "CFE" : "Clean"}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c, i) => {
              const ex = exactOf(c);
              const x = cost(c);
              const y = ex ? num(ex.annual_t_co2e) : num(c.est_t_co2e);
              const clean = cleanOf(ex ?? c, metric);
              const down = TURNED_DOWN.has(c.status ?? "");
              return (
                <tr key={i} className={`border-t border-zinc-100 dark:border-zinc-800 ${down ? "text-zinc-500" : ""}`}>
                  <td className="px-1 py-0.5">
                    {c.status === "recommended" && "★ "}
                    {mixText(ex?.assets_mw ?? c.assets_mw, c.battery_mwh).replace(/ MW$/, "")}
                    {down && c.reason && <div className="text-[10px] text-amber-800 dark:text-amber-300">{reasonText(c.reason, res.reasons)}</div>}
                  </td>
                  <td className="px-1 py-0.5 text-right">{x !== undefined ? `${ex ? "" : "~"}${x.toFixed(0)}` : "—"}</td>
                  <td className="px-1 py-0.5 text-right">{y !== undefined ? Math.round(y / 1000).toLocaleString("en-US") : "—"}</td>
                  <td className="px-1 py-0.5 text-right">{clean !== undefined ? pct(clean) : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-0.5 text-[10px] text-zinc-500">★ recommended · ~ screening estimate; other rows are exact runs.</p>
    </details>
  );
}
