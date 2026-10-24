"""Physical carbon ledger: annual operations and one-time construction stay separate.

Reference footprints are attached to installed capacity, never to actual dispatch:
cloudy weather, curtailment or idling must not erase manufacturing emissions.
All carbon-price outputs are sensitivities, not additional cash-flow entries.
"""
from __future__ import annotations

import json
import math
from functools import lru_cache

from app import DATA_DIR
from app.contract import Catalog, Economics, Emissions, Scenario
from app.evaluate.catalog import BATTERY_REF_HOURS, asset_params, atb_data


@lru_cache(maxsize=1)
def upfront_factors() -> dict:
    return json.loads((DATA_DIR / "evaluate" / "upfront_carbon.json").read_text())


def carbon_ledger(scenario: Scenario, catalog: Catalog, economics: Economics,
                  emissions: Emissions, assumptions) -> dict:
    refs = upfront_factors()
    ilr = atb_data()["techs"]["solar_pv"]["pv_ilr"]["value"]
    factors = {
        "solar_pv": assumptions.solar_upfront_kg_per_kwdc,
        "onshore_wind": assumptions.wind_upfront_kg_per_kw,
        "battery": assumptions.battery_upfront_kg_per_kwh,
    }
    years = scenario.assumptions.analysis_years
    price = max(0, scenario.assumptions.carbon_price_usd_per_t)
    assets, unmodeled = [], []
    for asset in scenario.assets:
        if asset.capacity_mw <= 0:
            continue
        if asset.kind not in refs:
            unmodeled.append(asset.id)
            continue
        ref = refs[asset.kind]
        quantity = asset.capacity_mw
        unit = "MW"
        if asset.kind == "solar_pv":
            quantity *= ilr
            unit = "MWdc"
        elif asset.kind == "battery":
            quantity *= BATTERY_REF_HOURS if asset.duration_h is None else asset.duration_h
            unit = "MWh capacity"
        # MW × kg/kW == t; MWh × kg/kWh == t. No extra factor of 1,000.
        factor = factors[asset.kind]
        upfront = quantity * factor
        life = asset_params(asset, catalog)["lifetime_years"]
        replacements = max(0, math.ceil(years / life) - 1) if years > 0 else 0
        custom = factor != ref["factor"]
        assets.append({
            "asset_id": asset.id, "kind": asset.kind, "quantity": quantity, "quantity_unit": unit,
            "factor": factor, "factor_unit": ref["unit"], "upfront_t_co2e": upfront,
            "replacement_count": replacements, "replacement_t_co2e": upfront * replacements,
            "provenance": {"kind": "assumption", "source": "User-edited upfront carbon factor" if custom else ref["source"],
                "url": ref["url"], "note": ("User factor replaces the reference. Reference basis: " if custom else "") + ref["basis"]},
        })
    upfront = sum(row["upfront_t_co2e"] for row in assets) + assumptions.other_upfront_t_co2e
    replacements = sum(row["replacement_t_co2e"] for row in assets)
    source = emissions.by_source_t_co2e
    direct = sum(source.get(k, 0) for k in ("gas_cc", "gas_ct"))
    imports = source.get("grid_imports", 0)
    upstream = source.get("upstream_methane", 0)
    total = upfront + replacements + emissions.annual_t_co2e * years
    basis = (
        "Annual operations = on-site gas combustion + hourly grid imports + optional upstream methane. "
        "Solar, wind and storage have zero modeled direct operating emissions; grid charging and backup supply are counted. "
        "Upfront carbon = installed capacity × editable reference footprint + other entered construction carbon. "
        "Cumulative modeled carbon = upfront + same-factor equipment replacements before the horizon + annual operations × analysis years. "
        "Repeats the simulated year: no forecast grid decarbonization, degradation, or physical-carbon discounting. "
        "This is a partial inventory: gas-plant construction, new grid lines/substations, site works, maintenance and end of life "
        "are not automatically estimated; use other upfront carbon for additional known construction emissions. "
        "Carbon exposure = modeled tonnes × entered price; no allowance obligation or additional CAPEX/OPEX is implied."
    )
    return {
        "annual_operational_t_co2e": emissions.annual_t_co2e,
        "annual_direct_t_co2e": direct, "annual_imports_t_co2e": imports,
        "annual_upstream_t_co2e": upstream,
        "upfront_t_co2e": upfront, "other_upfront_t_co2e": assumptions.other_upfront_t_co2e,
        "replacement_t_co2e": replacements, "analysis_years": years, "modeled_total_t_co2e": total,
        "carbon_price_usd_per_t": price, "upfront_exposure_usd": upfront * price,
        "modeled_total_exposure_usd": total * price,
        "booked_annual_cost_usd": sum(line.usd for line in economics.lines if line.category == "carbon"),
        "all_emissions_exposure_usd": emissions.annual_t_co2e * price,
        "assets": assets, "unmodeled_asset_ids": unmodeled, "inventory_complete": False, "basis": basis,
        "provenance": {"kind": "assumption", "source": "Griddy partial construction-carbon inventory and repeated design-year operations",
            "url": "https://data.nlr.gov/submissions/171", "note": basis},
    }
