"""GridForge shared contract.

These are the ONLY types that cross workstream boundaries. Every module reads and
writes these shapes; the frontend mirrors them in frontend/lib/contract.ts.
Example payloads and JSON Schemas live in contracts/ (regenerate with
scripts/export_contract.py).

Change policy: never edit this file inside a feature PR. Put new outputs in an
`extras` dict (inputs in `Scenario.options`) first. When a field truly needs to be
typed, open a tiny "contract:" PR to main containing ONLY this file, the matching
change in frontend/lib/contract.ts, and the regenerated contracts/*.json; merge it
right away and tell the team to `git merge origin/main`. Add optional fields only:
no renames, removals, or unit changes. tests/test_contract.py fails if the two
files drift apart.

Units are always in the field name: _mw, _mwh, _usd, _km, _kg, _t (metric tons).
Time: every hourly array is hour-beginning, fixed UTC-8 (PST) all year, no DST.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

SCHEMA_VERSION = "0.1.0"

AssetKind = Literal["solar_pv", "onshore_wind", "gas_cc", "gas_ct", "battery"]
Mode = Literal["industrial", "community"]
Severity = Literal["pass", "info", "warn", "fail"]
ProvenanceKind = Literal["observed", "assumption", "simulated", "inferred"]


class Model(BaseModel):
    model_config = {"extra": "forbid"}


# ---------------------------------------------------------------------------
# Shared building blocks
# ---------------------------------------------------------------------------


class LngLat(Model):
    lon: float
    lat: float


class Provenance(Model):
    """Where a number came from. Shown in the UI next to every headline figure."""

    kind: ProvenanceKind
    source: str = Field(description='e.g. "EIA-860 2024", "ATB 2025 Moderate", "CAISO 2024"')
    url: str | None = None
    note: str | None = None


class Finding(Model):
    """One feasibility / screening result. Any module may emit findings."""

    id: str = Field(description='stable code, e.g. "storage_duration_short"')
    module: Literal["explore", "simulate", "evaluate", "stress", "site"]
    severity: Severity
    title: str
    detail: str
    metric: float | None = None
    threshold: float | None = None
    needs_utility_study: bool = False


class MapOverlay(Model):
    """A layer any module can ask the map to draw (e.g. satellite imagery, buffers)."""

    id: str
    label: str
    type: Literal["raster", "geojson"]
    url: str | None = Field(default=None, description="XYZ tile URL template for raster overlays")
    data: dict[str, Any] | None = Field(default=None, description="GeoJSON FeatureCollection for geojson overlays")
    opacity: float = 0.8
    attribution: str | None = None


# ---------------------------------------------------------------------------
# Scenario (the input everything runs on)
# ---------------------------------------------------------------------------


class Site(Model):
    id: str
    name: str
    location: LngLat
    county: str | None = None
    balancing_authority: str = "CAISO"
    utility_territory: str | None = Field(default=None, description='e.g. "PG&E"')
    footprint: dict[str, Any] | None = Field(default=None, description="GeoJSON Polygon of the parcel, optional")


class DemandSpec(Model):
    kind: Literal["data_center", "community"] = "data_center"
    peak_mw: float = Field(description="Facility peak draw at the meter, incl. cooling (IT load x PUE)")
    load_factor: float = Field(default=0.9, ge=0, le=1, description="Average load / peak load")
    pue: float = Field(default=1.2, ge=1)
    profile: Literal["flat", "ai_training", "ai_inference", "community"] = "flat"
    flexible_share: float = Field(
        default=0.0, ge=0, le=1, description="Share of load that can shift in time (carbon-aware scheduling)"
    )


class Asset(Model):
    id: str
    kind: AssetKind
    name: str | None = None
    capacity_mw: float = Field(ge=0)
    duration_h: float | None = Field(default=None, ge=0, description="Batteries only: energy = capacity_mw x duration_h")
    location: LngLat | None = None
    overrides: dict[str, float] = Field(
        default_factory=dict, description="Per-asset overrides of TechSpec fields, e.g. {'capex_usd_per_kw': 1100}"
    )


class GridConnection(Model):
    connected: bool = True
    import_limit_mw: float = Field(ge=0)
    export_limit_mw: float = Field(default=0, ge=0)
    interconnection_km: float = Field(default=5, ge=0, description="New line length to the point of interconnection")
    substation_id: str | None = None
    poi_voltage_kv: float | None = Field(
        default=None, description="Voltage at the point of interconnection (from A's nearest line/substation)"
    )
    new_substation: bool = True


class Assumptions(Model):
    weather_year: int = 2024
    analysis_years: int = 20
    discount_rate: float = 0.07
    gas_price_usd_per_mmbtu: float = 4.0
    carbon_price_usd_per_t: float = 0.0
    price_source: Literal["caiso_historical", "flat"] = "caiso_historical"
    flat_price_usd_per_mwh: float = 60.0
    import_adder_usd_per_mwh: float = Field(
        default=20.0, description="Added to the wholesale price for imports (transmission access + delivery charges)"
    )


class Scenario(Model):
    schema_version: str = SCHEMA_VERSION
    id: str
    name: str
    mode: Mode = "industrial"
    preset: str | None = None
    site: Site
    demand: DemandSpec
    assets: list[Asset] = Field(default_factory=list)
    grid: GridConnection
    assumptions: Assumptions = Field(default_factory=Assumptions)
    options: dict[str, Any] = Field(
        default_factory=dict, description="Escape hatch for experimental inputs before they earn a typed field"
    )


# ---------------------------------------------------------------------------
# Catalog (technology cost + performance assumptions)
# ---------------------------------------------------------------------------


class TechSpec(Model):
    kind: AssetKind
    label: str
    capex_usd_per_kw: float
    capex_usd_per_kwh: float | None = Field(default=None, description="Batteries: energy component of CAPEX")
    fixed_om_usd_per_kw_yr: float
    var_om_usd_per_mwh: float = 0.0
    heat_rate_mmbtu_per_mwh: float | None = None
    co2_kg_per_mmbtu: float | None = None
    round_trip_efficiency: float | None = None
    lifetime_years: int
    land_acres_per_mw: float
    typical_capacity_factor: float | None = None
    provenance: Provenance


class TransmissionSpec(Model):
    line_usd_per_km: float
    substation_usd: float
    provenance: Provenance


class Catalog(Model):
    techs: list[TechSpec]
    transmission: TransmissionSpec

    def spec(self, kind: AssetKind) -> TechSpec:
        return next(t for t in self.techs if t.kind == kind)


# ---------------------------------------------------------------------------
# Results
# ---------------------------------------------------------------------------


class HourlySeries(Model):
    """Hour-by-hour dispatch. Index i = the hour starting i hours after Jan 1 00:00 PST
    (fixed UTC-8, no DST) of weather_year. Length 8760, or 8784 in leap years."""

    start: str = Field(description='ISO timestamp of index 0, e.g. "2024-01-01T00:00:00-08:00"')
    step_minutes: int = 60
    demand_mw: list[float]
    generation_mw: dict[str, list[float]] = Field(description="Keyed by AssetKind (summed over assets of that kind)")
    battery_charge_mw: list[float]
    battery_discharge_mw: list[float]
    battery_soc_mwh: list[float]
    imports_mw: list[float]
    exports_mw: list[float]
    unmet_mw: list[float]
    curtailed_mw: list[float]
    price_usd_per_mwh: list[float]
    grid_co2_kg_per_mwh: list[float] = Field(description="Average CO2 intensity of grid imports each hour")


class SimulationSummary(Model):
    demand_mwh: float
    generation_mwh: dict[str, float]
    imports_mwh: float
    exports_mwh: float
    unmet_mwh: float
    curtailed_mwh: float
    peak_import_mw: float
    hours_unmet: int
    onsite_clean_share: float = Field(description="Share of demand met by on-site solar/wind/battery")
    battery_cycles: float


class SimulationResult(Model):
    scenario_id: str
    hourly: HourlySeries
    summary: SimulationSummary
    provenance: list[Provenance] = Field(default_factory=list)
    extras: dict[str, Any] = Field(
        default_factory=dict, description="Escape hatch: new outputs ship here first, typed fields later"
    )


class CostLine(Model):
    category: Literal["capex", "fixed_om", "var_om", "fuel", "purchased_power", "export_revenue", "carbon"]
    item: str
    usd: float = Field(description="CAPEX lines: one-time. All other lines: per year")
    provenance: Provenance


class BomItem(Model):
    item: str
    quantity: float
    unit: str
    basis: str = Field(description='How it was derived, e.g. "500 MW / 0.55 kW per panel"')


class Economics(Model):
    financial_boundary: str = Field(description="Who is paying, e.g. 'Campus owner: owns on-site assets, buys imports'")
    capex_total_usd: float
    annual_opex_usd: float
    npc_usd: float
    lcoe_usd_per_mwh: float = Field(description="Net present cost / discounted MWh of demand served")
    lines: list[CostLine]
    bom: list[BomItem] = Field(default_factory=list)


class Emissions(Model):
    annual_t_co2e: float
    by_source_t_co2e: dict[str, float]
    intensity_kg_per_mwh: float
    provenance: list[Provenance] = Field(default_factory=list)


class EvaluationResult(Model):
    economics: Economics
    emissions: Emissions
    extras: dict[str, Any] = Field(
        default_factory=dict, description="Escape hatch: new outputs ship here first, typed fields later"
    )


class SiteSummary(Model):
    """What the Explore map shows when a site is clicked."""

    site: Site
    nearest_substations: list[dict[str, Any]] = Field(
        default_factory=list, description="[{id, name, voltage_kv, distance_km, location}]"
    )
    nearby_plants: list[dict[str, Any]] = Field(
        default_factory=list, description="[{id, name, fuel, capacity_mw, distance_km}]"
    )
    nearest_line_kv: float | None = None
    nearest_line_km: float | None = None
    population_within_10km: int | None = None
    findings: list[Finding] = Field(default_factory=list)
    provenance: list[Provenance] = Field(default_factory=list)
    extras: dict[str, Any] = Field(
        default_factory=dict, description="Escape hatch: new outputs ship here first, typed fields later"
    )


class SiteIntel(Model):
    """Satellite / environmental screening of the site (Earth Engine, Planet, AirNow, grid carbon)."""

    location: LngLat
    land_cover: dict[str, float] = Field(default_factory=dict, description="Class -> share of the site buffer")
    mean_slope_deg: float | None = None
    solar_ghi_kwh_m2_day: float | None = None
    air_quality: dict[str, Any] | None = Field(default=None, description="AirNow observation: {aqi, pollutant, category}")
    overlays: list[MapOverlay] = Field(default_factory=list)
    findings: list[Finding] = Field(default_factory=list)
    provenance: list[Provenance] = Field(default_factory=list)
    extras: dict[str, Any] = Field(
        default_factory=dict, description="Escape hatch: new outputs ship here first, typed fields later"
    )


class ScenarioResult(Model):
    """Everything POST /api/run returns. The dashboard renders only this."""

    schema_version: str = SCHEMA_VERSION
    scenario: Scenario
    simulation: SimulationResult
    evaluation: EvaluationResult
    findings: list[Finding]
