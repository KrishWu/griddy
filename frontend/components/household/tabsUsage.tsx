"use client";
// Usage, Costs and Sources & carbon tabs of Griddy Home. OWNER: household (frontend).

import { ProvenanceTip } from "@/components/evaluate/ProvenanceTip";
import { Term } from "@/components/glossary/Term";

import { DayChart, HBars, HourBars, MonthBars, TableView, CHART_WRAP } from "./charts";
import { cents, hourLabel, kg, kwh, num, pct0, usd0 } from "./fmt";
import { MixChart } from "./MixChart";
import { endUseLabel, MONTHS, periodLabel, RESOURCE_GROUPS, resourceGroup, resourceLabel, shortPlan } from "./theme";
import type { HouseholdResult, Prov } from "./types";
import { Badge, Card, LegendRow, Notes } from "./ui";

/** Where the load curve came from (meter data or a simulation), plus the benchmark it's compared with. */
export function loadProvenance(r: HouseholdResult): Prov[] {
  const metered = r.load_source === "interval_data";
  return [
    {
      kind: metered ? "observed" : "simulated",
      source: r.load_label,
      note: metered ? "Your meter data, averaged by month, weekday/weekend and hour." : "Simulated load curve: an estimate, not your meter's readings.",
    },
    r.usage.benchmark.provenance,
  ];
}

export function SimulatedBadge({ r }: { r: HouseholdResult }) {
  if (r.load_source === "interval_data") return <Badge tone="ok">From your meter data</Badge>;
  return (
    <Badge tone="warn" title={r.load_label}>
      Simulated <Term k="load_curve">load curve</Term>
    </Badge>
  );
}

export function UsageTab({ r }: { r: HouseholdResult }) {
  const u = r.usage;
  const v = r.time_view;
  const endUses = Object.entries(u.by_end_use_kwh ?? {})
    .filter(([, v]) => num(v) > 0)
    .sort((a, b) => num(b[1]) - num(a[1]));
  const total = endUses.reduce((a, [, v]) => a + num(v), 0) || 1;
  const vsBench = u.benchmark.ca_avg_annual_kwh > 0 ? u.annual_kwh / u.benchmark.ca_avg_annual_kwh : 0;
  return (
    <div className="grid gap-3">
      <Card

        title={
          <>
            Your average day (<Term k="kwh">kWh</Term> per hour)
          </>
        }
        aside={
          <span className="flex flex-wrap items-center gap-2">
            <SimulatedBadge r={r} />
            <ProvenanceTip label="Your load curve" provenance={loadProvenance(r)} />
          </span>
        }
      >
        <DayChart
          unit={`kWh in each hour · ${v?.label ?? "annual average day"}`}
          format={(v) => `${v.toFixed(2)} kWh`}
          periods={v?.periods_by_hour}
          highlightHours={v ? [v.hour] : undefined}
          bandNote={
            <>
              Shaded: <Term k="tou_periods">peak / part-peak</Term> hours for {r.bill.plan}. Mixed periods across the selection are not shaded.
            </>
          }
          series={[
            { key: "selected", label: v?.label ?? "Average day", color: "var(--ev-accent)", values: v?.load_kwh ?? u.avg_day_kwh.all },
            { key: "annual", label: "Annual average day", color: "var(--ev-context)", values: u.avg_day_kwh.all, thin: true, dashed: true },
          ]}
        />
        <p className="mt-2 text-xs text-zinc-600 dark:text-zinc-300">
          Your busiest hour is <strong>{hourLabel(u.peak_hour)}</strong>; {pct0(u.peak_window_share)} of your electricity lands in the peak-price window. {r.load_label}.
        </p>
        <TableView
          summary="Table view (24 hours)"
          head={["Hour", "Summer kWh", "Winter kWh", "Year kWh"]}
          rows={Array.from({ length: 24 }, (_, h) => [hourLabel(h), num(u.avg_day_kwh.summer[h]).toFixed(2), num(u.avg_day_kwh.winter[h]).toFixed(2), num(u.avg_day_kwh.all[h]).toFixed(2)])}
        />
      </Card>

      <Card title="Month by month" aside={`${kwh(u.annual_kwh)} a year`}>
        <MonthBars values={u.monthly_kwh} color="var(--ev-accent)" unit="kWh per month" format={kwh} />
        <p className="mt-2 text-xs text-zinc-600 dark:text-zinc-300">
          That&apos;s {vsBench > 0 ? `${vsBench >= 1 ? `${(vsBench * 100 - 100).toFixed(0)}% more than` : `${(100 - vsBench * 100).toFixed(0)}% less than`}` : "compared with"} {u.benchmark.label} ({kwh(u.benchmark.ca_avg_annual_kwh)}){" "}
          <ProvenanceTip label="California benchmark" provenance={u.benchmark.provenance} />.
        </p>
      </Card>

      <Card title="Where it goes" aside="Estimated split by end use">
        <HBars
          ariaLabel="Annual kWh by end use"
          rows={endUses.map(([k, v], i) => ({
            key: k,
            label: endUseLabel(k),
            value: num(v),
            display: `${kwh(num(v))} · ${pct0(num(v) / total)}`,
            color: k === "base" ? "var(--ev-context)" : ["var(--ev-accent)", "var(--ev-operating)", "var(--ev-credit)", "var(--hh-solar)", "var(--hh-battery)"][i % 5],
          }))}
        />
        <Notes items={["End uses are modelled from your Advanced answers (or typical defaults), then the rest is scaled to match your total.", r.load_source === "interval_data" ? "Your meter data sets the total and the hourly shape." : null]} />
      </Card>
    </div>
  );
}

export function CostsTab({ r }: { r: HouseholdResult }) {
  const b = r.bill;
  const plans = [...b.plan_comparison].sort((x, y) => x.annual_usd - y.annual_usd);
  const cheapest = plans.find((p) => p.eligible);
  return (
    <div className="grid gap-3">
      <Card
        title={
          <>
            Cost by <Term k="tou_periods">price period</Term>
          </>
        }
        aside={
          <span className="flex items-center gap-1">
            <span title={b.plan_label}>{b.plan === "custom" ? "flat rate" : b.plan}</span> <ProvenanceTip label="Rate plan" provenance={b.provenance} />
          </span>
        }
      >
        <div className="mb-3 grid grid-cols-2 gap-3 rounded-md bg-zinc-50 p-2.5 dark:bg-zinc-900">
          <div className="min-w-0">
            <div className="flex items-center gap-1 text-[11px] text-zinc-500 dark:text-zinc-400">
              Annual bill (estimate) <ProvenanceTip label="Annual bill" provenance={[...b.provenance, ...loadProvenance(r)]} />
            </div>
            <div className="text-3xl font-bold tabular-nums tracking-tight text-zinc-950 dark:text-white">{usd0(b.annual_usd)}</div>
            <div className="text-xs tabular-nums text-zinc-600 dark:text-zinc-300">about {usd0(num(b.annual_usd) / 12)} / month</div>
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-1 text-[11px] text-zinc-500 dark:text-zinc-400">
              Electricity cost <ProvenanceTip label="Effective electricity cost" provenance={[...b.provenance, ...loadProvenance(r)]} />
            </div>
            <div className="text-3xl font-bold tabular-nums tracking-tight text-zinc-950 dark:text-white">
              {cents(b.effective_usd_per_kwh)}
              <span className="text-sm font-medium text-zinc-600 dark:text-zinc-300"> / kWh</span>
            </div>
            <div className="text-xs text-zinc-600 dark:text-zinc-300">all-in average, fixed charges included</div>
          </div>
        </div>
        <HBars
          ariaLabel="Annual cost by TOU period"
          rows={b.by_period.map((p) => ({
            key: p.period,
            label: periodLabel(p.period),
            note: `${kwh(p.kwh)} at ${cents(p.avg_rate)}/kWh avg`,
            value: p.usd,
            display: usd0(p.usd),
            color: p.period === "peak" ? "var(--ev-operating)" : p.period === "part_peak" ? "var(--hh-solar)" : "var(--ev-accent)",
          }))}
        />
        {b.fixed_usd > 0 && <p className="mt-2 text-xs text-zinc-600 dark:text-zinc-300">Plus {usd0(b.fixed_usd)} a year in fixed charges.</p>}
        <p className="mt-2 text-xs text-zinc-600 dark:text-zinc-300">
          Effective price: <strong>{cents(b.effective_usd_per_kwh)}/kWh</strong> across {kwh(r.usage.annual_kwh)}.
        </p>
        <p className={`mt-1 text-[11px] leading-snug text-zinc-500 dark:text-zinc-400 ${b.plan === "custom" ? "hidden" : ""}`}>
          PG&E&apos;s <Term k="baseline_allowance">baseline</Term> credit is included where your plan has one and the rate data covers it; any gap is listed below.
        </p>
        <Notes items={[...b.warnings]} />
      </Card>

      <Card title="Same home, every plan" aside="Your load priced on each PG&E plan">
        {plans.length === 0 && <p className="text-xs text-zinc-600 dark:text-zinc-300">Plan comparison needs a utility whose rates Griddy has loaded (PG&E today). This estimate uses the flat $/kWh price.</p>}
        <HBars
          ariaLabel="Annual bill on each rate plan"
          rows={plans.map((p) => ({
            key: p.plan,
            label: (
              <>
                {shortPlan(p.label)}
                {p.plan === b.plan ? " (yours)" : ""}
              </>
            ),
            note: p.note ?? (p.eligible ? undefined : "Not eligible"),
            value: p.annual_usd,
            display: usd0(p.annual_usd),
            color: p.plan === b.plan ? "var(--ev-total)" : p.eligible ? "var(--ev-accent)" : "var(--ev-context)",
            emphasis: p.plan === b.plan,
            muted: !p.eligible,
          }))}
        />
        {cheapest && cheapest.plan !== b.plan && cheapest.annual_usd < b.annual_usd && (
          <p className="mt-2 text-xs text-zinc-600 dark:text-zinc-300">
            {shortPlan(cheapest.label)} would cost about <strong>{usd0(b.annual_usd - cheapest.annual_usd)} less</strong> a year for the same usage.
          </p>
        )}
        <Notes items={["Estimates from published rates; your real bill also includes taxes and local fees."]} />
      </Card>

      <Card title="Monthly bill (estimate)" aside={`${usd0(b.annual_usd)} a year`}>
        <MonthBars values={b.monthly_usd} color="var(--ev-accent)" unit="$ per month" format={usd0} />
      </Card>
    </div>
  );
}

export function SourcesTab({ r }: { r: HouseholdResult }) {
  const s = r.sources;
  const c = r.carbon;
  const v = r.time_view;
  const intensity = v?.intensity_kg_per_kwh ?? c.avg_day_intensity_kg_per_kwh;
  const ranked = Array.from({ length: 24 }, (_, h) => h).sort((a, b) => num(intensity[a]) - num(intensity[b]));
  const mix = Object.entries(s.mix_pct ?? {})
    .filter(([, v]) => num(v) > 0)
    .sort((a, b) => num(b[1]) - num(a[1]));
  const color = (k: string) => RESOURCE_GROUPS.find((g) => g.key === resourceGroup(k))?.color ?? "var(--hh-other)";
  const clean = new Set(ranked.slice(0, 3));
  const dirty = new Set(ranked.slice(-3));
  return (
    <div className="grid gap-3">
      <Card
        title={
          <>
            {s.provider}: <Term k="pcl">power content label</Term> {s.label_year}
          </>
        }
        aside={<ProvenanceTip label="Provider power mix" provenance={s.provenance} />}
      >
        <HBars ariaLabel="Provider power mix, percent" max={100} rows={mix.map(([k, v]) => ({ key: k, label: resourceLabel(k), value: num(v), display: `${num(v).toFixed(1)}%`, color: color(k) }))} />
        <p className="mt-2 text-xs text-zinc-600 dark:text-zinc-300">
          Reported intensity: {Math.round(s.ghg_lb_per_mwh).toLocaleString()} lb CO2e/MWh ({(s.ghg_lb_per_mwh * 0.4536 / 1000).toFixed(3)} kg/kWh), an annual average for everything the provider bought.
        </p>
      </Card>

      <Card title={`California grid · ${v?.label ?? "annual average day"}`} aside="Historical CAISO 2024">
        <MixChart mix={v?.mix_mw ?? s.caiso_avg_day_mix_mw} cleanShare={v?.clean_share ?? s.caiso_avg_day_clean_share} />
        <p className="mt-2 text-xs text-zinc-600 dark:text-zinc-300">{s.note}</p>
      </Card>

      <Card
        title={
          <>
            Your hourly carbon (<Term k="co2e">CO2e</Term> per kWh)
          </>
        }
        aside={<ProvenanceTip label="Hourly carbon" provenance={c.provenance} />}
      >
        <HourBars
          values={intensity}
          unit="kg CO2e per kWh drawn from the grid, average day"
          format={(v) => `${v.toFixed(3)} kg/kWh`}
          colorOf={(h) => (clean.has(h) ? "var(--hh-clean)" : dirty.has(h) ? "var(--hh-dirty)" : "var(--ev-context)")}
          legend={
            <LegendRow
              items={[
                { label: `Cleanest hours (${[...clean].map(hourLabel).join(", ")})`, color: "var(--hh-clean)" },
                { label: "Dirtiest hours", color: "var(--hh-dirty)" },
                { label: "Other hours", color: "var(--ev-context)" },
              ]}
            />
          }
        />
        <p className="mt-2 text-xs text-zinc-600 dark:text-zinc-300">{v?.label ?? "Annual average day"}. These are regional average emission factors. Use What-if to compare the full-year cost and carbon effects of shifting a load.</p>
      </Card>
      {v && <Card title="Your home's carbon by hour" aside={v.label}>
        <HourBars values={v.carbon_kg} unit="kg CO₂e in each hour, average matching day" format={x => `${x.toFixed(3)} kg CO₂e`} colorOf={() => "var(--ev-total)"} />
        <p className="mt-2 text-[11px] text-zinc-500">Grid purchases × intensity in each matching hour, then averaged. Solar exports receive no avoided-emissions credit.</p>
      </Card>}

      <Card title="Your footprint" aside="Grid electricity, one year">
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div>
            <div className="text-[11px] text-zinc-500 dark:text-zinc-400">
              Hourly method <ProvenanceTip label="Hourly carbon method" provenance={c.provenance} />
            </div>
            <div className="text-lg font-semibold tabular-nums">{kg(c.annual_kg_hourly)}</div>
            <div className="text-[11px] text-zinc-500 dark:text-zinc-400">your hours × CAISO average intensity</div>
          </div>
          <div>
            <div className="text-[11px] text-zinc-500 dark:text-zinc-400">
              Provider method <ProvenanceTip label="Provider carbon method" provenance={s.provenance} />
            </div>
            <div className="text-lg font-semibold tabular-nums">{kg(c.annual_kg_provider)}</div>
            <div className="text-[11px] text-zinc-500 dark:text-zinc-400">annual kWh × {s.provider} label</div>
          </div>
        </div>
        <ul className="mt-3 space-y-1 text-xs text-zinc-700 dark:text-zinc-300">
          <li>≈ {Math.round(c.equivalents.car_miles).toLocaleString()} miles in an average gasoline car</li>
          <li>≈ {Math.round(c.equivalents.tree_seedlings_10yr).toLocaleString()} tree seedlings grown for 10 years to absorb it</li>
          <li>≈ {pct0(c.equivalents.share_of_ca_avg_household)} of an average California home&apos;s electricity emissions</li>
        </ul>
        <div className={`mt-3 ${CHART_WRAP}`}>
          <MonthBars values={c.monthly_kg} color="var(--ev-total)" unit="kg CO2e per month (hourly method)" format={kg} height="h-32" />
        </div>
        <Notes
          items={[
            "Hourly figures use CAISO's average (not marginal) grid intensity; the provider figure uses its annual contract mix. Neither identifies the plant physically supplying your home.",
            "Equivalents: US EPA Greenhouse Gas Equivalencies Calculator.",
          ]}
        />
        <TableView
          summary="Table view (monthly kg CO2e)"
          head={["Month", "kg CO2e"]}
          rows={MONTHS.map((m, i) => [m, Math.round(num(c.monthly_kg[i])).toLocaleString()])}
        />
      </Card>
    </div>
  );
}
