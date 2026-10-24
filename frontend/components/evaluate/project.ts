import type { Provenance, ScenarioResult } from "@/lib/contract";

export interface AreaStats {
  area_km2: number;
  population: number | null;
  estimated_households: number | null;
  residential_demand_mwh_per_year: number | null;
  average_residential_demand_mw: number | null;
  estimated_residential_peak_mw: number | null;
  caveat: string;
  coverage: string;
  provenance: Provenance[];
}

export interface ResilienceMetrics {
  outage_hours: number;
  critical_load_share: number;
  critical_energy_served_share: number;
  hours_before_shortfall: number;
  unserved_critical_mwh: number;
  starting_soc_mwh: number;
  n_minus_1_coverage: number | null;
  reserve_margin: number | null;
  n_minus_1_firm_mw: number;
  largest_contingency_mw: number;
  basis: string;
  provenance: Provenance;
}

export interface ProjectMetrics {
  warnings: string[];
  assumptions: Record<string, number | null>;
  projection: { years: number; annual_growth: number; current_peak_mw: number; projected_peak_mw: number; projected_demand_mwh: number; basis: string };
  jobs: { construction_fte_years: number; average_construction_fte: number; operations_fte: number; local_construction_fte_years: number; local_operations_fte: number; provenance: Provenance };
  production: { gross_generation_mwh: number; usable_generation_mwh: number; served_mwh: number; average_power_served_mw: number; imports_mwh: number; exports_mwh: number; curtailed_mwh: number; by_kind_mwh: Record<string, number>; basis: string };
  carbon: CarbonMetrics;
  contracts: { status: string; price_usd_per_mwh: number; term_years: number; contracted_share: number; annual_volume_mwh: number; illustrative_annual_value_usd: number; basis: string };
  area: { area_km2: number | null; area_acres: number | null; required_land_acres: number; land_utilization: number | null; capex_usd_per_acre: number | null; annual_t_co2e_per_acre: number | null; demographics: AreaStats | null; basis: string };
  budget: { limit_usd: number | null; within_budget: boolean | null };
  provenance: Provenance;
}

export interface CarbonMetrics {
  booked_annual_cost_usd: number;
  all_emissions_exposure_usd: number;
  annual_operational_t_co2e: number;
  annual_direct_t_co2e: number;
  annual_imports_t_co2e: number;
  annual_upstream_t_co2e: number;
  upfront_t_co2e: number;
  other_upfront_t_co2e: number;
  replacement_t_co2e: number;
  analysis_years: number;
  modeled_total_t_co2e: number;
  carbon_price_usd_per_t: number;
  upfront_exposure_usd: number;
  modeled_total_exposure_usd: number;
  inventory_complete: boolean;
  unmodeled_asset_ids: string[];
  basis: string;
  provenance: Provenance;
  assets: { asset_id: string; kind: string; quantity: number; quantity_unit: string; factor: number; factor_unit: string; upfront_t_co2e: number; replacement_count: number; replacement_t_co2e: number; provenance: Provenance }[];
}

export function projectOf(r: ScenarioResult): ProjectMetrics | null {
  const p = r.evaluation.extras?.project;
  return p && typeof p === "object" && "production" in p ? p as ProjectMetrics : null;
}

export function resilienceOf(r: ScenarioResult): ResilienceMetrics | null {
  const p = r.simulation.extras?.resilience;
  return p && typeof p === "object" && "outage_hours" in p ? p as ResilienceMetrics : null;
}
