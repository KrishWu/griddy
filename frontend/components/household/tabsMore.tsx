"use client";
// Solar & battery, Outlook and Tips tabs of Griddy Home. OWNER: household (frontend).
import { useMemo } from "react";
import { CartesianGrid, Line, LineChart, Tooltip, XAxis, YAxis } from "recharts";

import { TICK, TOOLTIP_CARD } from "@/components/evaluate/chartTheme";
import { ProvenanceTip } from "@/components/evaluate/ProvenanceTip";
import { Term } from "@/components/glossary/Term";

import { ActiveChart, CHART_WRAP, DayChart, MonthBars } from "./charts";
import { compactUsd, kg, kwh, num, pct0, signedKg, signedUsd, usd0 } from "./fmt";
import type { ProfileDraft } from "./ProfileForm";
import { SolarOptimizer } from "./SolarOptimizer";
import type { HouseholdRequest, HouseholdResult, HouseholdWhatIf, Recommendation } from "./types";
import { Badge, Card, FOCUS, LegendRow, Notes, Slider, StatTile } from "./ui";

/** Solar 0 or 1 kW up (the optimizer's search range), battery 0 or 5–15 kWh: snap the gap to its floor. */
const snap = (v: number, floor: number) => (v > 0 && v < floor ? floor : v);

export function SolarTab({
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
  const s = r.solar;
  const renter = draft.tenure === "rent";
  const kw = whatif.solar_kw ?? 0;
  const bat = whatif.battery_kwh ?? 0;
  const existing = draft.has_solar && !kw;
  // 10 kW by default; room for a bigger roof or an optimizer pick (it searches up to 15 kW).
  const kwMax = Math.min(15, Math.max(10, Math.ceil(kw), Math.ceil(draft.roof_kw_max ?? 0)));
  return (
    <div className="grid gap-3">
      <SolarOptimizer r={r} draft={draft} patchDraft={patchDraft} whatif={whatif} setWhatif={setWhatif} request={request} />
      <Card title={existing ? "Your existing system, plus what-ifs" : "Size a system yourself"} aside={<Term k="nbt">Net Billing Tariff</Term>}>
        <div className="space-y-3">
          <Slider
            label="Rooftop solar"
            value={kw}
            min={0}
            max={kwMax}
            step={0.5}
            format={(v) => (v === 0 ? (draft.has_solar ? "existing only" : "none") : `${v} kW`)}
            onChange={(v) => setWhatif({ solar_kw: snap(v, 1) || null })}
            changed={kw > 0}
            onReset={() => setWhatif({ solar_kw: null, battery_kwh: null })}
            hint={draft.roof_kw_max ? `Your roof fits about ${draft.roof_kw_max} kW.` : `0, or 1 to ${kwMax} kW. A typical home system is 4 to 7 kW.`}
          />
          <Slider
            label="Home battery"
            value={bat}
            min={0}
            max={15}
            step={0.5}
            format={(v) => (v === 0 ? "none" : `${v} kWh`)}
            onChange={(v) => setWhatif({ battery_kwh: snap(v, 5) || null, ...(v > 0 && !kw && !draft.has_solar ? { solar_kw: 5 } : {}) })}
            changed={bat > 0}
            onReset={() => setWhatif({ battery_kwh: null })}
            hint="0, or 5 to 15 kWh. Charges from solar, then serves your peak-price hours."
          />
          {!s && !renter && (
            <div className="flex flex-wrap gap-2">
              {[
                { label: "Try 5 kW", p: { solar_kw: 5, battery_kwh: null } },
                { label: "5 kW + 10 kWh battery", p: { solar_kw: 5, battery_kwh: 10 } },
              ].map((b) => (
                <button
                  key={b.label}
                  type="button"
                  onClick={() => setWhatif(b.p)}
                  className={`rounded-md border border-zinc-300 px-2 py-1 text-xs text-zinc-700 hover:border-zinc-500 dark:border-zinc-700 dark:text-zinc-200 dark:hover:border-zinc-500 ${FOCUS}`}
                >
                  {b.label}
                </button>
              ))}
            </div>
          )}
        </div>
        <Notes
          items={[
            "Production: NREL PVWatts v8 for the nearest city, roof mount, 20° tilt, facing south, 14% losses.",
            "Solar you use yourself saves that hour's retail price; exports earn PG&E's hourly export credit, applied to energy charges within the year (no cash-out).",
          ]}
        />
      </Card>

      {renter || (s && !s.applicable) ? (
        <Card title="Rooftop solar doesn't fit this home">
          <p className="text-sm text-zinc-700 dark:text-zinc-300">
            {s?.note ?? "Renters usually can't add rooftop panels."} Options: community solar, or a greener plan from your provider
            {draft.utility === "pge_svce" ? " (SVCE GreenPrime is 100% renewable)" : ""}.
          </p>
        </Card>
      ) : !s ? (
        <Card title="Pick a size to see the numbers">
          <p className="text-sm text-zinc-600 dark:text-zinc-300">Production vs your load, bill before and after, payback and 25-year value appear here once you choose a system size.</p>
        </Card>
      ) : (
        <SolarResults r={r} />
      )}
    </div>
  );
}

function SolarResults({ r }: { r: HouseholdResult }) {
  const s = r.solar!;
  const selfShare = s.annual_production_kwh > 0 ? s.self_consumed_kwh / s.annual_production_kwh : 0;
  return (
    <div className="min-w-0 space-y-3">
      <div className="grid grid-cols-2 gap-2">
        <StatTile label="Yearly savings" value={usd0(s.annual_savings_usd)} sub={`${usd0(s.bill_before_usd)} → ${usd0(s.bill_after_usd)} bill`} provenance={s.provenance} tipLabel="Solar savings" />
        <StatTile
          label={<Term k="payback">Payback</Term>}
          tipLabel="Payback"
          value={s.payback_years === null ? "never" : `${num(s.payback_years).toFixed(1)} yr`}
          sub={`${usd0(s.upfront_cost_usd)} upfront${s.incentives_usd > 0 ? `, ${usd0(s.incentives_usd)} incentives` : ", no incentives"}`}
          provenance={s.provenance}
        />
        <StatTile label="25-year value (NPV)" value={signedUsd(s.npv_usd).replace(/^\+/, "")} sub="after upfront cost, with rate growth" provenance={s.provenance} tipLabel="NPV" />
        <StatTile label="CO2e avoided" value={`${kg(s.annual_kg_saved)}/yr`} sub="grid hours your solar displaces" provenance={[...s.provenance, ...r.carbon.provenance]} tipLabel="Solar CO2e" />
      </div>
      <Card
        title={`${s.kw} kW solar${s.battery_kwh > 0 ? ` + ${s.battery_kwh} kWh battery` : ""}: production vs your use`}
        aside={`${kwh(s.annual_production_kwh)} a year`}
      >
        <DayChart
          unit={`kWh in each hour · ${r.time_view?.label ?? "annual average day"}`}
          highlightHours={r.time_view ? [r.time_view.hour] : undefined}
          format={(v) => `${v.toFixed(2)} kWh`}
          series={[
            { key: "solar", label: `Solar · ${r.time_view?.label ?? "annual average"}`, color: "var(--hh-solar)", values: r.time_view?.solar_kwh ?? s.avg_day_production_kwh, kind: "area" },
            { key: "load", label: "Your use", color: "var(--hh-ink)", values: r.time_view?.load_kwh ?? r.usage.avg_day_kwh.all },
          ]}
        />
        <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
          <div>
            <div className="text-[11px] text-zinc-500 dark:text-zinc-400">
              <Term k="self_consumption">Used at home</Term>
            </div>
            <div className="font-semibold tabular-nums">
              {kwh(s.self_consumed_kwh)} · {pct0(selfShare)}
            </div>
          </div>
          <div>
            <div className="text-[11px] text-zinc-500 dark:text-zinc-400">Exported</div>
            <div className="font-semibold tabular-nums">{kwh(s.exported_kwh)}</div>
          </div>
          <div>
            <div className="text-[11px] text-zinc-500 dark:text-zinc-400">
              <Term k="export_credit">Export credit</Term>
            </div>
            <div className="font-semibold tabular-nums">{usd0(s.export_credit_usd)}/yr</div>
          </div>
          <div>
            <div className="text-[11px] text-zinc-500 dark:text-zinc-400">From battery</div>
            <div className="font-semibold tabular-nums">{s.battery_kwh > 0 ? kwh(s.battery_discharge_kwh) : "—"}</div>
          </div>
        </div>
        <Notes items={[s.note, r.location.solar_profile_city ? `Solar profile: ${r.location.solar_profile_city}${r.location.note ? ` (${r.location.note})` : ""}.` : null]} />
      </Card>
      <Card title="Production by month" aside="PVWatts typical year">
        <MonthBars values={s.monthly_production_kwh} color="var(--hh-solar)" unit="kWh per month" format={kwh} height="h-36" />
      </Card>
    </div>
  );
}

export function OutlookTab({ r, whatif, setWhatif }: { r: HouseholdResult; whatif: HouseholdWhatIf; setWhatif: (p: Partial<HouseholdWhatIf>) => void }) {
  const p = r.projection;
  const rows = useMemo(
    () => p.years.map((y, i) => ({ y, base: num(p.baseline_usd[i]), act: num(p.with_actions_usd[i]), solar: p.with_solar_usd ? num(p.with_solar_usd[i]) : undefined, cum: num(p.cumulative_savings_usd[i]) })),
    [p],
  );
  const years = whatif.years ?? p.years.length ?? 20;
  const esc = whatif.rate_escalation_pct ?? p.escalation_pct;
  const sum = (a: number[] | null) => (a ? a.reduce((x, v) => x + num(v), 0) : 0);
  const last = rows[rows.length - 1];
  const series = [
    { key: "base", label: "As you live today", color: "var(--ev-total)", dashed: true },
    { key: "act", label: "With your what-if changes", color: "var(--hh-actions)" },
    ...(p.with_solar_usd ? [{ key: "solar", label: "With solar", color: "var(--hh-solar)" }] : []),
  ];
  return (
    <div className="grid gap-3">
      <Card title="Assumptions you can change">
        <div className="space-y-3">
          <Slider label="Years ahead" value={years} min={5} max={20} format={(v) => `${v} years`} onChange={(v) => setWhatif({ years: v })} changed={whatif.years != null} onReset={() => setWhatif({ years: null })} />
          <Slider
            label="Electricity prices rise"
            value={esc}
            min={0}
            max={10}
            step={0.5}
            format={(v) => `${v.toFixed(1)}% / yr`}
            onChange={(v) => setWhatif({ rate_escalation_pct: v })}
            changed={whatif.rate_escalation_pct != null}
            onReset={() => setWhatif({ rate_escalation_pct: null })}
            hint={
              <>
                Default from recent California residential rate growth <ProvenanceTip label="Rate escalation" provenance={p.provenance} />
              </>
            }
          />
        </div>
        <div className="mt-3 space-y-1 text-xs tabular-nums">
          <div className="flex justify-between">
            <span className="text-zinc-500 dark:text-zinc-400">Total, as today</span>
            <span className="font-semibold">{usd0(sum(p.baseline_usd))}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-zinc-500 dark:text-zinc-400">Total, with changes</span>
            <span className="font-semibold">{usd0(sum(p.with_actions_usd))}</span>
          </div>
          {p.with_solar_usd && (
            <div className="flex justify-between">
              <span className="text-zinc-500 dark:text-zinc-400">Total, with solar (bills only)</span>
              <span className="font-semibold">{usd0(sum(p.with_solar_usd))}</span>
            </div>
          )}
          {last && (
            <div className="flex justify-between border-t border-zinc-100 pt-1 dark:border-zinc-800">
              <span className="text-zinc-500 dark:text-zinc-400">Cumulative savings by year {last.y}</span>
              <span className="font-semibold text-emerald-800 dark:text-emerald-300">{usd0(last.cum)}</span>
            </div>
          )}
        </div>
      </Card>
      <Card title="Your electricity bill, year by year" aside="Estimate in today's rates, escalated">
        <div className={CHART_WRAP}>
          <div className="text-[10px] text-zinc-500 dark:text-zinc-400">$ per year</div>
          <div className="h-64">
            <ActiveChart>
              <LineChart data={rows} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid vertical={false} stroke="var(--ev-grid)" />
                <XAxis dataKey="y" tick={TICK} tickLine={false} axisLine={{ stroke: "var(--ev-axis)" }} tickFormatter={(y: number) => `yr ${y}`} minTickGap={16} />
                <YAxis width={46} tick={TICK} tickLine={false} axisLine={false} tickFormatter={compactUsd} />
                {/* Drawn in reverse so the dashed "today" line stays visible on top when nothing changes. */}
                {[...series].reverse().map((s) => (
                  <Line
                    key={s.key}
                    dataKey={s.key}
                    name={s.label}
                    stroke={s.color}
                    strokeWidth={2}
                    strokeDasharray={"dashed" in s && s.dashed ? "4 3" : undefined}
                    dot={false}
                    activeDot={{ r: 4, fill: s.color, stroke: "var(--hh-surface)", strokeWidth: 2 }}
                    isAnimationActive={false}
                  />
                ))}
                <Tooltip
                  cursor={{ stroke: "var(--ev-axis)", strokeWidth: 1 }}
                  isAnimationActive={false}
                  content={(t) => {
                    const row = t.active ? rows.find((x) => x.y === t.label) : undefined;
                    if (!row) return null;
                    return (
                      <div className={TOOLTIP_CARD}>
                        <div className="mb-0.5 text-zinc-500 dark:text-zinc-400">Year {row.y}</div>
                        {series.map((s) => (
                          <div key={s.key} className="flex items-center gap-1.5 tabular-nums">
                            <span className="inline-block w-2.5 border-t-2" style={{ borderColor: s.color }} />
                            <span className="font-medium">{usd0(row[s.key as "base" | "act" | "solar"] ?? 0)}</span>
                            <span className="text-zinc-500 dark:text-zinc-400">{s.label}</span>
                          </div>
                        ))}
                        <div className="mt-0.5 text-zinc-500 dark:text-zinc-400">Saved so far: {usd0(row.cum)}</div>
                      </div>
                    );
                  }}
                />
              </LineChart>
            </ActiveChart>
          </div>
          <LegendRow items={series.map((s) => ({ key: s.key, label: s.label, color: s.color, line: true, dashed: "dashed" in s && !!s.dashed }))} />
        </div>
        <Notes items={[`Prices rise ${p.escalation_pct.toFixed(1)}% a year; solar output falls slowly with panel aging. Solar line shows bills only (upfront cost is in payback and NPV).`]} />
      </Card>
    </div>
  );
}

const EFFORT: Record<Recommendation["effort"], { label: string; tone: "ok" | "info" | "warn" }> = {
  easy: { label: "Easy", tone: "ok" },
  moderate: { label: "Some effort", tone: "info" },
  investment: { label: "Investment", tone: "warn" },
};

export function TipsTab({ r }: { r: HouseholdResult }) {
  const recs = [...r.recommendations].sort((a, b) => num(b.annual_usd_saved) - num(a.annual_usd_saved));
  return (
    <div className="space-y-3">
      {recs.length === 0 ? (
        <Card>
          <p className="text-sm text-zinc-600 dark:text-zinc-300">No changes stand out for this home. Try adding an EV, AC or solar under Advanced.</p>
        </Card>
      ) : (
        <ul className="grid gap-3">
          {recs.map((x) => {
            const e = EFFORT[x.effort] ?? EFFORT.moderate;
            return (
              <li key={x.id} className="flex min-w-0 flex-col rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-950">
                <div className="flex items-start justify-between gap-2">
                  <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">{x.title}</h3>
                  <Badge tone={e.tone}>{e.label}</Badge>
                </div>
                <p className="mt-1 flex-1 text-xs leading-snug text-zinc-600 dark:text-zinc-300">{x.detail}</p>
                <div className="mt-2 flex flex-wrap gap-x-3 gap-y-0.5 text-xs tabular-nums">
                  <span className={num(x.annual_usd_saved) >= 0 ? "font-semibold text-emerald-800 dark:text-emerald-300" : "font-semibold text-red-700 dark:text-red-300"}>{signedUsd(x.annual_usd_saved)}/yr</span>
                  <span className={num(x.annual_kg_saved) >= 0 ? "text-emerald-800 dark:text-emerald-300" : "text-red-700 dark:text-red-300"}>{signedKg(x.annual_kg_saved)} CO2e/yr</span>
                  {x.upfront_usd ? <span className="text-zinc-500 dark:text-zinc-400">{usd0(x.upfront_usd)} upfront</span> : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <Card title="How Griddy Home got these numbers" aside={`${r.assumptions.length} assumptions`}>
        <ul className="divide-y divide-zinc-100 text-xs dark:divide-zinc-800">
          {r.assumptions.map((a) => (
            <li key={a.key} className="flex items-start justify-between gap-3 py-1.5">
              <span className="text-zinc-600 dark:text-zinc-400">{a.label}</span>
              <span className="flex items-center gap-1 text-right text-zinc-800 dark:text-zinc-200">
                {a.value} <ProvenanceTip label={a.label} provenance={a.provenance} />
              </span>
            </li>
          ))}
        </ul>
        <Notes items={["Screening estimates from published rates and averages, not a utility bill or an installer quote.", "Holidays are treated as ordinary weekdays.", ...r.warnings]} />
      </Card>
    </div>
  );
}
