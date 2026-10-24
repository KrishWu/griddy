import numpy as np
import pytest

from app.household.data import calendar
from app.household.models import HouseholdRequest
from app.household.service import plan
from app.household.solar import savings_path


def home(**kwargs):
    return plan(HouseholdRequest(lat=36.75, lon=-119.78, utility="pge", monthly_kwh=600,
        cooling={"has_ac": True}, whatif={"solar_kw": 5}, **kwargs))


def test_time_view_preserves_annual_totals_and_closes_energy_carbon_balance():
    r = home()
    v = r.time_view
    assert sum(v["load_kwh"]) * v["days"] == pytest.approx(r.usage.annual_kwh, abs=0.1)
    assert sum(v["carbon_kg"]) * v["days"] == pytest.approx(r.carbon.annual_kg_hourly, abs=0.1)
    assert sum(v["solar_kwh"]) * v["days"] == pytest.approx(r.solar.annual_production_kwh, abs=0.1)
    summer, winter = home(view_month=7, view_day_type="weekday"), home(view_month=1, view_day_type="weekend")
    assert summer.bill.annual_usd == winter.bill.annual_usd == r.bill.annual_usd
    assert summer.time_view["load_kwh"] != winter.time_view["load_kwh"]
    assert sum(summer.time_view["solar_kwh"]) > sum(winter.time_view["solar_kwh"])
    assert summer.time_view["intensity_kg_per_kwh"] != winter.time_view["intensity_kg_per_kwh"]
    assert summer.time_view["retail_rate_usd_per_kwh"][17] > winter.time_view["retail_rate_usd_per_kwh"][17]


def test_time_mask_uses_local_clock_and_rejects_invalid_controls():
    r = home(view_month=7, view_day_type="weekday", view_hour=18)
    cal = calendar()
    mask = (cal.month_h == 6) & (cal.weekend_h == 0)
    assert r.time_view["days"] == np.count_nonzero(mask) // 24
    assert r.time_view["hour"] == 18
    assert len(r.time_view["carbon_kg"]) == 24
    assert r.time_view["solar_kwh"][0] == 0
    for value in ({"view_month": 13}, {"view_hour": 24}, {"view_day_type": "holiday"}):
        with pytest.raises(ValueError):
            HouseholdRequest(**value)


def test_location_changes_climate_and_pv_but_respects_entered_energy():
    inland = home()
    coast = plan(HouseholdRequest(lat=37.77, lon=-122.42, utility="pge", monthly_kwh=600,
        cooling={"has_ac": True}, whatif={"solar_kw": 5}))
    assert inland.location.solar_profile_city != coast.location.solar_profile_city
    assert inland.solar.annual_production_kwh != coast.solar.annual_production_kwh
    assert inland.usage.annual_kwh == coast.usage.annual_kwh == pytest.approx(7200)
    assert inland.usage.by_end_use_kwh["cooling"] > coast.usage.by_end_use_kwh["cooling"]
    assert "not rooftop-specific" in inland.location.note


def test_roof_limit_caps_solar_candidate():
    r = home(roof_kw_max=2)
    assert r.solar.kw == 2
    assert any("roof capacity" in w for w in r.warnings)


def test_projection_does_not_escalate_export_credits_or_extend_bonus():
    path = savings_path(100, export_credit=40, bonus_credit=10, years=10, escalation=.1, degradation=0)
    assert path[0] == 100
    assert path[1] == pytest.approx(60 * 1.1 + 40)
    assert path[9] == pytest.approx(60 * 1.1 ** 9 + 30)


def test_new_battery_replacement_reduces_cumulative_cashflow_after_rated_life():
    req = HouseholdRequest(lat=36.75, lon=-119.78, monthly_kwh=600, whatif={"solar_kw": 5, "battery_kwh": 10, "years": 20})
    r = plan(req)
    assumptions = {x.key: x.value for x in r.assumptions}
    life = int(float(assumptions["battery_life_years"].split()[0]))
    annual_saving = r.projection.baseline_usd[life] - r.projection.with_solar_usd[life]
    cash_change = r.projection.cumulative_savings_usd[life] - r.projection.cumulative_savings_usd[life - 1]
    assert cash_change < annual_saving - 1000  # replacement is a real cost, not just a note
