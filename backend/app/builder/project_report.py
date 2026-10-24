"""Stable, unit-bearing CSV rows for the experimental project outputs."""
from app.contract import ScenarioResult

UNITS = {
    "annual_demand_growth": "fraction/yr", "projection_years": "years", "construction_years": "years",
    "construction_labor_share": "fraction", "operations_labor_share": "fraction", "local_labor_share": "fraction",
    "annual_compensation_usd": "USD/FTE-year", "contract_price_usd_per_mwh": "USD/MWh", "contract_years": "years",
    "persons_per_household": "people/household", "household_kwh_per_year": "kWh/household/yr", "load_factor": "fraction",
    "construction_fte_years": "FTE-years", "local_construction_fte_years": "FTE-years",
    "average_construction_fte": "FTE", "operations_fte": "FTE/yr", "local_operations_fte": "FTE/yr",
    "years": "years", "annual_growth": "fraction/yr", "contracted_share": "fraction",
    "annual_volume_mwh": "MWh/yr", "gross_generation_mwh": "MWh/yr", "usable_generation_mwh": "MWh/yr",
    "served_mwh": "MWh/yr", "imports_mwh": "MWh/yr", "exports_mwh": "MWh/yr", "curtailed_mwh": "MWh/yr",
    "booked_annual_cost_usd": "USD/yr", "all_emissions_exposure_usd": "USD/yr", "illustrative_annual_value_usd": "USD/yr",
    "price_usd_per_mwh": "USD/MWh", "term_years": "years", "capex_usd_per_acre": "USD/acre",
    "annual_t_co2e_per_acre": "t CO2e/acre/yr", "land_utilization": "fraction",
    "population": "people", "estimated_households": "households", "residential_demand_mwh_per_year": "MWh/yr",
    "average_residential_demand_mw": "MW", "estimated_residential_peak_mw": "MW",
    "outage_hours": "h", "hours_before_shortfall": "h", "outage_start_hour": "hour index PST",
    "critical_load_share": "fraction", "critical_energy_served_share": "fraction",
    "reserve_margin": "fraction", "n_minus_1_coverage": "fraction",
    "current_demand_mwh": "MWh/yr", "projected_demand_mwh": "MWh/yr",
}


def _unit(key):
    if key in UNITS:
        return UNITS[key]
    for suffix, unit in (("_mw", "MW"), ("_mwh", "MWh"), ("_km2", "km2"), ("_acres", "acres"), ("_usd", "USD")):
        if key.endswith(suffix):
            return unit
    return ""


def project_report_rows(result: ScenarioResult):
    p = result.evaluation.extras.get("project", {})
    for section in ("projection", "jobs", "production", "carbon", "contracts", "area", "budget"):
        block = p.get(section, {})
        prov = block.get("provenance", p.get("provenance", {}))
        source = " | ".join(str(v) for v in (prov.get("kind"), prov.get("source"), prov.get("url"), prov.get("note")) if v)
        for key, value in block.items():
            if value is not None and not isinstance(value, (dict, list)):
                yield [section, key, value, _unit(key), source]
        if section == "production":
            for kind, value in block.get("by_kind_mwh", {}).items():
                yield ["production_by_kind", kind, value, "MWh/yr", block.get("basis", source)]
    for key, value in p.get("assumptions", {}).items():
        yield ["project_assumption", key, value if value is not None else "", _unit(key), "Editable screening assumption"]
    demo = p.get("area", {}).get("demographics") or {}
    source = " | ".join(f"{x['kind']}: {x['source']} {x.get('url') or ''} {x.get('note') or ''}" for x in demo.get("provenance", []))
    for key, value in demo.items():
        if value is not None and not isinstance(value, (dict, list)):
            yield ["selected_zone", key, value, _unit(key), source]
    for key, value in demo.get("assumptions", {}).items():
        yield ["zone_assumption", key, value, _unit(key), "Illustrative household/demand assumption"]
    resilience = result.simulation.extras.get("resilience", {})
    for key, value in resilience.items():
        if value is not None and not isinstance(value, (dict, list)):
            yield ["resilience", key, value, _unit(key), resilience.get("basis", "")]
    for warning in p.get("warnings", []):
        yield ["project_warning", "input", warning, "", ""]
