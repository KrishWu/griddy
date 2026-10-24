// GridForge shared contract — TypeScript mirror of backend/app/contract.py.
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
