import csv
import io

import pytest
from fastapi.testclient import TestClient

from app.builder.planner import PlanRequest, plan_project
from app.builder.service import list_presets, report_csv
from app.evaluate.project import ProjectOptions
from app.main import app
from app.pipeline import run_scenario

BASE = list_presets()[1]


def test_growth_sizes_larger_plant_without_mutating_current_demand():
    now = plan_project(PlanRequest(scenario=BASE, project=ProjectOptions(projection_years=0)))
    future = plan_project(PlanRequest(scenario=BASE, project=ProjectOptions(projection_years=10, annual_demand_growth=0.05)))
    assert future["scenario"].demand.peak_mw == BASE.demand.peak_mw
    assert future["projection"]["peak_mw"] == pytest.approx(BASE.demand.peak_mw * 1.05 ** 10)
    assert sum(a.capacity_mw for a in future["scenario"].assets) > sum(a.capacity_mw for a in now["scenario"].assets)
    assert future["projection"]["unmet_hours"] == 0
    assert BASE.preset == "hybrid"


def test_offgrid_solar_does_not_claim_feasibility_from_annual_energy():
    sc = BASE.model_copy(deep=True)
    sc.grid.connected = False
    plan = plan_project(PlanRequest(scenario=sc, plant_type="solar_storage", storage_hours=0.5))
    assert plan["projection"]["unmet_hours"] > 0
    assert not plan["screening"]["meets_entered_checks"]
    assert plan["screening"]["needs_utility_study"]
    assert {a.kind for a in plan["scenario"].assets} == {"solar_pv", "battery"}


def test_firm_reserve_is_sized_against_facility_peak_even_for_flat_load():
    plan = plan_project(PlanRequest(scenario=BASE, project=ProjectOptions(projection_years=0)))
    sc = plan["scenario"]
    derated = sc.grid.import_limit_mw + sum(a.capacity_mw * 0.95 for a in sc.assets if a.kind == "gas_cc")
    assert derated >= BASE.demand.peak_mw * 1.15 - 1e-6


def test_budget_and_land_are_real_constraints():
    sc = BASE.model_copy(deep=True)
    sc.site.footprint = {"type": "Polygon", "coordinates": [[[-119.47, 35.4], [-119.469, 35.4], [-119.469, 35.401], [-119.47, 35.401], [-119.47, 35.4]]]}
    plan = plan_project(PlanRequest(scenario=sc, project=ProjectOptions(budget_usd=100)))
    assert any("budget" in x for x in plan["screening"]["issues"])
    assert any("land" in x for x in plan["screening"]["issues"])


@pytest.mark.parametrize("patch", [
    {"project": {"annual_demand_growth": -1}}, {"storage_hours": 0},
    {"project": {"outage_hours": 100000}}, {"plant_type": "coal"},
])
def test_invalid_planning_inputs_return_422(patch):
    payload = {"scenario": BASE.model_dump(), **patch}
    assert TestClient(app).post("/api/projects/plan", json=payload).status_code == 422


def test_zero_demand_returns_clear_validation_error():
    sc = BASE.model_dump()
    sc["demand"]["peak_mw"] = 0
    response = TestClient(app).post("/api/projects/plan", json={"scenario": sc})
    assert response.status_code == 422
    assert "Peak demand" in response.text


def test_exports_carry_jobs_production_contracts_carbon_and_outage_metrics():
    result = run_scenario(BASE)
    rows = list(csv.reader(io.StringIO(report_csv(result))))
    assert all(len(row) == 5 for row in rows)
    lookup = {(r[0], r[1]): r for r in rows[1:]}
    for key, unit in [
        (("jobs", "construction_fte_years"), "FTE-years"),
        (("jobs", "operations_fte"), "FTE/yr"),
        (("production", "gross_generation_mwh"), "MWh/yr"),
        (("carbon", "all_emissions_exposure_usd"), "USD/yr"),
        (("contracts", "annual_volume_mwh"), "MWh/yr"),
        (("resilience", "unserved_critical_mwh"), "MWh"),
    ]:
        assert lookup[key][3] == unit
        assert lookup[key][4]
    assert "no executed contracts" in lookup[("contracts", "status")][2]


def test_weak_wind_site_drops_wind_from_hybrid_and_says_why():
    plan = plan_project(PlanRequest(scenario=BASE))
    kinds = {a.kind for a in plan["scenario"].assets}
    assert "onshore_wind" not in kinds and "solar_pv" in kinds
    notes = plan["screening"]["notes"]
    assert len(notes) == 1 and "Wind left out" in notes[0] and "goes to solar" in notes[0]
    assert notes[0] in plan["screening"]["issues"]  # the planner panel lists screening issues
    assert plan["scenario"].options["sizing"]["renewable_split"] == {"solar_pv": 1.0}
    # The 1 GW campus no longer gets a multi-GW wind farm sized on a ~3% capacity factor.
    assert plan["projection"]["capex_usd"] < 10e9
    assert 30 < plan["projection"]["lcoe_usd_per_mwh"] < 200


def test_sizing_notes_are_not_screening_failures():
    sc = BASE.model_copy(deep=True)
    plan = plan_project(PlanRequest(scenario=sc, project=ProjectOptions(outage_hours=1)))
    failures = [x for x in plan["screening"]["issues"] if x not in plan["screening"]["notes"]]
    assert plan["screening"]["meets_entered_checks"] == (not failures)


def test_windy_site_keeps_the_60_40_hybrid_split(monkeypatch):
    import dataclasses

    import app.builder.planner as planner

    real = planner.prepare

    def windy(scenario, catalog):
        prep = real(scenario, catalog)
        w = prep.drivers.wind_cf
        prep.drivers = dataclasses.replace(prep.drivers, wind_cf=w * (0.40 / float(w.mean())))
        return prep

    monkeypatch.setattr(planner, "prepare", windy)
    plan = plan_project(PlanRequest(scenario=BASE))
    caps = {a.kind: a.capacity_mw for a in plan["scenario"].assets}
    assert {"solar_pv", "onshore_wind"} <= caps.keys()
    assert plan["screening"]["notes"] == []
    assert plan["scenario"].options["sizing"]["renewable_split"] == {"solar_pv": 0.6, "onshore_wind": 0.4}
    # Energy (capacity x CF) splits 60/40: wind at CF 0.40 carries 40% of the target.
    solar_cf = float(real(plan["scenario"].model_copy(update={"assets": []}), planner.get_catalog()).drivers.solar_cf.mean())
    assert caps["solar_pv"] * solar_cf / (caps["onshore_wind"] * 0.40) == pytest.approx(1.5, rel=0.02)


def test_resource_aware_split_moves_a_weak_solar_share_to_wind():
    from types import SimpleNamespace

    from app.builder.planner import resource_aware_split
    typical = {"solar_pv": 0.30, "onshore_wind": 0.45}
    catalog = SimpleNamespace(spec=lambda k: SimpleNamespace(typical_capacity_factor=typical[k]))
    weights = {"solar_pv": 0.6, "onshore_wind": 0.4}
    split, notes = resource_aware_split(weights, {"solar_pv": 0.10, "onshore_wind": 0.40}, catalog)
    assert split == {"onshore_wind": 1.0} and "Solar left out" in notes[0]
    assert resource_aware_split(weights, {"solar_pv": 0.25, "onshore_wind": 0.30}, catalog) == (weights, [])
    kept, both_weak = resource_aware_split(weights, {"solar_pv": 0.05, "onshore_wind": 0.05}, catalog)
    assert kept == weights and "Both solar and wind are weak" in both_weak[0]
