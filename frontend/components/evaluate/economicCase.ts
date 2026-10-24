// The economic case for a design, computed in the browser from one ScenarioResult: what buying every
// served MWh from the grid would cost instead, the savings, simple payback, 20-year net savings, homes'
// worth of electricity, jobs and grid capacity asked for. Pure functions, no React. Every figure is a
// screening estimate; the provenance helpers below say how each one is made.  OWNER: workstream C.
import type { Provenance, ScenarioResult } from "@/lib/contract";
import { usd } from "@/lib/format";

import { projectOf, resilienceOf } from "./project";

/** EIA RECS 2020 California average household electricity use (data/household/assumptions.json "ca_avg_annual_kwh"). */
export const CA_HOME_KWH = 6482;
const CA_HOME_MWH = CA_HOME_KWH / 1000;

export const RECS_PROVENANCE: Provenance = {
  kind: "observed",
  source: "U.S. EIA, Residential Energy Consumption Survey (RECS) 2020: California average 6,482 kWh of electricity per household per year",
  url: "https://www.eia.gov/consumption/residential/data/2020/state/pdf/State%20consumption.pdf",
  note: "Homes' worth = MWh served a year ÷ 6.482 MWh per home, a size comparison only (the campus does not supply homes).",
};

export const QUEUE_PROVENANCE: Provenance = {
  kind: "observed",
  source: "LBNL, Queued Up: 2026 Edition (Rand et al., May 2026)",
  url: "https://emp.lbl.gov/publications/queued-2026-edition-characteristics",
  note: "The median project built in 2025 waited over 5 years from interconnection request to commercial operation (regions with data), and the report covers generation and storage, not new loads, so a smaller grid request shortening a campus's wait is a screening judgment that only a utility study can confirm.",
};

/** Present value of $1 a year for n years at real rate r: (1 - (1 + r)^-n) / r. */
export function annuityFactor(r: number, n: number): number {
  if (!(n > 0)) return 0;
  return Math.abs(r) < 1e-9 ? n : (1 - (1 + r) ** -n) / r;
}

/** CO2e if every MWh of demand came from the grid: each hour's demand x that hour's average CAISO intensity
 *  (the factor the evaluation applies to imports). Null without the hourly series. */
export function allGridTonnes(r: ScenarioResult): number | null {
  const { demand_mw: d, grid_co2_kg_per_mwh: g, step_minutes } = r.simulation.hourly;
  if (!g?.length || g.length !== d.length) return null;
  let kg = 0;
  for (let i = 0; i < d.length; i++) kg += d[i] * g[i];
  return (kg * (step_minutes || 60)) / 60 / 1000;
}

export type Verdict = "pays_back" | "slow_payback" | "no_payback" | "grid_baseline";

export interface EconomicCase {
  /** Buying every served MWh from the grid at the hourly price + import adder, $/yr. */
  gridAnnualUsd: number;
  /** This design's year-1 operating cost (evaluation OPEX), $/yr. */
  designAnnualUsd: number;
  /** gridAnnualUsd - designAnnualUsd; negative means the design costs more to run. */
  savingsUsd: number;
  capexUsd: number;
  /** capex / savings when savings > 0, else null. */
  paybackYears: number | null;
  /** gridAnnualUsd x AF(r, N) - NPC: positive means this design is cheaper over N years, today's dollars. */
  netSavingsPvUsd: number;
  npcUsd: number;
  af: number;
  discountRate: number;
  years: number;
  adderUsdPerMwh: number;
  /** Served-energy-weighted wholesale price, $/MWh (adder excluded). */
  avgPriceUsdPerMwh: number;
  servedMwh: number;
  hours: number;
  homesEquivalent: number;
  /** Share of served energy bought from the grid. */
  importEnergyShare: number;
  gridConnected: boolean;
  importLimitMw: number;
  peakMw: number;
  verdict: Verdict;
  priceProvenance: Provenance | null;
  /** Same served MWh at the hourly wholesale price + import adder, $/yr: the conservative floor. */
  wholesaleAnnualUsd: number;
  retailLabel: string;
  retailUsdPerMwh: number;
}

/** The economic case, or null when the hourly price series is missing. */
export function economicCaseOf(result: ScenarioResult): EconomicCase | null {
  const { hourly: h, summary: s, provenance } = result.simulation;
  const d = h.demand_mw, p = h.price_usd_per_mwh, u = h.unmet_mw;
  if (!d?.length || p?.length !== d.length) return null;
  const a = result.scenario.assumptions ?? {};
  const adder = a.import_adder_usd_per_mwh ?? 20;
  const r = a.discount_rate ?? 0.07;
  const years = Math.max(1, Math.round(a.analysis_years ?? 20));
  const step = (h.step_minutes || 60) / 60;
  // Served demand only, so a design that leaves load unmet is compared with a grid that delivers the same MWh.
  let wholesaleAll = 0, wholesale = 0, served = 0;
  for (let i = 0; i < d.length; i++) {
    const mw = Math.max(0, d[i] - (u?.[i] ?? 0));
    wholesaleAll += mw * (p[i] + adder);
    wholesale += mw * p[i];
    served += mw;
  }
  wholesaleAll *= step; wholesale *= step; served *= step;
  // The alternative to building is buying from the utility at its retail rate, not at the wholesale
  // market price: EIA's 2024 California average for the customer class (industrial campus, or homes
  // for a community microgrid). The wholesale + adder estimate stays in the provenance as a floor.
  const retail = result.scenario.mode === "community" ? RETAIL.residential : RETAIL.industrial;
  const cost = served * retail.usdPerMwh;
  const e = result.evaluation.economics;
  const savings = cost - e.annual_opex_usd;
  const af = annuityFactor(r, years);
  const net = cost * af - e.npc_usd;
  const importShare = served > 0 ? Math.min(1, s.imports_mwh / served) : 0;
  const connected = result.scenario.grid.connected !== false;
  const verdict: Verdict = connected && importShare >= 0.95 ? "grid_baseline"
    : savings <= 0 ? "no_payback" : net >= 0 ? "pays_back" : "slow_payback";
  return {
    gridAnnualUsd: cost,
    designAnnualUsd: e.annual_opex_usd,
    savingsUsd: savings,
    capexUsd: e.capex_total_usd,
    paybackYears: savings > 0 ? e.capex_total_usd / savings : null,
    netSavingsPvUsd: net,
    npcUsd: e.npc_usd,
    af,
    discountRate: r,
    years,
    adderUsdPerMwh: adder,
    avgPriceUsdPerMwh: served > 0 ? wholesale / served : 0,
    servedMwh: served,
    hours: d.length * step,
    homesEquivalent: served / CA_HOME_MWH,
    importEnergyShare: importShare,
    gridConnected: connected,
    importLimitMw: connected ? result.scenario.grid.import_limit_mw : 0,
    peakMw: result.scenario.demand.peak_mw,
    verdict,
    priceProvenance: provenance.find(x => /LMP|price/i.test(x.source)) ?? null,
    wholesaleAnnualUsd: wholesaleAll,
    retailLabel: retail.label,
    retailUsdPerMwh: retail.usdPerMwh,
  };
}

/** EIA State Electricity Profile, California 2024, Table 8: average price to ultimate customers. */
export const RETAIL = {
  industrial: { usdPerMwh: 215.3, label: "California's 2024 average industrial electricity rate (21.5¢/kWh)" },
  residential: { usdPerMwh: 319.7, label: "California's 2024 average residential electricity rate (32.0¢/kWh)" },
} as const;
export const RETAIL_SOURCE = {
  source: "U.S. EIA, State Electricity Profiles: California 2024, Table 8 (average price to ultimate customers by sector)",
  url: "https://www.eia.gov/electricity/state/california/",
};

const money = (v: number) => usd(Math.abs(v));
export const years1 = (v: number) => (v >= 100 ? "100+" : v.toFixed(1));

/** One honest sentence: the economic reason this design is (or isn't) worth building. */
export function verdictSentence(c: EconomicCase, subject = "this design"): string {
  const grid = "buying from the utility at California's 2024 average rate";
  const rest = "Its case rests on carbon, resilience or powering up sooner.";
  switch (c.verdict) {
    case "grid_baseline":
      return `${cap(subject)} buys ${(c.importEnergyShare * 100).toFixed(0)}% of its power from the grid, so it is the grid-only baseline: no savings to earn back, and it needs the utility to deliver a ${Math.round(c.importLimitMw).toLocaleString()} MW connection.`;
    case "no_payback":
      return `Not worth it on cost alone: ${subject} costs ${money(c.savingsUsd)} a year more to run than ${grid}, so its ${money(c.capexUsd)} build cost never pays back. ${rest}`;
    case "slow_payback":
      return `Cuts running costs by ${money(c.savingsUsd)} a year versus ${grid}, but doesn't earn back its ${money(c.capexUsd)} build cost within ${c.years} years (${money(c.netSavingsPvUsd)} behind in today's dollars). ${rest}`;
    case "pays_back":
      return `Worth building on cost: it cuts running costs by ${money(c.savingsUsd)} a year versus ${grid}, earns back its ${money(c.capexUsd)} build cost in about ${years1(c.paybackYears ?? 0)} years and ends ${money(c.netSavingsPvUsd)} ahead over ${c.years} years (today's dollars).`;
  }
}

const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

/** Provenance cards for each economic-case figure. Notes are one sentence: ProvenanceTip shows the first only. */
export function economicProvenance(c: EconomicCase) {
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
  const priceSrc = c.priceProvenance?.source ?? "CAISO 2024 day-ahead hourly prices";
  return {
    grid: {
      kind: "observed",
      source: RETAIL_SOURCE.source,
      url: RETAIL_SOURCE.url,
      note: `Buying from the utility = ${Math.round(c.servedMwh).toLocaleString()} MWh served × $${c.retailUsdPerMwh.toFixed(1)}/MWh, ${c.retailLabel} = ${usd(c.gridAnnualUsd)} a year. Floor: at the hourly wholesale price (${priceSrc}) + $${c.adderUsdPerMwh}/MWh delivery it would be ${usd(c.wholesaleAnnualUsd)} a year (average $${c.avgPriceUsdPerMwh.toFixed(0)}/MWh).`,
    } satisfies Provenance,
    savings: {
      kind: "inferred",
      source: "Griddy estimate: grid-only annual cost − this design's year-1 operating cost (OPEX)",
      note: `${usd(c.gridAnnualUsd)} grid-only − ${usd(c.designAnnualUsd)} OPEX (O&M, fuel, grid purchases) = ${c.savingsUsd < 0 ? "−" : ""}${money(c.savingsUsd)} a year, in real 2024 dollars held flat.`,
    } satisfies Provenance,
    payback: {
      kind: "inferred",
      source: "Simple payback = upfront capital (CAPEX) ÷ annual savings vs grid-only",
      note: c.paybackYears === null
        ? `No payback: the design's operating cost is not below the grid-only cost, so there are no savings to repay ${usd(c.capexUsd)}.`
        : `${usd(c.capexUsd)} ÷ ${usd(c.savingsUsd)} a year = ${c.paybackYears.toFixed(1)} years, undiscounted and before replacements or salvage.`,
    } satisfies Provenance,
    net: {
      kind: "inferred",
      source: `Net savings (present value) = grid-only cost × annuity factor − net present cost, ${c.years} years at ${pct(c.discountRate)} real`,
      note: `${usd(c.gridAnnualUsd)} × ${c.af.toFixed(3)} − NPC ${usd(c.npcUsd)} = ${c.netSavingsPvUsd < 0 ? "−" : ""}${money(c.netSavingsPvUsd)}, where the annuity factor is (1 − (1 + r)^−N) ÷ r and NPC includes CAPEX, replacements, salvage and every year's OPEX.`,
    } satisfies Provenance,
    homes: RECS_PROVENANCE,
    grid_ask: {
      ...QUEUE_PROVENANCE,
      source: `${QUEUE_PROVENANCE.source}, with the design's grid import limit (${Math.round(c.importLimitMw).toLocaleString()} MW) and facility peak (${Math.round(c.peakMw).toLocaleString()} MW)`,
    } satisfies Provenance,
  };
}

export interface CommunityCase {
  homes: number;
  /** "households": estimated households in the selected area; "energy": MWh served ÷ 6,482 kWh. */
  homesBasis: "households" | "energy";
  homesProvenance: Provenance | Provenance[];
  /** Equivalent annual cost of this design (NPC ÷ annuity factor, so build cost included) per average home. */
  perHomeDesignUsd: number;
  /** Grid-only cost per average home (wholesale + adder, not a retail bill). */
  perHomeGridUsd: number;
  outage: { hours: number; servedShare: number; hoursBeforeShortfall: number; criticalShare: number } | null;
  localJobs: { constructionFteYears: number; operationsFte: number } | null;
  co2: { designT: number; gridT: number | null; designPerHomeT: number; gridPerHomeT: number | null };
}

export function communityCaseOf(result: ScenarioResult, c: EconomicCase): CommunityCase {
  const p = projectOf(result), r = resilienceOf(result);
  const demo = p?.area.demographics;
  const households = demo?.estimated_households ?? null;
  const perHome = (v: number) => (c.servedMwh > 0 ? (v / c.servedMwh) * CA_HOME_MWH : 0);
  const gridT = allGridTonnes(result);
  const designT = result.evaluation.emissions.annual_t_co2e;
  return {
    homes: households && households > 0 ? households : c.homesEquivalent,
    homesBasis: households && households > 0 ? "households" : "energy",
    homesProvenance: households && households > 0 && demo?.provenance?.length ? demo.provenance : RECS_PROVENANCE,
    perHomeDesignUsd: perHome(c.af > 0 ? c.npcUsd / c.af : c.designAnnualUsd),
    perHomeGridUsd: perHome(c.gridAnnualUsd),
    outage: r ? { hours: r.outage_hours, servedShare: r.critical_energy_served_share, hoursBeforeShortfall: r.hours_before_shortfall, criticalShare: r.critical_load_share } : null,
    localJobs: p ? { constructionFteYears: p.jobs.local_construction_fte_years, operationsFte: p.jobs.local_operations_fte } : null,
    co2: { designT, gridT, designPerHomeT: perHome(designT), gridPerHomeT: gridT === null ? null : perHome(gridT) },
  };
}
