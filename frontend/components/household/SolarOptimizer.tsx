"use client";
// Solar tab's "Optimize for my home": budget, roof room and a battery option go to
// POST /api/household/solar/optimize with the same household as /plan; the best size by 25-year NPV
// is written into the Solar tab's what-if sliders, so every chart below shows that system, and a result
// card explains the pick (what limited it, the reason, NPV by size). OWNER: household (frontend).
import { useMemo, useRef, useState } from "react";
import { CartesianGrid, Line, LineChart, ReferenceDot, ReferenceLine, Tooltip, XAxis, YAxis } from "recharts";

import { TICK, TOOLTIP_CARD } from "@/components/evaluate/chartTheme";
import { ProvenanceTip } from "@/components/evaluate/ProvenanceTip";
import { Term } from "@/components/glossary/Term";

import { errorText, householdApi } from "./api";
import { ActiveChart, CHART_WRAP } from "./charts";
import { compactUsd, kwh, num, pct0, signedUsd, usd0 } from "./fmt";
import type { ProfileDraft } from "./ProfileForm";
import type { HouseholdRequest, HouseholdResult, HouseholdWhatIf, SolarOptimizeCandidate, SolarOptimizeRequest, SolarOptimizeResult } from "./types";
import { Badge, Card, Field, FOCUS, LegendRow, NumberBox, StatTile } from "./ui";

const DEFAULT_ROOF_KW = 12;

/** The household as /plan sees it, minus the solar and battery what-ifs the optimizer chooses and the
 *  chart's time selection (neither changes the answer). */
function householdFor(req: HouseholdRequest): HouseholdRequest {
  const w = Object.fromEntries(Object.entries(req.whatif ?? {}).filter(([k, v]) => k !== "solar_kw" && k !== "battery_kwh" && v !== null && v !== undefined)) as HouseholdWhatIf;
  return { ...req, whatif: w };
}
const inputsKey = (body: SolarOptimizeRequest) => {
  const h: Partial<HouseholdRequest> = { ...body.household };
  delete h.view_month;
  delete h.view_day_type;
  delete h.view_hour;
  return JSON.stringify({ ...body, household: h });
};

/** The pick is within budget (the backend returns the cheapest option when nothing is). */
const withinBudget = (o: SolarOptimizeResult) =>
  o.candidates.find((c) => num(c.solar_kw) === num(o.solar_kw) && num(c.battery_kwh) === num(o.battery_kwh))?.feasible ?? true;

const sizeLabel = (kw: number, bat: number) => `${num(kw).toFixed(1).replace(/\.0$/, "")} kW solar${bat > 0 ? ` + ${num(bat).toFixed(1).replace(/\.0$/, "")} kWh battery` : ""}`;

const BINDING: Record<string, (o: { roof: number | null; budget: number | null }) => string> = {
  roof: ({ roof }) => `Roof room${roof ? ` (${roof} kW)` : ""}`,
  budget: ({ budget }) => `Your budget${budget ? ` (${usd0(budget)})` : ""}`,
  demand: () => "Your demand (more would mostly export)",
};

export function SolarOptimizer({
  r,
  draft,
  patchDraft,
  whatif,
  setWhatif,
  request,
}: {
  r: HouseholdResult;
  draft: ProfileDraft;
  patchDraft: (p: Partial<ProfileDraft>) => void;
  whatif: HouseholdWhatIf;
  setWhatif: (p: Partial<HouseholdWhatIf>) => void;
  request: HouseholdRequest;
}) {
  const [budget, setBudget] = useState<number | null>(null);
  const [withBattery, setWithBattery] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [res, setRes] = useState<{ out: SolarOptimizeResult; key: string; budget: number | null; roof: number | null } | null>(null);
  const ctrl = useRef<AbortController | null>(null);
  const renter = draft.tenure === "rent";

  const body: SolarOptimizeRequest = useMemo(
    () => ({ household: householdFor(request), budget_usd: budget, roof_kw_max: draft.roof_kw_max, include_battery: withBattery }),
    [request, budget, draft.roof_kw_max, withBattery],
  );
  const key = inputsKey(body);
  const stale = !!res && res.key !== key;

  const apply = (o: SolarOptimizeResult, force = false) => {
    if (!o.applicable || num(o.solar_kw) <= 0) return;
    // Nothing fits the budget: the card explains the cheapest option, and the sliders move only on request.
    if (!force && !withinBudget(o)) return;
    setWhatif({ solar_kw: num(o.solar_kw), battery_kwh: num(o.battery_kwh) > 0 ? num(o.battery_kwh) : null });
  };

  const run = () => {
    ctrl.current?.abort();
    const c = new AbortController();
    ctrl.current = c;
    setBusy(true);
    setError(null);
    const sent = { key, budget, roof: draft.roof_kw_max };
    householdApi
      .optimizeSolar(body, c.signal)
      .then((o) => {
        if (c.signal.aborted) return;
        setRes({ out: o, ...sent });
        apply(o);
      })
      .catch((e: unknown) => {
        if (c.signal.aborted) return;
        const t = errorText(e);
        setError(t.startsWith("404") ? "The optimizer isn't available on this server yet. The sliders below still work." : t);
      })
      .finally(() => {
        if (!c.signal.aborted) setBusy(false);
      });
  };

  const o = res?.out;
  const applied = !!o && o.applicable && num(whatif.solar_kw) === num(o.solar_kw) && num(whatif.battery_kwh) === num(o.battery_kwh);

  return (
    <Card
      title="Find the best system for my home"
      aside={
        <span className="flex items-center gap-1">
          Best 25-year value <ProvenanceTip label="Solar optimizer" provenance={o?.provenance ?? r.solar?.provenance ?? []} />
        </span>
      }
      className="border-2 border-emerald-700/25 dark:border-cyan-300/25"
    >
      <p className="text-xs leading-snug text-zinc-600 dark:text-zinc-300">
        Griddy tries every size from 1 kW up to your roof room in 0.5 kW steps{withBattery ? ", with and without a battery," : ""} and picks the one worth the most over 25 years for your use, your rate
        plan and the <Term k="nbt">Net Billing Tariff</Term>.
      </p>
      <div className="mt-3 grid grid-cols-2 gap-3">
        <Field label="Budget (optional)" hint="Upfront, after incentives. Empty = no limit.">
          <NumberBox value={budget} onChange={setBudget} min={0} max={500000} step={500} placeholder="No limit" unit="$" ariaLabel="Budget in dollars" />
        </Field>
        <Field label="Roof room" hint={`Same as your profile's roof room. Empty = up to ${DEFAULT_ROOF_KW} kW.`}>
          <NumberBox
            value={draft.roof_kw_max}
            onChange={(v) => patchDraft({ roof_kw_max: v })}
            min={1}
            max={30}
            step={0.5}
            placeholder="Not sure"
            unit="kW max"
            ariaLabel="Roof room in kW"
          />
        </Field>
      </div>
      <label className="mt-2 flex items-center gap-2 text-xs text-zinc-700 dark:text-zinc-300">
        <input type="checkbox" checked={withBattery} onChange={(e) => setWithBattery(e.target.checked)} className={`h-4 w-4 accent-emerald-700 dark:accent-cyan-300 ${FOCUS}`} />
        Include a battery (tries 5, 10, 13.5 and 15 kWh)
      </label>
      <button
        type="button"
        onClick={run}
        disabled={busy || renter}
        aria-busy={busy || undefined}
        className={`mt-3 w-full rounded-lg bg-emerald-800 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-900 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-cyan-300 dark:text-slate-950 dark:hover:bg-cyan-200 ${FOCUS}`}
      >
        {busy ? "Optimizing..." : res ? "Optimize again" : "Optimize for my home"}
      </button>
      {renter && (
        <p className="mt-2 text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">
          Off for renters: you usually can&apos;t add rooftop panels. If you own the home, set &ldquo;Own or rent?&rdquo; to Own under Advanced.
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 rounded-md border border-red-200 bg-red-50 px-2 py-1.5 text-xs text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          Couldn&apos;t optimize: {error}
        </p>
      )}
      <div role="status" className="sr-only">
        {busy ? "Optimizing solar size" : o ? (o.applicable ? `Recommended ${sizeLabel(o.solar_kw, o.battery_kwh)}` : o.reason) : ""}
      </div>
      {res && !busy && <OptimizeResult o={res.out} budget={res.budget} roof={res.roof} applied={applied} stale={stale} onApply={() => apply(res.out, true)} onRerun={run} usage={r.usage.annual_kwh} />}
    </Card>
  );
}

function OptimizeResult({
  o,
  budget,
  roof,
  applied,
  stale,
  onApply,
  onRerun,
  usage,
}: {
  o: SolarOptimizeResult;
  budget: number | null;
  roof: number | null;
  applied: boolean;
  stale: boolean;
  onApply: () => void;
  onRerun: () => void;
  usage: number;
}) {
  if (!o.applicable) {
    return <p className="mt-3 rounded-md bg-zinc-50 p-2 text-sm text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">{o.reason}</p>;
  }
  const pays = num(o.npv_usd) > 0;
  const prov = o.provenance;
  return (
    <div className="mt-3 space-y-2 border-t border-zinc-100 pt-3 dark:border-zinc-800">
      <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-emerald-900 dark:text-cyan-200">Recommended for your home</div>
          <div className="text-xl font-bold tabular-nums text-zinc-950 dark:text-white">{sizeLabel(o.solar_kw, o.battery_kwh)}</div>
        </div>
        <Badge tone={!withinBudget(o) ? "warn" : pays ? "ok" : "warn"}>{!withinBudget(o) ? "Over your budget" : pays ? "Pays for itself (estimate)" : "Doesn't pay back at these rates"}</Badge>
      </div>
      {stale && (
        <p className="flex flex-wrap items-center gap-x-2 rounded-md bg-amber-50 px-2 py-1 text-[11px] text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          Your home or inputs changed since this run.
          <button type="button" onClick={onRerun} className={`rounded font-semibold underline ${FOCUS}`}>
            Optimize again
          </button>
        </p>
      )}
      <div className="grid grid-cols-2 gap-2">
        <StatTile compact label="Upfront cost" tipLabel="Upfront cost" value={usd0(o.upfront_cost_usd)} sub={budget ? `after incentives · budget ${usd0(budget)}` : "installed, after incentives"} provenance={prov} />
        <StatTile compact label="Yearly savings" tipLabel="Yearly savings" value={`${usd0(o.annual_savings_usd)}/yr`} sub="on your bill, first year" provenance={prov} />
        <StatTile compact label={<Term k="payback">Payback</Term>} tipLabel="Payback" value={o.payback_years === null ? "never" : `${num(o.payback_years).toFixed(1)} yr`} sub="upfront ÷ yearly savings" provenance={prov} />
        <StatTile compact label="25-year value (NPV)" tipLabel="NPV" value={signedUsd(o.npv_usd).replace(/^\+/, "")} sub="after upfront cost, with rate growth" provenance={prov} />
        <StatTile compact label="Covers your use" tipLabel="Share of use offset" value={pct0(o.offset_share)} sub={`${kwh(o.annual_production_kwh)} of ${kwh(usage)} a year`} provenance={prov} />
        <StatTile
          compact
          label="Limited by"
          tipLabel="What limited the size"
          value={o.binding.length ? o.binding.map((b) => (b === "roof" ? "Roof" : b === "budget" ? "Budget" : b === "demand" ? "Demand" : b)).join(" + ") : "Value peak"}
          sub={o.binding.length ? o.binding.map((b) => BINDING[b]?.({ roof, budget }) ?? b).join("; ") : "bigger would earn less"}
          provenance={prov}
        />
      </div>
      <p className="text-sm leading-snug text-zinc-800 dark:text-zinc-200">{o.reason}</p>
      {applied ? (
        <p className="text-[11px] text-emerald-800 dark:text-emerald-300">✓ Set on the sliders below; the charts and numbers under them now show this system.</p>
      ) : (
        <button type="button" onClick={onApply} className={`rounded-md border border-zinc-300 px-2 py-1 text-xs text-zinc-700 hover:border-zinc-500 dark:border-zinc-700 dark:text-zinc-200 ${FOCUS}`}>
          {withinBudget(o) ? "Set the sliders to this size again" : "Try this size on the sliders anyway"}
        </button>
      )}
      {o.candidates.length > 1 && <NpvBySize o={o} />}
    </div>
  );
}

type Row = { kw: number; npv: number; c: SolarOptimizeCandidate };
type DotProps = { cx?: number; cy?: number; payload?: Row; index?: number };

/** NPV across solar sizes at the recommended battery size: where the value peaks and what the budget rules out. */
function NpvBySize({ o }: { o: SolarOptimizeResult }) {
  const rows = useMemo<Row[]>(
    () =>
      o.candidates
        .filter((c) => num(c.battery_kwh) === num(o.battery_kwh))
        .map((c) => ({ kw: num(c.solar_kw), npv: num(c.npv_usd), c }))
        .sort((a, b) => a.kw - b.kw),
    [o],
  );
  const best = useMemo(() => {
    const m = new Map<number, SolarOptimizeCandidate>();
    for (const c of o.candidates) {
      const cur = m.get(num(c.battery_kwh));
      if (c.feasible && (!cur || num(c.npv_usd) > num(cur.npv_usd))) m.set(num(c.battery_kwh), c);
    }
    return [...m.entries()].sort((a, b) => a[0] - b[0]);
  }, [o]);
  const anyOver = rows.some((x) => !x.c.feasible);
  if (rows.length < 2) return null;
  return (
    <div className="pt-1">
      <div className="text-xs font-semibold text-zinc-800 dark:text-zinc-200">25-year value by solar size{num(o.battery_kwh) > 0 ? `, with ${o.battery_kwh} kWh battery` : ", no battery"}</div>
      <div className={CHART_WRAP}>
        <div className="text-[10px] text-zinc-500 dark:text-zinc-400">NPV, $</div>
        <div className="h-40">
          <ActiveChart>
            <LineChart data={rows} margin={{ top: 8, right: 10, bottom: 0, left: 0 }}>
              <CartesianGrid vertical={false} stroke="var(--ev-grid)" />
              <XAxis type="number" dataKey="kw" domain={["dataMin", "dataMax"]} tick={TICK} tickLine={false} axisLine={{ stroke: "var(--ev-axis)" }} tickFormatter={(v: number) => `${v} kW`} />
              <YAxis width={46} tick={TICK} tickLine={false} axisLine={false} tickFormatter={compactUsd} />
              <ReferenceLine y={0} stroke="var(--ev-muted)" strokeDasharray="3 3" />
              <Line
                dataKey="npv"
                name="25-year NPV"
                stroke="var(--hh-solar)"
                strokeWidth={2}
                isAnimationActive={false}
                dot={(p: DotProps) => {
                  const { cx, cy, payload, index } = p;
                  if (cx === undefined || cy === undefined || !payload) return <g key={`d${index}`} />;
                  return payload.c.feasible ? (
                    <circle key={`d${index}`} cx={cx} cy={cy} r={2.5} fill="var(--hh-solar)" />
                  ) : (
                    <circle key={`d${index}`} cx={cx} cy={cy} r={3} fill="var(--hh-surface)" stroke="var(--ev-muted)" strokeWidth={1.5} />
                  );
                }}
                activeDot={{ r: 4, fill: "var(--hh-solar)", stroke: "var(--hh-surface)", strokeWidth: 2 }}
              />
              <ReferenceDot x={num(o.solar_kw)} y={num(o.npv_usd)} r={6} fill="var(--ev-accent)" stroke="var(--hh-surface)" strokeWidth={2} />
              <Tooltip
                cursor={{ stroke: "var(--ev-axis)", strokeWidth: 1 }}
                isAnimationActive={false}
                content={(t) => {
                  const row = t.active ? (t.payload?.[0]?.payload as Row | undefined) : undefined;
                  if (!row) return null;
                  return (
                    <div className={TOOLTIP_CARD}>
                      <div className="font-semibold">{sizeLabel(row.kw, row.c.battery_kwh)}</div>
                      <div className="tabular-nums">NPV {signedUsd(row.npv).replace(/^\+/, "")}</div>
                      <div className="tabular-nums text-zinc-500 dark:text-zinc-400">
                        {usd0(row.c.upfront_cost_usd)} upfront · payback {row.c.payback_years === null ? "never" : `${num(row.c.payback_years).toFixed(1)} yr`}
                      </div>
                      {!row.c.feasible && <div className="text-amber-700 dark:text-amber-300">Over your budget</div>}
                    </div>
                  );
                }}
              />
            </LineChart>
          </ActiveChart>
        </div>
        <LegendRow
          items={[
            { label: "25-year NPV at each size", color: "var(--hh-solar)", line: true },
            { label: "Recommended", color: "var(--ev-accent)" },
            ...(anyOver ? [{ label: "Hollow = over budget", color: "var(--ev-muted)" }] : []),
          ]}
        />
      </div>
      {best.length > 1 && (
        <table className="mt-2 w-full text-xs tabular-nums">
          <caption className="mb-0.5 text-left text-[11px] text-zinc-500 dark:text-zinc-400">Best solar size for each battery option{anyOver ? " (within budget)" : ""}</caption>
          <thead className="text-[11px] text-zinc-500 dark:text-zinc-400">
            <tr>
              <th className="py-0.5 text-left font-normal">Battery</th>
              <th className="py-0.5 text-right font-normal">Solar</th>
              <th className="py-0.5 text-right font-normal">Upfront</th>
              <th className="py-0.5 text-right font-normal">NPV</th>
            </tr>
          </thead>
          <tbody>
            {best.map(([bat, c]) => {
              const pick = bat === num(o.battery_kwh) && num(c.solar_kw) === num(o.solar_kw);
              return (
                <tr key={bat} className={`border-t border-zinc-100 dark:border-zinc-800 ${pick ? "font-semibold text-zinc-950 dark:text-white" : "text-zinc-700 dark:text-zinc-300"}`}>
                  <td className="py-0.5">
                    {bat > 0 ? `${bat} kWh` : "None"}
                    {pick ? " ★" : ""}
                  </td>
                  <td className="py-0.5 text-right">{num(c.solar_kw)} kW</td>
                  <td className="py-0.5 text-right">{usd0(c.upfront_cost_usd)}</td>
                  <td className="py-0.5 text-right">{signedUsd(c.npv_usd).replace(/^\+/, "")}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
