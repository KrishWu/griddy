// Griddy Home request/response types. Mirrors backend/app/household/models.py field for field (the
// spec's TypeScript), so keep the two in step: optional fields only, never rename or change units.
// OWNER: household (frontend).

export type Prov = { kind: "observed" | "assumption" | "simulated" | "inferred"; source: string; url?: string | null; note?: string | null };

export type UtilityId = "pge" | "pge_svce" | "sce" | "sdge" | "municipal" | "other";
export type RatePlanId = "E-TOU-C" | "E-TOU-D" | "EV2-A" | "E-ELEC" | "unknown";

export interface HouseholdWhatIf {
  ev_charge_start_hour?: number | null;
  laundry_hour?: number | null;
  dishwasher_hour?: number | null;
  ac_setpoint_delta_f?: number | null;
  solar_kw?: number | null;
  battery_kwh?: number | null;
  rate_escalation_pct?: number | null;
  years?: number | null;
  rate_plan?: string | null;
}

export interface HouseholdRequest {
  zip?: string | null;
  city?: string | null;
  /** The house pin on the map; wins over zip/city for location, solar profile and climate. */
  lat?: number | null;
  lon?: number | null;
  utility: UtilityId;
  rate_plan: RatePlanId;
  custom_rate_usd_per_kwh?: number | null;
  monthly_kwh?: number | number[] | null;
  interval_matrix_kwh?: number[][][] | null; // from /usage/parse
  has_solar: boolean;
  existing_solar_kw?: number | null;
  has_battery: boolean;
  existing_battery_kwh?: number | null;
  occupants?: number | null;
  ev?: { has_ev: boolean; miles_per_day?: number | null; charge_start_hour?: number | null } | null;
  cooling?: { has_ac: boolean; setpoint_f?: number | null } | null;
  electric_heating?: boolean | null;
  laundry_hour?: number | null;
  dishwasher_hour?: number | null;
  home_daytime?: boolean | null;
  owns_home?: boolean | null;
  roof_kw_max?: number | null;
  whatif?: HouseholdWhatIf | null;
  view_month?: number | null;
  view_day_type?: "all" | "weekday" | "weekend";
  view_hour?: number;
}

export interface TimeSelection {
  view_month: number | null;
  view_day_type: "all" | "weekday" | "weekend";
  view_hour: number;
}

export interface HomeTimeView {
  annual_grid_clean_share: number | null;
  reference_year: number;
  month: number | null;
  day_type: "all" | "weekday" | "weekend";
  hour: number;
  label: string;
  days: number;
  load_kwh: number[];
  grid_import_kwh: number[];
  solar_kwh: number[];
  carbon_kg: number[];
  intensity_kg_per_kwh: number[];
  import_energy_cost_usd: number[];
  retail_rate_usd_per_kwh: number[];
  periods_by_hour: string[];
  mix_mw: Record<string, number[]>;
  clean_share: number[];
  basis: string;
}

export interface HouseholdOptions {
  utilities: { id: string; label: string; supported: boolean }[];
  plans: { id: string; label: string; utility: string; summary: string; eligibility: string }[];
  default_plan: "E-TOU-C";
  solar_profile_cities: string[];
  provenance: Prov[];
}

export interface UsageParseResult {
  matrix_kwh: number[][][]; // [12][2][24]: month x [weekday, weekend] x hour
  days: number;
  interval_minutes: number;
  annual_kwh_estimate: number;
  warnings: string[];
}

export type LoadSource = "interval_data" | "simulated_from_monthly" | "simulated_from_benchmark";

export interface WhatIfScenario {
  id: string;
  label: string;
  detail: string;
  annual_usd_saved: number;
  annual_kwh_change: number;
  annual_kg_saved: number;
  preserves_total_kwh: boolean;
  assumption: string;
  applicable: boolean;
}

export interface SolarResult {
  kw: number;
  battery_kwh: number;
  annual_production_kwh: number;
  self_consumed_kwh: number;
  exported_kwh: number;
  battery_discharge_kwh: number;
  bill_before_usd: number;
  bill_after_usd: number;
  annual_savings_usd: number;
  export_credit_usd: number;
  upfront_cost_usd: number;
  incentives_usd: number;
  payback_years: number | null;
  npv_usd: number;
  monthly_production_kwh: number[];
  avg_day_production_kwh: number[];
  annual_kg_saved: number;
  applicable: boolean;
  note?: string | null;
  provenance: Prov[];
}

export interface Recommendation {
  id: string;
  title: string;
  detail: string;
  annual_usd_saved: number;
  annual_kg_saved: number;
  effort: "easy" | "moderate" | "investment";
  upfront_usd?: number | null;
}

export interface HouseholdResult {
  time_view?: HomeTimeView;
  location: { zip?: string | null; city?: string | null; lat: number; lon: number; solar_profile_city: string; note?: string | null };
  load_source: LoadSource;
  load_label: string;
  usage: {
    annual_kwh: number;
    monthly_kwh: number[];
    avg_day_kwh: { summer: number[]; winter: number[]; all: number[] };
    by_end_use_kwh: Record<string, number>;
    peak_hour: number;
    peak_window_share: number;
    benchmark: { ca_avg_annual_kwh: number; label: string; provenance: Prov };
  };
  bill: {
    plan: string;
    plan_label: string;
    annual_usd: number;
    monthly_usd: number[];
    fixed_usd: number;
    by_period: { period: string; kwh: number; usd: number; avg_rate: number }[];
    effective_usd_per_kwh: number;
    periods_by_hour: { summer: string[]; winter: string[] }; // weekday periods for chart bands
    plan_comparison: { plan: string; label: string; annual_usd: number; eligible: boolean; note?: string | null }[];
    provenance: Prov[];
    warnings: string[];
  };
  sources: {
    provider: string;
    label_year: number;
    mix_pct: Record<string, number>;
    ghg_lb_per_mwh: number;
    caiso_avg_day_mix_mw: Record<string, number[]>;
    caiso_avg_day_clean_share: number[];
    note: string;
    provenance: Prov[];
  };
  carbon: {
    annual_kg_hourly: number;
    annual_kg_provider: number;
    monthly_kg: number[];
    avg_day_intensity_kg_per_kwh: number[];
    equivalents: { car_miles: number; tree_seedlings_10yr: number; share_of_ca_avg_household: number };
    cleanest_hours: number[];
    dirtiest_hours: number[];
    provenance: Prov[];
  };
  whatif: {
    baseline: { annual_usd: number; annual_kwh: number; annual_kg: number };
    scenarios: WhatIfScenario[];
    combined: { annual_usd: number; annual_kwh: number; annual_kg: number; annual_usd_saved: number; annual_kg_saved: number };
  };
  solar: null | SolarResult;
  projection: {
    years: number[];
    baseline_usd: number[];
    with_actions_usd: number[];
    with_solar_usd: number[] | null;
    cumulative_savings_usd: number[];
    escalation_pct: number;
    provenance: Prov[];
  };
  recommendations: Recommendation[];
  assumptions: { key: string; label: string; value: string; provenance: Prov }[];
  warnings: string[];
}

/** POST /api/household/solar/optimize: search solar kW (and battery kWh) for the best 25-year NPV. */
export interface SolarOptimizeRequest {
  household: HouseholdRequest;
  budget_usd?: number | null;
  roof_kw_max?: number | null;
  include_battery?: boolean;
}

export interface SolarOptimizeCandidate {
  solar_kw: number;
  battery_kwh: number;
  upfront_cost_usd: number;
  npv_usd: number;
  payback_years: number | null;
  feasible: boolean;
}

export interface SolarOptimizeResult {
  applicable: boolean;
  solar_kw: number;
  battery_kwh: number;
  upfront_cost_usd: number;
  annual_savings_usd: number;
  payback_years: number | null;
  npv_usd: number;
  annual_production_kwh: number;
  /** Production / annual use. */
  offset_share: number;
  /** What capped the size: any of "roof", "budget", "demand". */
  binding: string[];
  reason: string;
  candidates: SolarOptimizeCandidate[];
  provenance: Prov[];
}
