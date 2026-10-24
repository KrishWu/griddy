"""Solar + battery sizing search (POST /api/household/solar/optimize)."""

import json
import time

import pytest
from fastapi.testclient import TestClient

from app.household.models import HouseholdRequest, SolarOptimizeRequest
from app.household.optimize import MAX_KW, optimize_solar
from app.household.service import plan
from app.main import app

TYPICAL = {"zip": "94301", "monthly_kwh": 550, "rate_plan": "E-TOU-C", "owns_home": True, "roof_kw_max": 8}


def run(household=None, **kw):
    return optimize_solar(SolarOptimizeRequest(household=HouseholdRequest(**(household or TYPICAL)), **kw))


def test_typical_pge_home_finds_a_positive_npv_size_quickly():
    t = time.perf_counter()
    r = run()
    assert time.perf_counter() - t < 1.0
    assert r.applicable
    assert r.npv_usd > 0 and 1.0 <= r.solar_kw <= 8
    assert r.battery_kwh in (0, 5, 10, 13.5, 15)
    assert r.npv_usd == max(c.npv_usd for c in r.candidates)
    assert 0 < r.offset_share <= 1.5 + 1e-9
    assert r.payback_years is not None and 0 < r.payback_years < 25
    assert r.reason and r.provenance and all(p.source for p in r.provenance)


def test_matches_the_solar_tab_npv_for_the_chosen_size():
    r = run()
    whatif = {"solar_kw": r.solar_kw, "battery_kwh": r.battery_kwh}
    solar = plan(HouseholdRequest(**TYPICAL, whatif=whatif)).solar
    assert solar.npv_usd == pytest.approx(r.npv_usd, abs=1)
    assert solar.annual_savings_usd == pytest.approx(r.annual_savings_usd, abs=0.01)


@pytest.mark.parametrize("roof", [2.0, 4.0, 6.5])
def test_respects_roof_cap(roof):
    r = run(roof_kw_max=roof)
    assert r.solar_kw <= roof
    assert all(c.solar_kw <= roof for c in r.candidates)
    if roof == 2.0:  # below the demand cap, so the roof sets the top of the search
        assert max(c.solar_kw for c in r.candidates) == 2.0
    if r.solar_kw == roof:
        assert "roof" in r.binding


def test_household_roof_is_used_when_request_has_none_and_request_wins():
    assert max(c.solar_kw for c in run({**TYPICAL, "roof_kw_max": 3}).candidates) == 3
    assert max(c.solar_kw for c in run({**TYPICAL, "roof_kw_max": 3}, roof_kw_max=2).candidates) == 2


@pytest.mark.parametrize("budget", [6000, 15000])
def test_respects_budget(budget):
    free = run()
    r = run(budget_usd=budget)
    assert r.upfront_cost_usd <= budget
    for c in r.candidates:
        assert c.feasible == (c.upfront_cost_usd <= budget + 0.5)
    assert r.npv_usd == max(c.npv_usd for c in r.candidates if c.feasible)
    if free.upfront_cost_usd > budget:
        assert "budget" in r.binding


def test_budget_below_every_option_says_so():
    r = run(budget_usd=100)
    assert r.applicable and "budget" in r.binding
    assert not any(c.feasible for c in r.candidates)
    assert "budget" in r.reason


def test_never_exceeds_15_kw_even_for_a_big_home_with_a_big_roof():
    r = run({**TYPICAL, "monthly_kwh": 3000, "roof_kw_max": 50}, roof_kw_max=50)
    assert r.solar_kw <= MAX_KW
    assert max(c.solar_kw for c in r.candidates) == MAX_KW


def test_demand_cap_limits_a_small_home():
    r = run({**TYPICAL, "monthly_kwh": 150, "roof_kw_max": 12})
    # 1.5 x 1,800 kWh / ~1,600 kWh per kW: no point covering a big roof under the Net Billing Tariff.
    assert max(c.solar_kw for c in r.candidates) <= 2.0


def test_no_battery_option_searches_solar_only():
    r = run(include_battery=False)
    assert r.battery_kwh == 0 and all(c.battery_kwh == 0 for c in r.candidates)


def test_renters_are_not_applicable():
    r = run({**TYPICAL, "owns_home": False})
    assert not r.applicable and r.candidates == [] and "renter" in r.reason


def test_existing_solar_counts_against_the_roof():
    r = run({**TYPICAL, "has_solar": True, "existing_solar_kw": 3, "roof_kw_max": 5})
    assert max(c.solar_kw for c in r.candidates) <= 2
    assert "existing 3 kW" in r.reason
    full = run({**TYPICAL, "has_solar": True, "existing_solar_kw": 5, "roof_kw_max": 5})
    assert not full.applicable and "roof" in full.reason


def test_endpoint_is_json_safe():
    for body in ({"household": TYPICAL}, {"household": TYPICAL, "budget_usd": 15000, "roof_kw_max": 4},
                 {"household": {**TYPICAL, "owns_home": False}}, {"household": {"zip": "99999"}}):
        resp = TestClient(app).post("/api/household/solar/optimize", json=body)
        assert resp.status_code == 200
        data = resp.json()
        json.dumps(data, allow_nan=False)
        assert set(data) >= {"applicable", "solar_kw", "battery_kwh", "upfront_cost_usd", "annual_savings_usd", "payback_years",
                             "npv_usd", "annual_production_kwh", "offset_share", "binding", "reason", "candidates", "provenance"}
        assert set(data["binding"]) <= {"roof", "budget", "demand"}


def test_invalid_inputs_return_422():
    client = TestClient(app)
    assert client.post("/api/household/solar/optimize", json={"household": TYPICAL, "budget_usd": -1}).status_code == 422
    assert client.post("/api/household/solar/optimize", json={"household": TYPICAL, "roof_kw_max": 99}).status_code == 422
