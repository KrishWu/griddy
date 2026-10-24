// Griddy shared contract — TypeScript mirror of backend/app/contract.py.
// Never edit inside a feature PR: changes go in a tiny "contract:" PR to main together
// with contract.py and contracts/*.json (see the docstring in contract.py).
// backend/tests/test_contract.py fails if a field here doesn't match contract.py.
// Units are always in the field name: _mw, _mwh, _usd, _km, _kg, _t (metric tons).
// Time: hourly arrays are hour-beginning, fixed UTC-8 (PST) all year, no DST.

export const SCHEMA_VERSION = "0.1.0";

export type AssetKind = "solar_pv" | "onshore_wind" | "gas_cc" | "gas_ct" | "battery";
export type Mode = "industrial" | "community";
export type Severity = "pass" | "info" | "warn" | "fail";
export type ProvenanceKind = "observed" | "assumption" | "simulated" | "inferred";

export interface LngLat {
  lon: number;
  lat: number;
}

export interface Provenance {
  kind: ProvenanceKind;
  source: string;
  url?: string | null;
  note?: string | null;
}

export interface Finding {
  id: string;
  module: "explore" | "simulate" | "evaluate" | "stress" | "site";
  severity: Severity;
  title: string;
  detail: string;
  metric?: number | null;
  threshold?: number | null;
  needs_utility_study?: boolean;
}

export interface MapOverlay {
  id: string;
  label: string;
  type: "raster" | "geojson";
  url?: string | null;
  data?: GeoJSON.FeatureCollection | null;
  opacity?: number;
  attribution?: string | null;
}

// ---------------------------------------------------------------------------
// Scenario
// ---------------------------------------------------------------------------

export interface Site {
  id: string;
  name: string;
  location: LngLat;
  county?: string | null;
  balancing_authority?: string;
  utility_territory?: string | null;
  footprint?: GeoJSON.Polygon | null;
}

export interface DemandSpec {
  kind?: "data_center" | "community";
  peak_mw: number;
  load_factor?: number;
  pue?: number;
  profile?: "flat" | "ai_training" | "ai_inference" | "community";
  flexible_share?: number;
}

export interface Asset {
  id: string;
  kind: AssetKind;
  name?: string | null;
  capacity_mw: number;
  duration_h?: number | null;
  location?: LngLat | null;
  overrides?: Record<string, number>;
}

export interface GridConnection {
  connected?: boolean;
  import_limit_mw: number;
  export_limit_mw?: number;
  interconnection_km?: number;
  substation_id?: string | null;
  poi_voltage_kv?: number | null;
  new_substation?: boolean;
}

export interface Assumptions {
  weather_year?: number;
  analysis_years?: number;
  discount_rate?: number;
  gas_price_usd_per_mmbtu?: number;
  carbon_price_usd_per_t?: number;
  price_source?: "caiso_historical" | "flat";
  flat_price_usd_per_mwh?: number;
  import_adder_usd_per_mwh?: number;
}

export interface Scenario {
  schema_version?: string;
  id: string;
  name: string;
  mode?: Mode;
  preset?: string | null;
  site: Site;
  demand: DemandSpec;
  assets: Asset[];
  grid: GridConnection;
  assumptions?: Assumptions;
  /** Escape hatch for experimental inputs before they earn a typed field. */
  options?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

export interface TechSpec {
  kind: AssetKind;
  label: string;
  capex_usd_per_kw: number;
  capex_usd_per_kwh?: number | null;
  fixed_om_usd_per_kw_yr: number;
  var_om_usd_per_mwh: number;
  heat_rate_mmbtu_per_mwh?: number | null;
  co2_kg_per_mmbtu?: number | null;
  round_trip_efficiency?: number | null;
  lifetime_years: number;
  land_acres_per_mw: number;
  typical_capacity_factor?: number | null;
  provenance: Provenance;
}

export interface TransmissionSpec {
  line_usd_per_km: number;
  substation_usd: number;
  provenance: Provenance;
}

export interface Catalog {
  techs: TechSpec[];
  transmission: TransmissionSpec;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export interface HourlySeries {
  start: string;
  step_minutes: number;
  demand_mw: number[];
  generation_mw: Partial<Record<AssetKind, number[]>>;
  battery_charge_mw: number[];
  battery_discharge_mw: number[];
  battery_soc_mwh: number[];
  imports_mw: number[];
  exports_mw: number[];
  unmet_mw: number[];
  curtailed_mw: number[];
  price_usd_per_mwh: number[];
  grid_co2_kg_per_mwh: number[];
}

export interface SimulationSummary {
  demand_mwh: number;
  generation_mwh: Partial<Record<AssetKind, number>>;
  imports_mwh: number;
  exports_mwh: number;
  unmet_mwh: number;
  curtailed_mwh: number;
  peak_import_mw: number;
  hours_unmet: number;
  onsite_clean_share: number;
  battery_cycles: number;
}

export interface SimulationResult {
  scenario_id: string;
  hourly: HourlySeries;
  summary: SimulationSummary;
  provenance: Provenance[];
  /** Escape hatch: new outputs ship here first, typed fields later. */
  extras?: Record<string, unknown>;
}

export interface CostLine {
  category: "capex" | "fixed_om" | "var_om" | "fuel" | "purchased_power" | "export_revenue" | "carbon";
  item: string;
  usd: number;
  provenance: Provenance;
}

export interface BomItem {
  item: string;
  quantity: number;
  unit: string;
  basis: string;
}

export interface Economics {
  financial_boundary: string;
  capex_total_usd: number;
  annual_opex_usd: number;
  npc_usd: number;
  lcoe_usd_per_mwh: number;
  lines: CostLine[];
  bom: BomItem[];
}

export interface Emissions {
  annual_t_co2e: number;
  by_source_t_co2e: Record<string, number>;
  intensity_kg_per_mwh: number;
  provenance: Provenance[];
}

export interface EvaluationResult {
  economics: Economics;
  emissions: Emissions;
  /** Escape hatch: new outputs ship here first, typed fields later. */
  extras?: Record<string, unknown>;
}

export interface NearbyAsset {
  id: string;
  name: string;
  distance_km: number;
  [key: string]: unknown;
}

export interface SiteSummary {
  site: Site;
  nearest_substations: NearbyAsset[];
  nearby_plants: NearbyAsset[];
  nearest_line_kv?: number | null;
  nearest_line_km?: number | null;
  population_within_10km?: number | null;
  findings: Finding[];
  provenance: Provenance[];
  /** Escape hatch: new outputs ship here first, typed fields later. */
  extras?: Record<string, unknown>;
}

export interface SiteIntel {
  location: LngLat;
  land_cover: Record<string, number>;
  mean_slope_deg?: number | null;
  solar_ghi_kwh_m2_day?: number | null;
  air_quality?: { aqi?: number; pollutant?: string; category?: string; [key: string]: unknown } | null;
  overlays: MapOverlay[];
  findings: Finding[];
  provenance: Provenance[];
  /** Escape hatch: new outputs ship here first, typed fields later. */
  extras?: Record<string, unknown>;
}

export interface ScenarioResult {
  schema_version: string;
  scenario: Scenario;
  simulation: SimulationResult;
  evaluation: EvaluationResult;
  findings: Finding[];
}

// ---------------------------------------------------------------------------
// Phase 2: demand forecast (A, /api/forecast) and site recommendations (B, /api/sites)
// ---------------------------------------------------------------------------

/** What-if inputs for the demand forecast. Unset fields take the named scenario's preset. */
export interface ForecastRequest {
  scenario?: string;
  year?: number;
  population_growth?: number | null;
  use_dof_population?: boolean | null;
  electrification_growth?: number | null;
  efficiency_offset?: number | null;
  /** New data-center peak MW by 5-digit county FIPS. */
  data_center_mw?: Record<string, number> | null;
  data_center_load_factor?: number | null;
  /** Share of data-center load that shifts off the peak (carbon-aware scheduling). */
  data_center_flexible_share?: number | null;
}

export interface RegionForecast {
  region: string;
  name: string;
  base_peak_mw: number;
  base_energy_mwh: number;
  peak_mw_p50: number;
  peak_mw_p90: number;
  energy_mwh: number;
  growth_peak_mw_p90: number;
  /** [{year, peak_mw_p50, peak_mw_p90, energy_mwh}] from the base year to the target year. */
  trajectory?: Record<string, number>[];
}

export interface CountyForecast {
  geoid: string;
  county: string;
  region: string;
  base_peak_mw: number;
  peak_mw_p50: number;
  peak_mw_p90: number;
  energy_mwh: number;
  growth_peak_mw_p90: number;
  added_load_mw?: number;
}

export interface DemandForecast {
  available: boolean;
  mode: "ml" | "scenario_on_observed" | "unavailable";
  artifact_id?: string | null;
  base_year?: number | null;
  scenario: string;
  year: number;
  params?: Record<string, unknown>;
  scenarios?: Record<string, Record<string, unknown>>;
  years?: number[];
  regions?: RegionForecast[];
  counties?: CountyForecast[];
  total_growth_peak_mw_p90?: number;
  metrics?: Record<string, unknown>;
  provenance?: Provenance[];
  notes?: string[];
  extras?: Record<string, unknown>;
}

/** What-if inputs for site recommendations: a forecast plus how to cover its growth. */
export interface SiteRequest {
  forecast?: ForecastRequest;
  /** clean_energy_share (0-1) of new energy from solar_pv : onshore_wind; the remaining peak from battery : gas_cc (relative weights). */
  mix?: Record<string, number> | null;
  weights?: Record<string, number> | null;
}

export interface SiteCandidate {
  id: string;
  kind: AssetKind;
  mw: number;
  location: LngLat;
  county?: string | null;
  region: string;
  suitability: number;
  d_line_hv_km: number;
  d_sub_hv_km?: number | null;
  queue_mw?: number;
  growth_150km_gwh?: number;
  in_nonattainment?: boolean;
  capex_usd?: number | null;
  gen_tie_usd?: number | null;
  reason: string;
}

/** Screening candidates, not buildable sites. */
export interface SiteRecommendation {
  available: boolean;
  mode: "model" | "heuristic" | "unavailable";
  artifact_id?: string | null;
  scenario: string;
  year: number;
  need_mw_by_region?: Record<string, number>;
  nameplate_need_mw?: Record<string, number>;
  allocated_mw?: Record<string, number>;
  unmet_mw?: Record<string, number>;
  capacity_credit?: Record<string, number>;
  sites?: SiteCandidate[];
  total_capex_usd?: number | null;
  model_metrics?: Record<string, unknown>;
  provenance?: Provenance[];
  caveats?: string[];
  extras?: Record<string, unknown>;
}
