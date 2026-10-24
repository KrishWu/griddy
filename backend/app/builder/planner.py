"""Demand-led plant sizing with a projected-demand hourly feasibility check."""
from __future__ import annotations

import math
from typing import Literal

from pydantic import Field

from app.contract import Asset, Model, Scenario
from app.evaluate.catalog import NUCLEAR_UNIT_MW, get_catalog
from app.evaluate.economics import evaluate
from app.evaluate.project import ProjectOptions
from app.simulate.engine import prepare, simulate
from app.simulate.stress import stress_test


class PlanRequest(Model):
    scenario: Scenario
    plant_type: Literal["solar_storage", "wind_storage", "hybrid", "gas_cc", "gas_ct", "nuclear", "nuclear_smr"] = "hybrid"
    renewable_energy_share: float = Field(default=0.7, ge=0, le=1)
    storage_hours: float = Field(default=4, ge=0.5, le=48)
    reserve_margin: float = Field(default=0.15, ge=0, le=1)
    project: ProjectOptions = Field(default_factory=ProjectOptions)


# A renewable whose site capacity factor is below this fraction of the catalog's typical CF is left out of the
# hybrid mix: meeting its energy share there takes several times the usual capacity (e.g. 8 GW of wind for 1 GW).
WEAK_RESOURCE_FRACTION = 0.5
LABELS = {"solar_pv": "solar", "onshore_wind": "wind"}


def resource_aware_split(weights: dict[str, float], cfs: dict[str, float], catalog) -> tuple[dict[str, float], list[str]]:
    """Drop a weak renewable from the hybrid split and give its share to the usable one; keep the split otherwise."""
    weak = {}
    for kind in weights:
        typical = catalog.spec(kind).typical_capacity_factor
        if typical and cfs[kind] < WEAK_RESOURCE_FRACTION * typical:
            weak[kind] = typical
    usable = [k for k in weights if k not in weak]
    if not weak or not usable:
        if weak:
            return weights, ["Both solar and wind are weak at this site (capacity factor below half the NREL ATB reference); "
                             "the default 60/40 split is kept, so expect a large, costly renewable build."]
        return weights, []
    keep = usable[0]
    notes = [f"{LABELS[k].capitalize()} left out of the hybrid: this site's modelled {LABELS[k]} capacity factor is "
             f"{cfs[k]:.1%}, below half the {typ:.1%} NREL ATB reference, so its {weights[k]:.0%} share of the renewable "
             f"target goes to {LABELS[keep]}." for k, typ in weak.items()]
    return {keep: 1.0}, notes


def plan_project(req: PlanRequest) -> dict:
    sc = req.scenario.model_copy(deep=True)
    if not 0 < sc.demand.peak_mw <= 20000:
        raise ValueError("Peak demand must be greater than zero and at most 20,000 MW.")
    factor = (1 + req.project.annual_demand_growth) ** req.project.projection_years
    if sc.demand.peak_mw * factor > 50000:
        raise ValueError("Projected peak exceeds the 50,000 MW planning limit.")
    sc.preset = None
    names = {"nuclear": "Nuclear project", "nuclear_smr": "Small modular reactor project"}
    sc.name = names.get(req.plant_type, f"{req.plant_type.replace('_', ' ').title()} project")
    sc.options["project"] = req.project.model_dump()
    projected = sc.model_copy(deep=True)
    projected.demand.peak_mw *= factor
    projected.assets = []  # size new assets at the selected site, independent of old asset locations
    catalog = get_catalog()
    prep = prepare(projected, catalog)
    mean = float(prep.drivers.demand_mw.mean())
    peak = max(projected.demand.peak_mw, float(prep.drivers.demand_mw.max()))
    assets = []
    renewable = req.plant_type in ("solar_storage", "wind_storage", "hybrid")
    target = req.renewable_energy_share if renewable else 0
    # Resource-specific CF uses the same cached weather as the simulation, not a fixed CA average.
    weights = {"solar_pv": 1.0} if req.plant_type == "solar_storage" else {"onshore_wind": 1.0}
    if req.plant_type == "hybrid":
        weights = {"solar_pv": 0.6, "onshore_wind": 0.4}
    notes: list[str] = []
    if renewable:
        cfs = {kind: float(getattr(prep.drivers, "solar_cf" if kind == "solar_pv" else "wind_cf").mean()) for kind in weights}
        if req.plant_type == "hybrid":
            weights, notes = resource_aware_split(weights, cfs, catalog)
        for kind, share in weights.items():
            cf = cfs[kind]
            if cf <= 0:
                raise ValueError(f"No usable resource profile for {kind} at this site.")
            assets.append(Asset(id=f"planned-{kind}", kind=kind, capacity_mw=mean * target * share / cf))
        assets.append(Asset(id="planned-battery", kind="battery", capacity_mw=peak * max(target, 0.25), duration_h=req.storage_hours))
    firm_target = peak * (1 + req.reserve_margin)
    if req.plant_type in ("gas_cc", "gas_ct", "hybrid"):
        kind = "gas_ct" if req.plant_type == "gas_ct" else "gas_cc"
        grid = sc.grid.import_limit_mw if sc.grid.connected else 0
        cap = max(0, firm_target - grid) / (0.92 if kind == "gas_ct" else 0.95)
        if cap:
            assets.append(Asset(id=f"planned-{kind}", kind=kind, capacity_mw=cap))
    if req.plant_type in ("nuclear", "nuclear_smr"):
        # Baseload sized so nameplate x availability covers the firm target the grid tie doesn't,
        # rounded up to whole reactors / SMR modules.
        kind = req.plant_type
        grid = sc.grid.import_limit_mw if sc.grid.connected else 0
        need = max(0.0, firm_target - grid) / (catalog.spec(kind).typical_capacity_factor or 0.93)
        unit = NUCLEAR_UNIT_MW[kind]
        if need:
            assets.append(Asset(id=f"planned-{kind}", kind=kind, capacity_mw=math.ceil(need / unit - 1e-9) * unit))
    sc.assets = assets
    projected.assets = [a.model_copy(deep=True) for a in assets]
    sim = simulate(projected, catalog)
    evaluation = evaluate(projected, sim, catalog)
    findings = stress_test(projected, sim)
    land = evaluation.extras["project"]["area"]
    budget = evaluation.extras["project"]["budget"]
    failures = []
    if sim.summary.hours_unmet:
        failures.append(f"Projected demand is unmet in {sim.summary.hours_unmet:,} hours.")
    if budget["within_budget"] is False:
        failures.append("Estimated capital cost exceeds the entered budget.")
    if land["land_utilization"] is not None and land["land_utilization"] > 1:
        failures.append("Estimated project land exceeds the selected footprint.")
    if sim.extras["resilience"]["unserved_critical_mwh"] > 0.01:
        failures.append("The design does not sustain the requested grid outage.")
    if any(f.severity == "fail" for f in findings):
        failures.append("Hourly stress screening contains failing findings.")
    sc.options["sizing"] = {"plant_type": req.plant_type, "projected_peak_mw": projected.demand.peak_mw,
        "renewable_split": weights if renewable else {}, "notes": notes,
        "basis": "Capacity sized for compound demand growth; renewable share is a gross energy sizing target before curtailment and storage losses. A heuristic candidate, not a least-cost optimum or a certified design."}
    return {"scenario": sc, "projection": {"years": req.project.projection_years,
        "peak_mw": projected.demand.peak_mw, "demand_mwh": sim.summary.demand_mwh,
        "unmet_hours": sim.summary.hours_unmet, "unmet_mwh": sim.summary.unmet_mwh,
        "capex_usd": evaluation.economics.capex_total_usd,
        "annual_opex_usd": evaluation.economics.annual_opex_usd,
        "lcoe_usd_per_mwh": evaluation.economics.lcoe_usd_per_mwh,
        "annual_t_co2e": evaluation.emissions.annual_t_co2e,
        "resilience": sim.extras["resilience"]},
        # Sizing notes are listed with the issues (the planner panel shows that list) but are not failures.
        "screening": {"meets_entered_checks": not failures, "issues": notes + failures, "notes": notes,
            "needs_utility_study": True, "basis": sc.options["sizing"]["basis"]},
        "findings": [f.model_dump() for f in findings]}
