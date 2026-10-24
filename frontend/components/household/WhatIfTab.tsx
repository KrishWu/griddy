"use client";
// What-if: behaviour controls (each change re-plans after ~250 ms) and the cost-vs-carbon map of the
// auto-generated scenarios, so trade-offs like "midnight EV charging is cheap but uses a gas-heavier
// grid" are visible at a glance. OWNER: household (frontend).
import { useMemo } from "react";
import { CartesianGrid, ReferenceLine, Scatter, ScatterChart, Tooltip, XAxis, YAxis, ZAxis } from "recharts";

import { TICK, TOOLTIP_CARD } from "@/components/evaluate/chartTheme";
import { Term } from "@/components/glossary/Term";

import { ActiveChart, CHART_WRAP } from "./charts";
import { compactUsd, hourLabel, kg, kwh, niceTicks, num, signedKg, signedUsd, usd0 } from "./fmt";
import { DEFAULT_HOURS, isPge, type ProfileDraft } from "./ProfileForm";
import { shortPlan } from "./theme";
import type { HouseholdOptions, HouseholdResult, HouseholdWhatIf } from "./types";
import { Card, FOCUS, INPUT, LegendRow, Slider } from "./ui";

interface Pt {
  n: number;
  id: string;
  label: string;
  usd: number;
  kg: number;
  combined?: boolean;
}

type DotProps = { cx?: number; cy?: number; payload?: Pt };

function Dot({ cx, cy, payload }: DotProps) {
  if (cx === undefined || cy === undefined || !payload) return null;
  const fill = payload.combined ? "var(--ev-operating)" : "var(--ev-accent)";
  return (
    <g>
      <circle cx={cx} cy={cy} r={payload.combined ? 9 : 8} fill={fill} stroke="var(--hh-surface)" strokeWidth={2} />
      <text x={cx} y={cy} dy="0.35em" textAnchor="middle" fontSize={9} fontWeight={700} fill="#ffffff">
        {payload.combined ? "★" : payload.n}
      </text>
    </g>
  );
}

export function WhatIfTab({
  r,
  draft,
  whatif,
  setWhatif,
  options,
  pending,
}: {
  r: HouseholdResult;
  draft: ProfileDraft;
  whatif: HouseholdWhatIf;
  setWhatif: (patch: Partial<HouseholdWhatIf>) => void;
  options: HouseholdOptions | null;
  pending: boolean;
}) {
  const scen = useMemo(() => r.whatif.scenarios.filter((s) => s.applicable), [r.whatif.scenarios]);
  const notApplicable = r.whatif.scenarios.filter((s) => !s.applicable);
  const anyControl = Object.entries(whatif).some(([k, v]) => v !== null && v !== undefined && k !== "years" && k !== "rate_escalation_pct" && !(k === "ac_setpoint_delta_f" && v === 0));
  const pts: Pt[] = useMemo(() => {
    const p: Pt[] = scen.map((s, i) => ({ n: i + 1, id: s.id, label: s.label, usd: num(s.annual_usd_saved), kg: num(s.annual_kg_saved) }));
    if (anyControl) p.push({ n: 0, id: "combined", label: "Your what-if (all controls)", usd: num(r.whatif.combined.annual_usd_saved), kg: num(r.whatif.combined.annual_kg_saved), combined: true });
    return p;
  }, [scen, anyControl, r.whatif.combined]);

  const xTicks = useMemo(() => niceTicks(Math.min(0, ...pts.map((p) => p.usd)), Math.max(0, ...pts.map((p) => p.usd)), 5), [pts]);
  const yTicks = useMemo(() => niceTicks(Math.min(0, ...pts.map((p) => p.kg)), Math.max(0, ...pts.map((p) => p.kg)), 4), [pts]);
  const hourSetter = (key: "ev_charge_start_hour" | "laundry_hour" | "dishwasher_hour", current: number) => (v: number) => setWhatif({ [key]: v === current ? null : v });
  const evNow = draft.ev_start ?? DEFAULT_HOURS.ev;
  const laundryNow = draft.laundry_hour ?? DEFAULT_HOURS.laundry;
  const dishNow = draft.dishwasher_hour ?? DEFAULT_HOURS.dishwasher;
  const plans = (options?.plans ?? []).filter((p) => p.utility === "pge" || p.utility === draft.utility);
  const c = r.whatif.combined;
  const base = r.whatif.baseline;

  return (
    <div className="grid gap-3">
      <Card title="Try a change" aside={pending ? <span role="status">Updating...</span> : "Updates as you drag"}>
        <div className="space-y-3">
          {draft.has_ev ? (
            <Slider
              label="EV starts charging at"
              value={whatif.ev_charge_start_hour ?? evNow}
              min={0}
              max={23}
              format={hourLabel}
              onChange={hourSetter("ev_charge_start_hour", evNow)}
              changed={whatif.ev_charge_start_hour != null}
              onReset={() => setWhatif({ ev_charge_start_hour: null })}
              hint={`Now: ${hourLabel(evNow)}. Midnight is cheapest; late morning is cleanest if the car is home.`}
            />
          ) : (
            <p className="text-[11px] text-zinc-500 dark:text-zinc-400">Have an EV? Turn it on under Advanced to try charging times.</p>
          )}
          <Slider
            label="Laundry at"
            value={whatif.laundry_hour ?? laundryNow}
            min={0}
            max={23}
            format={hourLabel}
            onChange={hourSetter("laundry_hour", laundryNow)}
            changed={whatif.laundry_hour != null}
            onReset={() => setWhatif({ laundry_hour: null })}
            hint={`Now: ${hourLabel(laundryNow)}.`}
          />
          <Slider
            label="Dishwasher at"
            value={whatif.dishwasher_hour ?? dishNow}
            min={0}
            max={23}
            format={hourLabel}
            onChange={hourSetter("dishwasher_hour", dishNow)}
            changed={whatif.dishwasher_hour != null}
            onReset={() => setWhatif({ dishwasher_hour: null })}
            hint={`Now: ${hourLabel(dishNow)}.`}
          />
          {draft.ac !== "no" && (
            <Slider
              label="AC setpoint change"
              value={whatif.ac_setpoint_delta_f ?? 0}
              min={-4}
              max={6}
              format={(v) => (v === 0 ? "no change" : `${v > 0 ? "+" : "−"}${Math.abs(v)} °F`)}
              onChange={(v) => setWhatif({ ac_setpoint_delta_f: v === 0 ? null : v })}
              changed={!!whatif.ac_setpoint_delta_f}
              onReset={() => setWhatif({ ac_setpoint_delta_f: null })}
              hint="Warmer in summer = less cooling energy (a cited % per °F)."
            />
          )}
          {isPge(draft.utility) && plans.length > 0 && (
            <div>
              <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300" htmlFor="hh-whatif-plan">
                Rate plan
              </label>
              <select id="hh-whatif-plan" className={`mt-1 ${INPUT}`} value={whatif.rate_plan ?? ""} onChange={(e) => setWhatif({ rate_plan: e.target.value || null })}>
                <option value="">Keep {r.bill.plan}</option>
                {plans
                  .filter((p) => p.id !== r.bill.plan)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      Switch to {shortPlan(p.label)}
                    </option>
                  ))}
              </select>
            </div>
          )}
          <p className="text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">Solar and battery sizes are on the Solar &amp; battery tab; they count here too.</p>
          {anyControl && (
            <button type="button" onClick={() => setWhatif({ ev_charge_start_hour: null, laundry_hour: null, dishwasher_hour: null, ac_setpoint_delta_f: null, rate_plan: null, solar_kw: null, battery_kwh: null })} className={`rounded text-[11px] text-zinc-600 underline dark:text-zinc-300 ${FOCUS}`}>
              Reset all changes
            </button>
          )}
        </div>
        <div className="mt-3 rounded-md bg-zinc-50 p-2 text-xs dark:bg-zinc-900">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Your what-if, all controls together</div>
          <div className="mt-1 grid grid-cols-2 gap-2 tabular-nums">
            <div>
              <div className="text-[11px] text-zinc-500 dark:text-zinc-400">Bill</div>
              <div className="font-semibold">{usd0(c.annual_usd)}/yr</div>
              <div className={num(c.annual_usd_saved) >= 0 ? "text-emerald-800 dark:text-emerald-300" : "text-red-700 dark:text-red-300"}>{signedUsd(c.annual_usd_saved)} saved</div>
            </div>
            <div>
              <div className="text-[11px] text-zinc-500 dark:text-zinc-400">Grid CO2e</div>
              <div className="font-semibold">{kg(c.annual_kg)}/yr</div>
              <div className={num(c.annual_kg_saved) >= 0 ? "text-emerald-800 dark:text-emerald-300" : "text-red-700 dark:text-red-300"}>{signedKg(c.annual_kg_saved)} avoided</div>
            </div>
          </div>
          <div className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">
            vs today: {usd0(base.annual_usd)} and {kg(base.annual_kg)} on {kwh(base.annual_kwh)}
          </div>
        </div>
      </Card>

      <Card title="Cost vs carbon: one change at a time" aside="Each dot vs how you live today">
        <div className={CHART_WRAP}>
          <div className="text-[10px] text-zinc-500 dark:text-zinc-400">kg CO2e avoided per year ↑</div>
          <div className="h-64">
            <ActiveChart>
              <ScatterChart margin={{ top: 10, right: 14, bottom: 4, left: 0 }}>
                <CartesianGrid stroke="var(--ev-grid)" />
                <XAxis type="number" dataKey="usd" name="$ saved" tick={TICK} tickLine={false} axisLine={{ stroke: "var(--ev-axis)" }} tickFormatter={compactUsd} ticks={xTicks} domain={[xTicks[0], xTicks[xTicks.length - 1]]} interval={0} />
                <YAxis type="number" dataKey="kg" name="kg avoided" width={44} tick={TICK} tickLine={false} axisLine={false} tickFormatter={(v: number) => `${v < 0 ? "−" : ""}${Math.abs(v) >= 1000 ? `${(Math.abs(v) / 1000).toFixed(1).replace(/\.0$/, "")}t` : Math.round(Math.abs(v))}`} ticks={yTicks} domain={[yTicks[0], yTicks[yTicks.length - 1]]} interval={0} />
                <ZAxis range={[160, 160]} />
                <ReferenceLine x={0} stroke="var(--ev-muted)" strokeDasharray="3 3" />
                <ReferenceLine y={0} stroke="var(--ev-muted)" strokeDasharray="3 3" />
                <Scatter data={pts} shape={(p: unknown) => <Dot {...(p as DotProps)} />} isAnimationActive={false} />
                <Tooltip
                  cursor={false}
                  isAnimationActive={false}
                  content={(p) => {
                    const d = p.active ? (p.payload?.[0]?.payload as Pt | undefined) : undefined;
                    if (!d) return null;
                    const s = r.whatif.scenarios.find((x) => x.id === d.id);
                    return (
                      <div className={`${TOOLTIP_CARD} max-w-[220px]`}>
                        <div className="font-semibold">{d.label}</div>
                        <div className="tabular-nums">
                          {signedUsd(d.usd)}/yr · {signedKg(d.kg)} CO2e/yr
                        </div>
                        {s?.detail && <div className="mt-0.5 text-zinc-500 dark:text-zinc-400">{s.detail}</div>}
                      </div>
                    );
                  }}
                />
              </ScatterChart>
            </ActiveChart>
          </div>
          <div className="text-right text-[10px] text-zinc-500 dark:text-zinc-400">$ saved per year →</div>
          <LegendRow
            items={[
              { label: "Single change (numbered below)", color: "var(--ev-accent)" },
              ...(anyControl ? [{ label: "★ Your what-if, all controls together", color: "var(--ev-operating)" }] : []),
            ]}
          />
        </div>
        <p className="mt-2 text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">
          Top right saves money and carbon. Bottom right is cheaper but dirtier: overnight hours are off-peak on a <Term k="tou">time-of-use</Term> plan, but the grid runs on more gas
          and imports then than at midday.
        </p>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[420px] text-xs tabular-nums">
            <thead className="text-[11px] text-zinc-500 dark:text-zinc-400">
              <tr>
                <th className="py-1 text-left font-normal">#</th>
                <th className="py-1 text-left font-normal">Change</th>
                <th className="whitespace-nowrap py-1 pl-2 text-right font-normal">$/yr</th>
                <th className="whitespace-nowrap py-1 pl-2 text-right font-normal">kg CO2e/yr</th>
                <th className="whitespace-nowrap py-1 pl-2 text-right font-normal">kWh/yr</th>
              </tr>
            </thead>
            <tbody>
              {scen.map((s, i) => (
                <tr key={s.id} className="border-t border-zinc-100 align-top dark:border-zinc-800">
                  <td className="py-1 pr-1 text-zinc-500 dark:text-zinc-400">{i + 1}</td>
                  <td className="py-1 pr-2">
                    <div className="font-medium text-zinc-800 dark:text-zinc-200">{s.label}</div>
                    <div className="text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">
                      {s.detail}
                      {s.assumption ? ` · ${s.assumption}` : ""}
                      {s.preserves_total_kwh ? " · same total kWh, shifted in time" : ""}
                    </div>
                  </td>
                  <td className={`whitespace-nowrap py-1 pl-2 text-right ${s.annual_usd_saved >= 0 ? "text-emerald-800 dark:text-emerald-300" : "text-red-700 dark:text-red-300"}`}>{signedUsd(s.annual_usd_saved)}</td>
                  <td className={`whitespace-nowrap py-1 pl-2 text-right ${s.annual_kg_saved >= 0 ? "text-emerald-800 dark:text-emerald-300" : "text-red-700 dark:text-red-300"}`}>{signedKg(s.annual_kg_saved)}</td>
                  <td className="whitespace-nowrap py-1 pl-2 text-right text-zinc-600 dark:text-zinc-300">{s.preserves_total_kwh || Math.round(num(s.annual_kwh_change)) === 0 ? "0" : `${num(s.annual_kwh_change) < 0 ? "−" : "+"}${Math.abs(Math.round(num(s.annual_kwh_change))).toLocaleString()}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {notApplicable.length > 0 && (
            <p className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">Not applicable to your home: {notApplicable.map((s) => s.label).join(", ")}.</p>
          )}
          <p className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">Positive = saves money / avoids CO2e. kWh change is grid electricity (solar lowers it).</p>
        </div>
      </Card>
    </div>
  );
}
