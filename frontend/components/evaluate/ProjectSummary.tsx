"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { shortDescription } from "@/lib/description";
import { Term } from "@/components/glossary/Term";
import { Panel } from "@/components/shell/Panel";
import { useGridForge } from "@/lib/store";
import { pct, tons, usd } from "@/lib/format";
import type { Provenance, ScenarioResult } from "@/lib/contract";
import type { GlossaryKey } from "@/lib/glossary";
import { projectOf, resilienceOf, type ProjectMetrics } from "./project";
import { CarbonLedger } from "./CarbonLedger";
import { allGridTonnes, communityCaseOf, economicCaseOf, economicProvenance, QUEUE_PROVENANCE, RECS_PROVENANCE, verdictSentence, years1, type EconomicCase, type Verdict } from "./economicCase";
import { ProvenanceTip } from "./ProvenanceTip";

type Tone = "good" | "warn" | "bad" | "neutral";
const TONE: Record<Tone, { box: string; value: string }> = {
  good: { box: "border-emerald-300 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950/40", value: "text-emerald-800 dark:text-emerald-200" },
  warn: { box: "border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/40", value: "text-amber-900 dark:text-amber-200" },
  bad: { box: "border-red-300 bg-red-50 dark:border-red-900 dark:bg-red-950/40", value: "text-red-800 dark:text-red-200" },
  neutral: { box: "border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900", value: "text-zinc-900 dark:text-zinc-50" },
};
const VERDICT: Record<Verdict, { label: string; tone: Tone }> = {
  pays_back: { label: "Pays back", tone: "good" },
  slow_payback: { label: "Slow payback", tone: "warn" },
  no_payback: { label: "Doesn't pay back", tone: "bad" },
  grid_baseline: { label: "Grid-only baseline", tone: "neutral" },
};
const signed = (v: number) => `${v < 0 ? "−" : "+"}${usd(Math.abs(v))}`;
const count = (v: number) => (v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : Math.round(v).toLocaleString());
const whole = (v: number) => Math.round(v).toLocaleString();

/** Label with its glossary card and its source card. */
function Label({ term, tip, provenance, children }: { term?: GlossaryKey; tip: string; provenance: Provenance | Provenance[] | null | undefined; children: ReactNode }) {
  return <span className="flex items-start gap-1">
    <span>{term ? <Term k={term}>{children}</Term> : children}</span>
    <ProvenanceTip label={tip} provenance={provenance} />
  </span>;
}

/** A headline number: the two a judge should read first. */
function Headline({ label, value, sub, tone }: { label: ReactNode; value: string; sub: ReactNode; tone: Tone }) {
  return <div className={`rounded-lg border p-3 ${TONE[tone].box}`}>
    <div className="text-[11px] font-medium text-zinc-600 dark:text-zinc-300">{label}</div>
    <p className={`mt-1 text-2xl font-bold leading-tight tabular-nums xl:text-[1.75rem] ${TONE[tone].value}`}>{value}</p>
    <p className="mt-1 text-[11px] leading-snug text-zinc-600 dark:text-zinc-400">{sub}</p>
  </div>;
}

/** A supporting number, bigger than the tiles below the block but smaller than a headline. */
function Fact({ label, value, sub }: { label: ReactNode; value: string; sub?: ReactNode }) {
  return <div className="rounded-lg border border-zinc-200 bg-white p-2.5 dark:border-zinc-800 dark:bg-zinc-950">
    <div className="text-[11px] text-zinc-500 dark:text-zinc-400">{label}</div>
    <p className="mt-0.5 text-lg font-semibold leading-tight tabular-nums">{value}</p>
    {sub && <p className="mt-0.5 text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">{sub}</p>}
  </div>;
}

function BlockHeader({ title, verdict }: { title: string; verdict?: Verdict }) {
  return <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
    <h3 className="text-base font-bold text-zinc-900 dark:text-zinc-50">{title}</h3>
    <span className="flex items-center gap-1.5">
      {verdict && <span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${TONE[VERDICT[verdict].tone].box} ${TONE[VERDICT[verdict].tone].value}`}>{VERDICT[verdict].label}</span>}
      <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">Estimate</span>
    </span>
  </div>;
}

/** How much grid capacity the design asks for, and why that matters for time to power. */
function gridAsk(c: EconomicCase): { value: string; sub: string; sentence: string } {
  const peak = `${whole(c.peakMw)} MW`;
  if (!c.gridConnected || c.importLimitMw <= 0) return {
    value: "0 MW", sub: `off-grid: no grid import for a ${peak} peak`,
    sentence: "It needs no grid import capacity, so it skips the grid-connection queue, where the median project built in 2025 waited over 5 years (LBNL Queued Up 2026); permits and construction still take time.",
  };
  const share = c.importLimitMw / c.peakMw;
  if (share >= 1) return {
    value: `${whole(c.importLimitMw)} MW`, sub: `the full ${peak} peak from the grid`,
    sentence: "It asks the grid for the full peak, and grid connections are slow: the median project built in 2025 waited over 5 years (LBNL Queued Up 2026). On-site supply that shrinks the request could mean powering up sooner.",
  };
  return {
    value: `${whole(c.importLimitMw)} MW`, sub: `for a ${peak} peak (${pct(share)}): ${pct(1 - share)} less to ask the utility for`,
    sentence: `Grid connections are slow: the median project built in 2025 waited over 5 years (LBNL Queued Up 2026). Asking for ${whole(c.importLimitMw)} MW instead of the full ${peak} is a smaller request that can mean powering up sooner; a utility study decides how much sooner.`,
  };
}

/** "Years to profitable" for each verdict: a number of years only when the cash walk turns positive in the analysis. */
function paybackText(c: EconomicCase): { value: string; sub: string } {
  switch (c.verdict) {
    case "grid_baseline":
      return { value: "—", sub: "this is the buy-from-utility case: nothing to earn back" };
    case "no_payback":
      return { value: "Doesn't pay back", sub: `costs ${usd(-c.savingsUsd)}/yr more to run than buying from the utility` };
    case "slow_payback":
      return { value: `${Math.round(c.buildYears + c.years)}+ years`, sub: `saves ${usd(c.savingsUsd)}/yr, too little to repay ${usd(c.capexUsd)} in ${c.years} years of operation` };
    case "pays_back":
      return { value: `${years1(c.paybackYears ?? 0)} years`, sub: `from go-ahead: ${c.buildYears}-yr build + discounted savings on ${usd(c.capexUsd)}` };
  }
}

function jobsFact(p: ProjectMetrics | null, local = false) {
  if (!p) return null;
  const j = p.jobs;
  const build = local ? j.local_construction_fte_years : j.construction_fte_years;
  const ops = local ? j.local_operations_fte : j.operations_fte;
  return <Fact label={<Label tip={local ? "Local jobs" : "Jobs"} provenance={j.provenance}>{local ? "Local jobs, estimate" : "Jobs, estimate"}</Label>}
    value={`${whole(build)} FTE-years`} sub={`construction, then ${whole(ops)} ongoing operations FTE${local ? ` (${pct(p.assumptions.local_labor_share ?? 0.6)} local)` : ""}`} />;
}

/** POWER PLANTS & GRID: the economic reason to build this design, versus buying all its power from the grid. */
function WhyBuild({ result, c }: { result: ScenarioResult; c: EconomicCase }) {
  const prov = economicProvenance(c), p = projectOf(result), ask = gridAsk(c);
  const pb = paybackText(c);
  return <section aria-label="Why build it" className="mb-4 rounded-xl border-2 border-zinc-200 p-3 dark:border-zinc-700">
    <BlockHeader title="Why build it" verdict={c.verdict} />
    <div className="grid grid-cols-2 gap-2">
      <Headline tone={VERDICT[c.verdict].tone} label={<Label term="years_to_profitable" tip="Years to profitable" provenance={prov.payback}>Years to profitable</Label>}
        value={pb.value} sub={pb.sub} />
      <Headline tone={c.savingsUsd > 0 && c.verdict !== "grid_baseline" ? "good" : c.verdict === "grid_baseline" ? "neutral" : "bad"}
        label={<Label tip="Savings vs grid-only" provenance={prov.savings}>{c.savingsUsd >= 0 ? "Saves vs utility power" : "Extra cost vs utility power"}</Label>}
        value={`${usd(Math.abs(c.savingsUsd))}/yr`}
        sub={<>utility bill {usd(c.gridAnnualUsd)}/yr <ProvenanceTip label="Buying from the utility" provenance={prov.grid} /> vs this design {usd(c.designAnnualUsd)}/yr</>} />
    </div>
    <p className="mt-2.5 text-sm font-medium leading-snug text-zinc-800 dark:text-zinc-100">{verdictSentence(c)}</p>
    <div className="mt-2.5 grid grid-cols-2 gap-2">
      <Fact label={<Label tip="20-year net savings" provenance={prov.net}>{c.years}-year net savings</Label>} value={signed(c.netSavingsPvUsd)} sub={`after ${c.years} years of operation vs buying from the utility, today's dollars`} />
      <Fact label={<Label term="homes_equivalent" tip="Homes' worth of electricity" provenance={prov.homes}>Homes&apos; worth of power</Label>} value={`${count(c.homesEquivalent)} homes`} sub="California average homes, a size comparison" />
      {jobsFact(p)}
      <Fact label={<Label term="time_to_power" tip="Grid capacity asked for" provenance={prov.grid_ask}>Grid capacity needed</Label>} value={ask.value} sub={ask.sub} />
    </div>
    <p className="mt-2 text-[11px] leading-snug text-zinc-600 dark:text-zinc-400"><span className="font-semibold text-zinc-800 dark:text-zinc-200"><Term k="time_to_power">Time to power</Term>:</span> {ask.sentence} <ProvenanceTip label="Grid connection wait" provenance={QUEUE_PROVENANCE} /></p>
    <p className="mt-1.5 text-[10px] leading-snug text-zinc-500">Screening estimates in real 2024 dollars. The alternative is buying the same MWh from the utility at California&apos;s 2024 average industrial rate (EIA), and the design&apos;s own grid purchases are priced the same way; the tooltip also shows the lower wholesale-price floor.</p>
  </section>;
}

/** COMMUNITY: what the microgrid does for the people it serves. */
function CommunityBenefit({ result, c }: { result: ScenarioResult; c: EconomicCase }) {
  const k = communityCaseOf(result, c), prov = economicProvenance(c), p = projectOf(result);
  const out = k.outage;
  const outTone: Tone = !out ? "neutral" : out.servedShare >= 0.99 ? "good" : out.servedShare >= 0.5 ? "warn" : "bad";
  const diff = k.perHomeDesignUsd - k.perHomeGridUsd;
  const co2Diff = k.co2.gridT ? k.co2.designT / k.co2.gridT - 1 : null;
  const perHomeProv: Provenance = {
    kind: "inferred",
    source: "Griddy estimate per average California home (6,482 kWh a year, EIA RECS 2020)",
    url: RECS_PROVENANCE.url,
    note: `This design: NPC ${usd(c.designNpcUsd)} (its own grid power at the utility rate) ÷ annuity factor ${c.af.toFixed(3)} (build and running cost spread over ${c.years} years) ÷ ${whole(c.servedMwh)} MWh × 6.482 MWh per home, vs buying from the utility ${usd(c.gridAnnualUsd)} a year (${c.retailLabel}, EIA) on the same basis.`,
  };
  const co2Prov: Provenance = {
    kind: "inferred",
    source: "Griddy operational emissions vs every MWh from the grid at each hour's average CAISO intensity",
    note: `${tons(k.co2.designT)} a year for this design vs ${k.co2.gridT === null ? "—" : tons(k.co2.gridT)} all-grid, and per average home (6,482 kWh) ${k.co2.designPerHomeT.toFixed(2)} t vs ${k.co2.gridPerHomeT === null ? "—" : k.co2.gridPerHomeT.toFixed(2)} t.`,
  };
  const resProv = resilienceOf(result)?.provenance;
  return <section aria-label="Community benefit" className="mb-4 rounded-xl border-2 border-zinc-200 p-3 dark:border-zinc-700">
    <BlockHeader title="Community benefit" verdict={c.verdict} />
    <div className="grid grid-cols-2 gap-2">
      <Headline tone="neutral" label={<Label term={k.homesBasis === "energy" ? "homes_equivalent" : undefined} tip="Homes powered" provenance={k.homesProvenance}>Homes powered</Label>}
        value={count(k.homes)} sub={k.homesBasis === "households" ? "estimated households in the selected area" : "homes' worth of electricity (California average use)"} />
      <Headline tone={outTone} label={<Label tip="Outage protection" provenance={resProv}>Outage protection</Label>}
        value={out ? pct(out.servedShare) : "—"} sub={out ? <>of critical energy kept on through a {out.hours} h grid outage{out.servedShare < 0.99 && out.hoursBeforeShortfall > 0 ? `, first shortfall after ${out.hoursBeforeShortfall} h` : ""}</> : "no outage screening for this design"} />
    </div>
    <p className="mt-2.5 text-sm font-medium leading-snug text-zinc-800 dark:text-zinc-100">{verdictSentence(c, "this microgrid")}</p>
    <div className="mt-2.5 grid grid-cols-2 gap-2">
      <Fact label={<Label tip="Cost per home per year" provenance={perHomeProv}>Cost per home / year</Label>}
        value={`${usd(k.perHomeDesignUsd)}`} sub={<>vs {usd(k.perHomeGridUsd)} from the utility: <span className={diff <= 0 ? "font-semibold text-emerald-700 dark:text-emerald-300" : "font-semibold text-amber-700 dark:text-amber-300"}>{usd(Math.abs(diff))} {diff <= 0 ? "less" : "more"}</span></>} />
      <Fact label={<Label term="years_to_profitable" tip="Years to profitable" provenance={prov.payback}>Years to profitable</Label>}
        value={paybackText(c).value} sub={paybackText(c).sub} />
      {jobsFact(p, true)}
      <Fact label={<Label term="co2e" tip="CO2e vs all-grid" provenance={co2Prov}>CO₂e vs all-grid</Label>}
        value={co2Diff === null ? `${tons(k.co2.designT)}/yr` : Math.abs(co2Diff) < 0.005 ? "Same" : `${pct(Math.abs(co2Diff))} ${co2Diff < 0 ? "less" : "more"}`}
        sub={`${tons(k.co2.designT)}/yr, ${k.co2.designPerHomeT.toFixed(2)} t per home${k.co2.gridPerHomeT === null ? "" : ` vs ${k.co2.gridPerHomeT.toFixed(2)} t all-grid`}`} />
    </div>
    <p className="mt-1.5 text-[10px] leading-snug text-zinc-500">Screening estimates in real 2024 dollars. Per-home figures use an average California home&apos;s 6,482 kWh a year; the alternative is California&apos;s 2024 average residential rate (EIA), and the microgrid&apos;s own grid purchases are priced the same way.</p>
  </section>;
}

export function ProjectSummary() {
  const { result } = useGridForge();
  if (!result) return null;
  const { economics: e, emissions: em } = result.evaluation;
  const p = projectOf(result), r = resilienceOf(result), s = result.simulation.summary;
  const served = s.demand_mwh - s.unmet_mwh;
  // Context for the emissions figure: a big number can still be far below buying everything from the grid.
  const grid = allGridTonnes(result);
  const vsGrid = grid ? em.annual_t_co2e / grid - 1 : null; // -0.72: 72% less than all-grid
  const gridIntensity = grid && s.demand_mwh ? (grid * 1000) / s.demand_mwh : null;
  const gridNote = vsGrid === null || grid === null ? undefined : (
    <p className={`mt-0.5 text-[11px] ${vsGrid <= 0 ? "text-emerald-700 dark:text-emerald-300" : "text-amber-700 dark:text-amber-300"}`}
      title={`All-grid: ${tons(grid)} CO₂e a year if every MWh came from the grid, at each hour's average CAISO intensity`}>
      {Math.abs(vsGrid) < 0.005 ? "About the same as all-grid" : `${pct(Math.abs(vsGrid))} ${vsGrid < 0 ? "less" : "more"} than all-grid`}
    </p>
  );
  const issues = result.findings.filter(f => f.severity === "fail" || f.severity === "warn");
  // Failures first, then anything needing a utility study: the flags a viewer must not miss.
  const rank = (f: (typeof issues)[number]) => (f.severity === "fail" ? 0 : f.needs_utility_study ? 1 : 2);
  const top = [...issues].sort((a, b) => rank(a) - rank(b)).slice(0, 3);
  const studies = issues.filter(f => f.needs_utility_study).length;
  const tone = s.hours_unmet ? "border-red-200 text-red-700 dark:text-red-300"
    : issues.length ? "border-amber-300 text-amber-800 dark:border-amber-800 dark:text-amber-300"
    : "border-emerald-200 text-emerald-800 dark:text-emerald-300";
  const c = economicCaseOf(result);
  const community = result.scenario.mode === "community";
  return <Panel title="Project at a glance">
    <p className="mb-3 text-xs text-zinc-500">{result.scenario.site.name} · {result.scenario.demand.peak_mw.toLocaleString()} MW {community ? "community peak" : "facility peak"}</p>
    {c && (community ? <CommunityBenefit result={result} c={c} /> : <WhyBuild result={result} c={c} />)}
    <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Cost, power &amp; carbon</h3>
    <div className="grid grid-cols-2 gap-3">
      {([
        ["Power delivered, average", `${(p?.production.average_power_served_mw ?? served / result.simulation.hourly.demand_mw.length).toFixed(1)} MW`],
        ["Demand supplied", s.demand_mwh ? pct(served / s.demand_mwh) : "—"],
        ["Upfront capital", usd(e.capex_total_usd), "capex"], ["Operating cost / year", usd(e.annual_opex_usd), "opex"],
        ["Lifetime energy cost", `$${e.lcoe_usd_per_mwh.toFixed(0)}/MWh`, "lcoe"], ["Operational emissions / year", `${tons(em.annual_t_co2e)} CO₂e`, "co2e", gridNote],
      ] as [string, string, GlossaryKey?, ReactNode?][]).map(([label, value, term, note]) => <div key={label} className="rounded-lg bg-zinc-50 p-3 dark:bg-zinc-900">
        <p className="text-[11px] text-zinc-500">{term ? <Term k={term}>{label}</Term> : label}</p><p className="mt-1 text-lg font-semibold tabular-nums">{value}</p>{note}
      </div>)}
    </div>
    <p className="mt-3 text-xs text-zinc-500">{em.intensity_kg_per_mwh.toFixed(0)} <Term k="co2_intensity">kg CO₂e/MWh</Term>{gridIntensity !== null && <> vs {gridIntensity.toFixed(0)} all-grid</>} · {pct(s.onsite_clean_share)} <Term k="onsite_clean_share">on-site clean energy</Term></p>
    <div className="mt-3"><CarbonLedger result={result} compact /></div>
    <div className={`mt-3 rounded border p-2 text-xs ${tone}`}>
      <p className="font-semibold">{s.hours_unmet ? <>{s.hours_unmet.toLocaleString()} hours with <Term k="unmet">unmet demand</Term></> : "Demand met every hour in the simulated year"}</p>
      <p className="mt-1">{issues.length} feasibility check{issues.length === 1 ? " is" : "s are"} flagged for review{studies ? <>, {studies} need{studies === 1 ? "s" : ""} a utility study</> : null}.</p>
      {top.length > 0 && <ul className="mt-1 list-disc space-y-0.5 pl-4">{top.map(f => <li key={`${f.module}-${f.id}`}>{f.title}</li>)}</ul>}
    </div>
    {r && <div className="mt-3 text-xs">
      <p className="font-semibold">Resilience screening</p>
      <p className="mt-1">{pct(r.critical_energy_served_share)} of critical energy supplied during a {r.outage_hours} h grid outage.</p>
    </div>}
    <details className="mt-3 text-xs"><summary className="cursor-pointer">All flagged checks{issues.length ? ` (${issues.length})` : ""}</summary>
      <ul className="mt-2 space-y-2">{issues.map(f => <li key={`${f.module}-${f.id}`}><span className="font-medium">{f.title}</span><p className="text-zinc-500">{shortDescription(f.detail)}</p></li>)}</ul>
    </details>
    <p className="mt-3 text-[10px] text-zinc-500">See the report for assumptions and sources.</p>
  </Panel>;
}

export function ProjectDetails({ result, expanded = false }: { result: ScenarioResult; expanded?: boolean }) {
  const p = projectOf(result), r = resilienceOf(result);
  if (!p) return null;
  if (!expanded) return <Panel title="Project impacts">
    <p className="text-xs text-zinc-500">See the report for jobs, land use and contract estimates.</p>
    <Link href="/report" className="mt-2 inline-block text-xs underline">Open full report</Link>
  </Panel>;
  // Third element: the glossary entry that explains the label.
  const rows: [string, string, GlossaryKey?][] = [
    ["Demand projected", `${p.projection.projected_peak_mw.toFixed(1)} MW peak in ${p.projection.years} years (${pct(p.projection.annual_growth)}/yr)`],
    ["Gross generation / year", `${p.production.gross_generation_mwh.toLocaleString(undefined, { maximumFractionDigits: 0 })} MWh`],
    ["Grid purchases / year", `${p.production.imports_mwh.toLocaleString(undefined, { maximumFractionDigits: 0 })} MWh`, "imports"],
    ["Construction labor", `${p.jobs.construction_fte_years.toFixed(1)} FTE-years total; ${p.jobs.average_construction_fte.toFixed(1)} average FTE during construction`],
    ["Ongoing operations labor", `${p.jobs.operations_fte.toFixed(1)} FTE / year`],
    ["Local labor estimate", `${p.jobs.local_construction_fte_years.toFixed(1)} construction FTE-years; ${p.jobs.local_operations_fte.toFixed(1)} ongoing FTE`],
    ["Carbon cost in financial model", `${usd(p.carbon.booked_annual_cost_usd)} / yr`, "carbon_price"],
    ["All-emissions carbon exposure", `${usd(p.carbon.all_emissions_exposure_usd)} / yr`],
    ["Offtake volume assumption", `${p.contracts.annual_volume_mwh.toLocaleString(undefined, { maximumFractionDigits: 0 })} MWh/yr × $${p.contracts.price_usd_per_mwh}/MWh for ${p.contracts.term_years} years`],
    ["Indicative annual offtake value", `${usd(p.contracts.illustrative_annual_value_usd)} / yr`],
  ];
  if (p.area.area_acres !== null) rows.push(
    ["Selected area", `${p.area.area_acres.toFixed(1)} acres (${p.area.area_km2?.toFixed(2)} km²)`],
    ["Land needed / area selected", p.area.land_utilization !== null ? pct(p.area.land_utilization) : "—"],
    ["Project capital / selected acre", p.area.capex_usd_per_acre !== null ? `${usd(p.area.capex_usd_per_acre)} / acre` : "—"],
    ["Project emissions / selected acre", p.area.annual_t_co2e_per_acre !== null ? `${p.area.annual_t_co2e_per_acre.toFixed(2)} t CO₂e/acre/yr` : "—"],
  );
  if (r) rows.push(["Critical load supplied during outage", `${pct(r.critical_energy_served_share)} over ${r.outage_hours} h; ${r.unserved_critical_mwh.toFixed(1)} MWh unserved`],
    ["Sustained N-1 firm supply", `${r.n_minus_1_firm_mw.toFixed(1)} MW (${r.n_minus_1_coverage === null ? "—" : pct(r.n_minus_1_coverage)} of critical peak)`, "n_minus_1"]);
  return <details open={expanded} className="rounded border border-zinc-200 p-3 text-xs dark:border-zinc-800 print:break-inside-avoid">
    <summary className="cursor-pointer font-semibold">Project impact, production &amp; contracts</summary>
    <dl className="mt-3 space-y-2">{rows.map(([label, value, term]) => <div key={label} className="flex justify-between gap-3"><dt className="text-zinc-500">{term ? <Term k={term}>{label}</Term> : label}</dt><dd className="max-w-[60%] text-right tabular-nums">{value}</dd></div>)}</dl>
    <div className="mt-3"><CarbonLedger result={result} /></div>
    {p.area.demographics && <div className="mt-3 rounded bg-zinc-50 p-2 dark:bg-zinc-900">
      <p>Selected-zone residents: {p.area.demographics.population?.toLocaleString() ?? "unavailable"}; estimated households: {p.area.demographics.estimated_households?.toLocaleString(undefined, { maximumFractionDigits: 0 }) ?? "unavailable"}.</p>
      <p>Estimated residential demand: {p.area.demographics.residential_demand_mwh_per_year?.toLocaleString(undefined, { maximumFractionDigits: 0 }) ?? "unavailable"} MWh/yr.</p>
      <p className="mt-1 text-zinc-500">{p.area.demographics.caveat}</p>
    </div>}
    <div className="mt-3 space-y-2 text-[11px] text-zinc-500">
      <p>{p.projection.basis}</p><p>{p.jobs.provenance.note} <a className="underline" href={p.jobs.provenance.url ?? undefined} target="_blank" rel="noreferrer">FTE interpretation</a></p>
      <p>{p.carbon.basis}</p><p>{p.contracts.status}. {p.contracts.basis}</p>
      <p>{p.production.basis}</p><p>{p.area.basis}</p>{r && <p>{r.basis}</p>}
      {p.warnings.map(w => <p key={w} className="text-amber-700">{w}</p>)}
    </div>
  </details>;
}
