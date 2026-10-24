"""Explicit screening assumptions for jobs, demand growth and offtake.

All outputs live in evaluation.extras.project; no shared contract changes.
Jobs are a spending/labor scenario, not a calibrated JEDI model or net jobs forecast.
"""
from __future__ import annotations

from pydantic import Field, ValidationError

from app.contract import Catalog, Economics, Emissions, Model, Provenance, Scenario, SimulationResult


class ProjectOptions(Model):
    annual_demand_growth: float = Field(default=0.02, ge=0, le=0.3)
    projection_years: int = Field(default=5, ge=0, le=30)
    critical_load_share: float = Field(default=1, gt=0, le=1)
    outage_hours: int = Field(default=24, ge=1, le=168)
    budget_usd: float | None = Field(default=None, gt=0)
    construction_years: float = Field(default=2, ge=0.25, le=10)
    construction_labor_share: float = Field(default=0.2, ge=0, le=1)
    operations_labor_share: float = Field(default=0.35, ge=0, le=1)
    annual_compensation_usd: float = Field(default=120000, ge=10000, le=1000000)
    local_labor_share: float = Field(default=0.6, ge=0, le=1)
    contract_price_usd_per_mwh: float = Field(default=80, ge=0, le=1000)
    contract_years: int = Field(default=10, ge=1, le=40)
    contracted_share: float = Field(default=0, ge=0, le=1)


def project_options(scenario: Scenario) -> tuple[ProjectOptions, list[str]]:
    """Older / externally authored scenarios remain runnable; invalid options are disclosed."""
    try:
        return ProjectOptions.model_validate(scenario.options.get("project", {})), []
    except ValidationError:
        return ProjectOptions(), ["Invalid project assumptions: screening defaults used. Reapply the project planner to correct them."]


def project_metrics(scenario: Scenario, sim: SimulationResult, catalog: Catalog,
                    economics: Economics, emissions: Emissions, land_acres: float) -> dict:
    p, warnings = project_options(scenario)
    h, s = sim.hourly, sim.summary
    served = max(0, s.demand_mwh - s.unmet_mwh)
    hours = len(h.demand_mw) * h.step_minutes / 60
    factor = (1 + p.annual_demand_growth) ** p.projection_years
    # Fixed/variable O&M only: fuel, purchased power and carbon are not payroll.
    om = sum(max(0, line.usd) for line in economics.lines if line.category in ("fixed_om", "var_om"))
    construction = economics.capex_total_usd * p.construction_labor_share / p.annual_compensation_usd
    operations = om * p.operations_labor_share / p.annual_compensation_usd
    carbon_booked = sum(line.usd for line in economics.lines if line.category == "carbon")
    gross = sum(v for k, v in s.generation_mwh.items() if k != "battery")
    usable = max(0, gross - s.curtailed_mwh)  # battery discharge is transferred energy, not new generation
    contracted = usable * p.contracted_share
    area = None
    demographics = None
    if scenario.site.footprint:
        from app.explore.area import AreaRequest, area_geometry, summarize_area
        try:
            _, area = area_geometry(scenario.site.footprint)
            area_inputs = scenario.options.get("area", {})
            if not isinstance(area_inputs, dict):
                raise ValueError("Household and demand assumptions must be an object.")
            demographics = summarize_area(AreaRequest.model_validate({**area_inputs, "footprint": scenario.site.footprint}))
        except ValueError as exc:
            warnings.append(f"Selected area unavailable: {exc}")
    footprint_acres = area * 247.105381 if area is not None else None
    jobs_prov = Provenance(kind="assumption", source="Griddy editable labor-spending assumptions",
        url="https://www.nrel.gov/analysis/jedi/results.html",
        note="CAPEX × construction labor share / annual compensation = FTE-years; O&M × operations labor share / compensation = ongoing FTE. Defaults are illustrative, not NREL coefficients. No indirect, induced, displaced or net jobs.")
    return {
        "assumptions": p.model_dump(), "warnings": warnings,
        "projection": {"years": p.projection_years, "annual_growth": p.annual_demand_growth,
            "current_peak_mw": scenario.demand.peak_mw, "projected_peak_mw": scenario.demand.peak_mw * factor,
            "current_demand_mwh": s.demand_mwh, "projected_demand_mwh": s.demand_mwh * factor,
            "basis": "Compound load growth with unchanged load shape. Future demand only; costs and emissions below are for the simulated design year."},
        "jobs": {"construction_fte_years": construction, "average_construction_fte": construction / p.construction_years,
            "operations_fte": operations, "local_construction_fte_years": construction * p.local_labor_share,
            "local_operations_fte": operations * p.local_labor_share, "provenance": jobs_prov.model_dump()},
        "production": {"gross_generation_mwh": gross, "usable_generation_mwh": usable,
            "served_mwh": served, "average_power_served_mw": served / hours if hours else 0,
            "imports_mwh": s.imports_mwh, "exports_mwh": s.exports_mwh, "curtailed_mwh": s.curtailed_mwh,
            "by_kind_mwh": s.generation_mwh,
            "basis": "Hourly dispatch; gross generation includes curtailed renewables. Usable generation subtracts curtailment but precedes storage losses. Storage discharge excluded from generation totals."},
        "carbon": {"booked_annual_cost_usd": carbon_booked,
            "all_emissions_exposure_usd": emissions.annual_t_co2e * max(0, scenario.assumptions.carbon_price_usd_per_t),
            "basis": "Booked cost follows the financial model's carbon boundary. Exposure = all annual project CO2e × entered price; a sensitivity, not an additional charge or a compliance determination."},
        "contracts": {"status": "Illustrative offtake assumption; no executed contracts",
            "price_usd_per_mwh": p.contract_price_usd_per_mwh, "term_years": p.contract_years,
            "contracted_share": p.contracted_share, "annual_volume_mwh": contracted,
            "illustrative_annual_value_usd": contracted * p.contract_price_usd_per_mwh,
            "basis": "Share of usable on-site generation, before storage losses. Indicative gross value only; not deducted from owner costs. No delivery, additionality or firm-volume guarantee."},
        "area": {"area_km2": area, "area_acres": footprint_acres, "required_land_acres": land_acres,
            "demographics": demographics,
            "land_utilization": land_acres / footprint_acres if footprint_acres else None,
            "capex_usd_per_acre": economics.capex_total_usd / footprint_acres if footprint_acres else None,
            "annual_t_co2e_per_acre": emissions.annual_t_co2e / footprint_acres if footprint_acres else None,
            "basis": "Project costs and annual emissions assigned to the selected footprint; not measured ambient emissions. Land requirement uses full project area, including wind spacing."},
        "budget": {"limit_usd": p.budget_usd,
            "within_budget": economics.capex_total_usd <= p.budget_usd if p.budget_usd is not None else None},
        "provenance": Provenance(kind="simulated", source="Griddy hourly dispatch and cited Evaluate cost/emissions models",
            note="Screening estimates; demand growth, labor and offtake inputs are assumptions. See cost and emissions provenance for source factors.").model_dump(),
    }
