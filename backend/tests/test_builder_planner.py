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
