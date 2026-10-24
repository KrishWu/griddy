// Typed, runtime-guarded reader for EvaluationResult.extras (a Record<string, unknown>
// on the wire). Every key is optional: an older backend (the stub) returns no extras at
// all, and a malformed value is dropped rather than crashing a panel.
// Key names and shapes mirror the extras table in the workstream C spec.
// OWNER: workstream C (Evaluate).
import type { EvaluationResult, Provenance, ProvenanceKind, ScenarioResult } from "@/lib/contract";

import { finite } from "./fmt";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const NPC_CATEGORIES = [
  "capex",
  "replacement",
  "salvage",
  "fixed_om",
  "var_om",
  "fuel",
  "purchased_power",
  "carbon",
  "export_revenue",
] as const;
export type NpcCategory = (typeof NPC_CATEGORIES)[number];

export interface NpcItem {
  label: string;
  category: NpcCategory;
  usd: number;
}

export interface CashFlow {
  year: number;
  capex_usd: number;
  opex_usd: number;
  replacement_usd: number;
  salvage_usd: number;
  net_usd: number;
  discount_factor: number;
  pv_usd: number;
}

export interface ImportMethod {
  grid_imports_t: number;
  annual_t_co2e: number;
  intensity_kg_per_mwh: number;
  /** Only on carb_unspecified: the effective factor applied (base x transmission-loss factor). */
  factor_t_per_mwh?: number;
  /** Only on carb_unspecified: the regulation's base default (0.428 t CO2e/MWh). */
  base_factor_t_per_mwh?: number;
  /** Only on carb_unspecified: the transmission-loss multiplier (1.02). */
  transmission_loss_factor?: number;
}

export interface EmissionsCrosscheck {
  egrid_camx_kg_per_mwh?: number;
  egrid_year?: number;
  /** null when the scenario imports nothing. */
  sim_import_weighted_kg_per_mwh?: number | null;
  sim_grid_mean_kg_per_mwh?: number;
  note?: string;
}

export const PROVENANCE_METRICS = [
  "capex_total_usd",
  "annual_opex_usd",
  "npc_usd",
  "lcoe_usd_per_mwh",
  "annual_t_co2e",
  "intensity_kg_per_mwh",
  "cfe_score_24_7",
  "land_acres_total",
  "nox_t_per_yr",
  "pm25_t_per_yr",
] as const;
export type ProvenanceMetric = (typeof PROVENANCE_METRICS)[number];

export const METHODOLOGY_TOPICS: { key: string; title: string }[] = [
  { key: "boundary", title: "Financial boundary" },
  { key: "horizon", title: "Analysis horizon" },
  { key: "discounting", title: "Discounting" },
  { key: "dollar_year", title: "Dollar year" },
  { key: "capex", title: "Capital costs" },
  { key: "fuel", title: "Fuel" },
  { key: "imports", title: "Grid imports" },
  { key: "exports", title: "Exports" },
  { key: "carbon", title: "Carbon price" },
  { key: "emissions", title: "Emissions" },
  { key: "cfe", title: "24/7 carbon-free energy" },
  { key: "bom", title: "Bill of materials" },
];

export interface EvalExtras {
  nox_t_per_yr?: number;
  pm25_t_per_yr?: number;
  nox_t_per_yr_scr?: number;
  nox_basis?: string;
  cfe_score_24_7?: number;
  cfe_hourly_energy_share?: number;
  cfe_annual_netting_share?: number;
  cfe_by_month?: number[];
  cfe_by_hour_of_day?: number[];
  cfe_grid_share_source?: "simulate" | "inferred_from_grid_co2";
  /** Total project area, incl. the land between wind turbines. */
  land_acres_total?: number;
  /** Exclusive-use footprint: wind at its direct (pads + roads) rate, every other kind as in the total. */
  land_acres_direct_total?: number;
  land_acres_by_kind?: Record<string, number>;
  npc_breakdown?: NpcItem[];
  cash_flows?: CashFlow[];
  lcoe_crf_usd_per_mwh?: number;
  served_mwh_per_yr?: number;
  discounted_mwh_served?: number;
  fuel_mmbtu_per_yr?: number;
  fuel_effective_usd_per_mmbtu?: number;
  /** undefined = not reported; null = flat price (no monthly shape applied). */
  gas_price_monthly_usd_per_mmbtu?: number[] | null;
  emissions_import_methods?: { caiso_hourly_average?: ImportMethod; carb_unspecified?: ImportMethod };
  emissions_crosscheck?: EmissionsCrosscheck;
  upstream_methane_t_co2e?: number;
  upstream_methane_included?: boolean;
  ca_allowance_reference_usd_per_t?: number;
  /** Always an object (empty when the backend reported none). */
  provenance: Partial<Record<string, Provenance>>;
  /** Always an object (empty when the backend reported none). */
  methodology: Record<string, string>;
  dollar_year?: number;
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);
const nonNeg = (v: unknown): number | undefined => {
  const n = finite(v);
  return n !== undefined && n >= 0 ? n : undefined;
};
/** Shares are 0–1; tolerate float noise, reject anything clearly out of range. */
const frac = (v: unknown): number | undefined => {
  const n = finite(v);
  if (n === undefined || n < -1e-6 || n > 1 + 1e-6) return undefined;
  return Math.min(1, Math.max(0, n));
};
const numArray = (v: unknown, len?: number): number[] | undefined => {
  if (!Array.isArray(v) || (len !== undefined && v.length !== len) || v.length === 0) return undefined;
  const out = v.map(finite);
  return out.every((x): x is number => x !== undefined) ? out : undefined;
};
const fracArray = (v: unknown, len: number): number[] | undefined => {
  const a = numArray(v, len);
  if (!a) return undefined;
  const out = a.map(frac);
  return out.every((x): x is number => x !== undefined) ? out : undefined;
};
const numRecord = (v: unknown): Record<string, number> | undefined => {
  if (!isObj(v)) return undefined;
  const out: Record<string, number> = {};
  for (const [k, x] of Object.entries(v)) {
    const n = finite(x);
    if (n !== undefined) out[k] = n;
  }
  return Object.keys(out).length ? out : undefined;
};

const PROVENANCE_KINDS: ProvenanceKind[] = ["observed", "assumption", "simulated", "inferred"];

export function readProvenance(v: unknown): Provenance | undefined {
  if (!isObj(v)) return undefined;
  const kind = v.kind;
  const source = str(v.source);
  if (typeof kind !== "string" || !PROVENANCE_KINDS.includes(kind as ProvenanceKind) || !source) return undefined;
  return { kind: kind as ProvenanceKind, source, url: str(v.url) ?? null, note: str(v.note) ?? null };
}

function readNpcBreakdown(v: unknown): NpcItem[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: NpcItem[] = [];
  for (const x of v) {
    if (!isObj(x)) continue;
    const label = str(x.label);
    const usd = finite(x.usd);
    const cat = x.category;
    if (label && usd !== undefined && typeof cat === "string" && (NPC_CATEGORIES as readonly string[]).includes(cat)) {
      out.push({ label, category: cat as NpcCategory, usd });
    }
  }
  return out.length ? out : undefined;
}

function readCashFlows(v: unknown): CashFlow[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const keys = ["year", "capex_usd", "opex_usd", "replacement_usd", "salvage_usd", "net_usd", "discount_factor", "pv_usd"] as const;
  const out: CashFlow[] = [];
  for (const x of v) {
    if (!isObj(x)) return undefined;
    const row = {} as CashFlow;
    for (const k of keys) {
      const n = finite(x[k]);
      if (n === undefined) return undefined;
      row[k] = n;
    }
    out.push(row);
  }
  return out.length ? out : undefined;
}

function readImportMethod(v: unknown): ImportMethod | undefined {
  if (!isObj(v)) return undefined;
  const grid_imports_t = nonNeg(v.grid_imports_t);
  const annual_t_co2e = nonNeg(v.annual_t_co2e);
  const intensity_kg_per_mwh = nonNeg(v.intensity_kg_per_mwh);
  if (grid_imports_t === undefined || annual_t_co2e === undefined || intensity_kg_per_mwh === undefined) return undefined;
  const out: ImportMethod = { grid_imports_t, annual_t_co2e, intensity_kg_per_mwh };
  const factor = nonNeg(v.factor_t_per_mwh);
  const base = nonNeg(v.base_factor_t_per_mwh);
  const loss = nonNeg(v.transmission_loss_factor);
  if (factor !== undefined) out.factor_t_per_mwh = factor;
  if (base !== undefined) out.base_factor_t_per_mwh = base;
  if (loss !== undefined) out.transmission_loss_factor = loss;
  return out;
}

/** "0.428 t/MWh × 1.02 transmission-loss factor = 0.4366 t CO2e/MWh", or just the factor. */
export function carbFactorText(m: ImportMethod | undefined): string | undefined {
  if (m?.factor_t_per_mwh === undefined) return undefined;
  const f = m.factor_t_per_mwh;
  if (m.base_factor_t_per_mwh !== undefined && m.transmission_loss_factor !== undefined && m.transmission_loss_factor !== 1) {
    return `${m.base_factor_t_per_mwh} t/MWh × ${m.transmission_loss_factor} transmission-loss factor = ${f.toFixed(4)} t CO2e/MWh`;
  }
  return `${Number(f.toFixed(4))} t CO2e/MWh`;
}

function readCrosscheck(v: unknown): EmissionsCrosscheck | undefined {
  if (!isObj(v)) return undefined;
  const out: EmissionsCrosscheck = {
    egrid_camx_kg_per_mwh: nonNeg(v.egrid_camx_kg_per_mwh),
    egrid_year: finite(v.egrid_year),
    sim_import_weighted_kg_per_mwh: v.sim_import_weighted_kg_per_mwh === null ? null : nonNeg(v.sim_import_weighted_kg_per_mwh),
    sim_grid_mean_kg_per_mwh: nonNeg(v.sim_grid_mean_kg_per_mwh),
    note: str(v.note),
  };
  return Object.values(out).some((x) => x !== undefined) ? out : undefined;
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

/** Parse EvaluationResult.extras into typed, validated values. Never throws. */
export function evalExtras(e: EvaluationResult | null | undefined): EvalExtras {
  const x: Obj = isObj(e?.extras) ? (e.extras as Obj) : {};

  const provenance: Partial<Record<string, Provenance>> = {};
  if (isObj(x.provenance)) {
    for (const [k, v] of Object.entries(x.provenance)) {
      const p = readProvenance(v);
      if (p) provenance[k] = p;
    }
  }

  const methodology: Record<string, string> = {};
  if (isObj(x.methodology)) {
    for (const [k, v] of Object.entries(x.methodology)) {
      const s = str(v);
      if (s) methodology[k] = s;
    }
  }

  let importMethods: EvalExtras["emissions_import_methods"];
  if (isObj(x.emissions_import_methods)) {
    const caiso = readImportMethod(x.emissions_import_methods.caiso_hourly_average);
    const carb = readImportMethod(x.emissions_import_methods.carb_unspecified);
    if (caiso || carb) importMethods = { caiso_hourly_average: caiso, carb_unspecified: carb };
  }

  const src = x.cfe_grid_share_source;
  const dollarYear = finite(x.dollar_year);

  return {
    nox_t_per_yr: nonNeg(x.nox_t_per_yr),
    pm25_t_per_yr: nonNeg(x.pm25_t_per_yr),
    nox_t_per_yr_scr: nonNeg(x.nox_t_per_yr_scr),
    nox_basis: str(x.nox_basis),
    cfe_score_24_7: frac(x.cfe_score_24_7),
    cfe_hourly_energy_share: frac(x.cfe_hourly_energy_share),
    cfe_annual_netting_share: frac(x.cfe_annual_netting_share),
    cfe_by_month: fracArray(x.cfe_by_month, 12),
    cfe_by_hour_of_day: fracArray(x.cfe_by_hour_of_day, 24),
    cfe_grid_share_source: src === "simulate" || src === "inferred_from_grid_co2" ? src : undefined,
    land_acres_total: nonNeg(x.land_acres_total),
    land_acres_direct_total: nonNeg(x.land_acres_direct_total),
    land_acres_by_kind: numRecord(x.land_acres_by_kind),
    npc_breakdown: readNpcBreakdown(x.npc_breakdown),
    cash_flows: readCashFlows(x.cash_flows),
    lcoe_crf_usd_per_mwh: finite(x.lcoe_crf_usd_per_mwh),
    served_mwh_per_yr: nonNeg(x.served_mwh_per_yr),
    discounted_mwh_served: nonNeg(x.discounted_mwh_served),
    fuel_mmbtu_per_yr: nonNeg(x.fuel_mmbtu_per_yr),
    fuel_effective_usd_per_mmbtu: nonNeg(x.fuel_effective_usd_per_mmbtu),
    gas_price_monthly_usd_per_mmbtu: x.gas_price_monthly_usd_per_mmbtu === null ? null : numArray(x.gas_price_monthly_usd_per_mmbtu, 12),
    emissions_import_methods: importMethods,
    emissions_crosscheck: readCrosscheck(x.emissions_crosscheck),
    upstream_methane_t_co2e: nonNeg(x.upstream_methane_t_co2e),
    upstream_methane_included: bool(x.upstream_methane_included),
    ca_allowance_reference_usd_per_t: nonNeg(x.ca_allowance_reference_usd_per_t),
    provenance,
    methodology,
    dollar_year: dollarYear !== undefined && Number.isInteger(dollarYear) ? dollarYear : undefined,
  };
}

// ---------------------------------------------------------------------------
// Derived values with honest fallbacks for older backends
// ---------------------------------------------------------------------------

/** Assumptions with the contract defaults filled in (contract.py Assumptions). */
export function assumptionsOf(r: ScenarioResult) {
  const a = r.scenario.assumptions ?? {};
  return {
    years: finite(a.analysis_years) ?? 20,
    rate: finite(a.discount_rate) ?? 0.07,
    gasPrice: finite(a.gas_price_usd_per_mmbtu) ?? 4.0,
    carbonPrice: finite(a.carbon_price_usd_per_t) ?? 0,
    weatherYear: finite(a.weather_year) ?? 2024,
    importAdder: finite(a.import_adder_usd_per_mwh) ?? 20,
  };
}

/**
 * Total land in acres: extras.land_acres_total, else the sum of acre-denominated BOM
 * items (old stub BOMs list one "Land for ..." row per asset and no total row).
 */
export function landAcres(e: EvaluationResult, ex: EvalExtras = evalExtras(e)): number | undefined {
  if (ex.land_acres_total !== undefined) return ex.land_acres_total;
  const rows = (e.economics.bom ?? []).filter((b) => /^acres?$/i.test(b.unit.trim()) && !/total/i.test(b.item));
  if (!rows.length) return undefined;
  return rows.reduce((s, b) => s + (finite(b.quantity) ?? 0), 0);
}

/**
 * Exclusive-use footprint in acres (wind counted at its direct pads-and-roads rate):
 * extras.land_acres_direct_total, else the BOM's "direct footprint" total row.
 */
export function landAcresDirect(e: EvaluationResult, ex: EvalExtras = evalExtras(e)): number | undefined {
  if (ex.land_acres_direct_total !== undefined) return ex.land_acres_direct_total;
  const row = (e.economics.bom ?? []).find((b) => /^acres?$/i.test(b.unit.trim()) && /direct footprint/i.test(b.item));
  const q = finite(row?.quantity);
  return q !== undefined && q >= 0 ? q : undefined;
}

/** MWh served per year: extras, else demand − unmet from the simulation summary. */
export function servedMwh(r: ScenarioResult, ex: EvalExtras): number | undefined {
  if (ex.served_mwh_per_yr !== undefined) return ex.served_mwh_per_yr;
  const s = r.simulation.summary;
  const d = finite(s.demand_mwh);
  return d === undefined ? undefined : d - (finite(s.unmet_mwh) ?? 0);
}

/** True when a source string is an un-sourced stub value. */
export const isPlaceholder = (p: Provenance) => /placeholder/i.test(`${p.source} ${p.note ?? ""}`);

/** Distinct provenances (by kind + source), capped so a tooltip stays readable. */
export function dedupeProvenance(list: (Provenance | null | undefined)[], max = 4): Provenance[] {
  const seen = new Set<string>();
  const out: Provenance[] = [];
  for (const p of list) {
    if (!p) continue;
    const k = `${p.kind}|${p.source}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
    if (out.length >= max) break;
  }
  return out;
}

const OPEX_CATEGORIES = new Set(["fixed_om", "var_om", "fuel", "purchased_power", "carbon", "export_revenue"]);

/**
 * Provenance for each headline metric: extras.provenance when the backend reported it,
 * otherwise a fallback derived from what the contract does carry (the cost lines'
 * own provenance, the emissions provenance list) plus a plain statement of the formula.
 */
export function headlineProvenance(r: ScenarioResult, ex: EvalExtras): Record<ProvenanceMetric, Provenance[]> {
  const { economics: e, emissions: em } = r.evaluation;
  const { years, rate } = assumptionsOf(r);
  const lines = e.lines ?? [];
  const capexLines = lines.filter((l) => l.category === "capex").map((l) => l.provenance);
  const opexLines = lines.filter((l) => OPEX_CATEGORIES.has(l.category)).map((l) => l.provenance);
  const emProv = em.provenance ?? [];
  const horizon = `${years}-year horizon, ${(rate * 100).toFixed(1).replace(/\.0$/, "")}% real discount rate`;
  const pick = (k: ProvenanceMetric, fallback: Provenance[]) => {
    const p = ex.provenance[k];
    return p ? [p] : fallback;
  };

  return {
    capex_total_usd: pick("capex_total_usd", [
      { kind: "inferred", source: "Sum of the year-0 CAPEX cost lines", note: "Each cost line below carries its own source." },
      ...dedupeProvenance(capexLines, 3),
    ]),
    annual_opex_usd: pick("annual_opex_usd", [
      {
        kind: "inferred",
        source: "Sum of year-1 operating cost lines",
        note: "Fixed O&M + variable O&M + fuel + purchased power + carbon − export credit. No replacements.",
      },
      ...dedupeProvenance(opexLines, 3),
    ]),
    npc_usd: pick("npc_usd", [
      {
        kind: "inferred",
        source: "Net present cost of the discounted cash flows",
        note: `CAPEX at year 0 plus annual operating costs, ${horizon}.`,
      },
    ]),
    lcoe_usd_per_mwh: pick("lcoe_usd_per_mwh", [
      { kind: "inferred", source: "LCOE = NPC ÷ discounted MWh served", note: `Served energy discounted over the ${horizon}.` },
    ]),
    annual_t_co2e: pick(
      "annual_t_co2e",
      emProv.length ? dedupeProvenance(emProv) : [{ kind: "inferred", source: "On-site combustion + grid imports", note: null }],
    ),
    intensity_kg_per_mwh: pick("intensity_kg_per_mwh", [
      { kind: "inferred", source: "Annual CO2e ÷ MWh served", note: null },
      ...dedupeProvenance(emProv, 3),
    ]),
    cfe_score_24_7: pick("cfe_score_24_7", [
      ex.cfe_score_24_7 === undefined
        ? { kind: "inferred", source: "Not reported by this evaluation backend version", note: null }
        : { kind: "simulated", source: "Hourly matching of clean supply to demand", note: "Share of hours fully met by clean supply." },
    ]),
    land_acres_total: pick("land_acres_total", [
      { kind: "assumption", source: "Sum of land rows in the bill of materials", note: "See each row's basis in the BOM." },
    ]),
    nox_t_per_yr: pick("nox_t_per_yr", [
      { kind: "assumption", source: ex.nox_basis ?? "EPA AP-42 Ch. 3.1 natural-gas turbine factors", note: null },
    ]),
    pm25_t_per_yr: pick("pm25_t_per_yr", [
      { kind: "assumption", source: "EPA AP-42 Ch. 3.1 natural-gas turbine factors", note: null },
    ]),
  };
}

