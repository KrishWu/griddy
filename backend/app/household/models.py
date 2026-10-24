"""Griddy Home request/response models.  OWNER: household (backend).

Mirrors frontend/components/household/types.ts field for field. Units live in field names (_kwh, _usd, _kg).
Hourly math runs on the 2024 calendar (8784 h, hour-beginning, fixed UTC-8), aligned with
data/simulate/caiso_2024_hourly.csv.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, model_validator

ProvKind = Literal["observed", "assumption", "simulated", "inferred"]
UtilityId = Literal["pge", "pge_svce", "sce", "sdge", "municipal", "other"]
RatePlanId = Literal["E-TOU-C", "E-TOU-D", "EV2-A", "E-ELEC", "unknown"]
LoadSource = Literal["interval_data", "simulated_from_monthly", "simulated_from_benchmark"]
Effort = Literal["easy", "moderate", "investment"]


class In(BaseModel):
    # Requests: tolerate extra keys from a newer frontend; reject NaN/inf.
    model_config = {"extra": "ignore", "allow_inf_nan": False}


class Out(BaseModel):
    # Responses: every number must be finite (NaN/inf fail validation with the field name).
    model_config = {"extra": "forbid", "allow_inf_nan": False}


class Prov(Out):
    kind: ProvKind
    source: str
    url: str | None = None
    note: str | None = None


# ---------------------------------------------------------------------------
# Request
# ---------------------------------------------------------------------------

def Hour():  # noqa: N802 - a fresh FieldInfo per field
    return Field(default=None, ge=0, le=23)


class EVInput(In):
    has_ev: bool
    miles_per_day: float | None = Field(default=None, ge=0, le=500)
    charge_start_hour: int | None = Hour()


class CoolingInput(In):
    has_ac: bool
    setpoint_f: float | None = Field(default=None, ge=55, le=95)


class WhatIfInput(In):
    ev_charge_start_hour: int | None = Hour()
    laundry_hour: int | None = Hour()
    dishwasher_hour: int | None = Hour()
    ac_setpoint_delta_f: float | None = Field(default=None, ge=-10, le=10)
    solar_kw: float | None = Field(default=None, ge=0, le=50)
    battery_kwh: float | None = Field(default=None, ge=0, le=100)
    rate_escalation_pct: float | None = Field(default=None, ge=-10, le=30)
    years: int | None = Field(default=None, ge=1, le=30)
    rate_plan: str | None = None


class HouseholdRequest(In):
    zip: str | None = None
    city: str | None = None
    # A map pin (the house). When both are given they win over zip/city for the location, the
    # nearest PVWatts profile city and the coastal/inland climate.
    lat: float | None = Field(default=None, ge=-90, le=90, allow_inf_nan=False)
    lon: float | None = Field(default=None, ge=-180, le=180, allow_inf_nan=False)
    utility: UtilityId = "pge"
    rate_plan: RatePlanId = "unknown"
    custom_rate_usd_per_kwh: float | None = Field(default=None, ge=0, le=5)
    monthly_kwh: float | list[float] | None = None
    interval_matrix_kwh: list[list[list[float]]] | None = None
    has_solar: bool = False
    existing_solar_kw: float | None = Field(default=None, ge=0, le=50)
    has_battery: bool = False
    existing_battery_kwh: float | None = Field(default=None, ge=0, le=100)
    occupants: int | None = Field(default=None, ge=1, le=20)
    ev: EVInput | None = None
    cooling: CoolingInput | None = None
    electric_heating: bool | None = None
    laundry_hour: int | None = Hour()
    dishwasher_hour: int | None = Hour()
    home_daytime: bool | None = None
    owns_home: bool | None = None
    roof_kw_max: float | None = Field(default=None, ge=0, le=50)
    whatif: WhatIfInput | None = None
    view_month: int | None = Field(default=None, ge=1, le=12)
    view_day_type: Literal["all", "weekday", "weekend"] = "all"
    view_hour: int = Field(default=12, ge=0, le=23)

    @model_validator(mode="after")
    def paired_coordinates(self):
        if (self.lat is None) != (self.lon is None):
            raise ValueError("Provide both latitude and longitude for a house pin.")
        return self


class UsageParseRequest(In):
    csv_text: str = Field(max_length=20_000_000)


# ---------------------------------------------------------------------------
# Options + usage parse
# ---------------------------------------------------------------------------


class UtilityOption(Out):
    id: str
    label: str
    supported: bool


class PlanOption(Out):
    id: str
    label: str
    utility: str
    summary: str
    eligibility: str


class HouseholdOptions(Out):
    utilities: list[UtilityOption]
    plans: list[PlanOption]
    default_plan: Literal["E-TOU-C"] = "E-TOU-C"
    solar_profile_cities: list[str]
    provenance: list[Prov]


class UsageParseResult(Out):
    matrix_kwh: list[list[list[float]]]
    days: int
    interval_minutes: int
    annual_kwh_estimate: float
    warnings: list[str]


# ---------------------------------------------------------------------------
# Result
# ---------------------------------------------------------------------------


class Location(Out):
    zip: str | None = None
    city: str | None = None
    lat: float
    lon: float
    solar_profile_city: str
    note: str | None = None


class AvgDay(Out):
    summer: list[float]
    winter: list[float]
    all: list[float]


class Benchmark(Out):
    ca_avg_annual_kwh: float
    label: str
    provenance: Prov


class Usage(Out):
    annual_kwh: float
    monthly_kwh: list[float]
    avg_day_kwh: AvgDay
    by_end_use_kwh: dict[str, float]
    peak_hour: int
    peak_window_share: float
    benchmark: Benchmark


class PeriodCost(Out):
    period: str
    kwh: float
    usd: float
    avg_rate: float


class PeriodsByHour(Out):
    summer: list[str]
    winter: list[str]


class PlanCompare(Out):
    plan: str
    label: str
    annual_usd: float
    eligible: bool
    note: str | None = None


class Bill(Out):
    plan: str
    plan_label: str
    annual_usd: float
    monthly_usd: list[float]
    fixed_usd: float
    by_period: list[PeriodCost]
    effective_usd_per_kwh: float
    periods_by_hour: PeriodsByHour
    plan_comparison: list[PlanCompare]
    provenance: list[Prov]
    warnings: list[str]


class Sources(Out):
    provider: str
    label_year: int
    mix_pct: dict[str, float]
    ghg_lb_per_mwh: float
    caiso_avg_day_mix_mw: dict[str, list[float]]
    caiso_avg_day_clean_share: list[float]
    note: str
    provenance: list[Prov]


class Equivalents(Out):
    car_miles: float
    tree_seedlings_10yr: float
    share_of_ca_avg_household: float


class Carbon(Out):
    annual_kg_hourly: float
    annual_kg_provider: float
    monthly_kg: list[float]
    avg_day_intensity_kg_per_kwh: list[float]
    equivalents: Equivalents
    cleanest_hours: list[int]
    dirtiest_hours: list[int]
    provenance: list[Prov]


class WhatIfBaseline(Out):
    annual_usd: float
    annual_kwh: float
    annual_kg: float


class Scenario(Out):
    id: str
    label: str
    detail: str
    annual_usd_saved: float
    annual_kwh_change: float
    annual_kg_saved: float
    preserves_total_kwh: bool
    assumption: str
    applicable: bool


class Combined(Out):
    annual_usd: float
    annual_kwh: float
    annual_kg: float
    annual_usd_saved: float
    annual_kg_saved: float


class WhatIf(Out):
    baseline: WhatIfBaseline
    scenarios: list[Scenario]
    combined: Combined


class Solar(Out):
    kw: float
    battery_kwh: float
    annual_production_kwh: float
    self_consumed_kwh: float
    exported_kwh: float
    battery_discharge_kwh: float
    bill_before_usd: float
    bill_after_usd: float
    annual_savings_usd: float
    export_credit_usd: float
    upfront_cost_usd: float
    incentives_usd: float
    payback_years: float | None
    npv_usd: float
    monthly_production_kwh: list[float]
    avg_day_production_kwh: list[float]
    annual_kg_saved: float
    applicable: bool
    note: str | None = None
    provenance: list[Prov]


class Projection(Out):
    years: list[int]
    baseline_usd: list[float]
    with_actions_usd: list[float]
    with_solar_usd: list[float] | None
    cumulative_savings_usd: list[float]
    escalation_pct: float
    provenance: list[Prov]


class Recommendation(Out):
    id: str
    title: str
    detail: str
    annual_usd_saved: float
    annual_kg_saved: float
    effort: Effort
    upfront_usd: float | None = None


class Assumption(Out):
    key: str
    label: str
    value: str
    provenance: Prov


class HouseholdResult(Out):
    location: Location
    load_source: LoadSource
    load_label: str
    usage: Usage
    bill: Bill
    sources: Sources
    carbon: Carbon
    whatif: WhatIf
    solar: Solar | None
    projection: Projection
    recommendations: list[Recommendation]
    assumptions: list[Assumption]
    warnings: list[str]
    time_view: dict
