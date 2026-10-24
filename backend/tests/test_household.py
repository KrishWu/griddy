"""Griddy Home (household planner): math invariants on small synthetic fixtures + end-to-end ranges.

Assert invariants and ranges, not exact dollars: the tariff / assumption data keeps moving.
"""

from __future__ import annotations

import datetime as dt
import json
import math

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.household import tariffs as tar
from app.household.carbon import hourly_kg, intensity_kg_per_kwh
from app.household.data import HOURS, Ctx, calendar
from app.household.load import build_load, ev_block, parse_green_button, shift
from app.household.models import HouseholdRequest
from app.household.service import plan
from app.household.solar import dispatch, npv
from app.household.whatif import edited_load
from app.main import app

client = TestClient(app)
RNG = np.random.default_rng(7)


def toy_plan(fixed: float = 10.0) -> tar.Plan:
    """Two seasons, peak 4-9 pm every day; summer Jun-Sep."""
    wk = ["off_peak"] * 16 + ["peak"] * 5 + ["off_peak"] * 3
    periods = {s: {"weekday": list(wk), "weekend": list(wk)} for s in ("summer", "winter")}
    rates = {"summer": {"peak": 0.50, "off_peak": 0.30}, "winter": {"peak": 0.40, "off_peak": 0.25}}
    sbm = ["winter"] * 5 + ["summer"] * 4 + ["winter"] * 3
    return tar.Plan(id="TOY", label="toy", utility="pge", season_by_month=sbm, periods=periods, rates=rates, fixed_usd_per_month=fixed)


def req(**kw) -> HouseholdRequest:
    base = {"utility": "pge", "rate_plan": "E-TOU-C", "has_solar": False, "has_battery": False}
    base.update(kw)
    return HouseholdRequest(**base)


def finite_json(d) -> None:
    json.dumps(d, allow_nan=False)  # raises on NaN / inf


# ---------------------------------------------------------------------------
# Calendar
# ---------------------------------------------------------------------------


def test_calendar_2024():
    cal = calendar()
    assert cal.hod.size == HOURS == 8784
    assert cal.weekend_h[:24].sum() == 0  # 2024-01-01 is a Monday
    assert cal.weekend_h[5 * 24] == 1  # Saturday Jan 6
    assert cal.days_in_month.sum() == 366 and cal.days_in_month[1] == 29
    # local clock = PST + 1 on summer days
    assert cal.local_hod[200 * 24] == 1 and cal.local_hod[10 * 24] == 0


# ---------------------------------------------------------------------------
# Bills
# ---------------------------------------------------------------------------


def test_bill_is_sum_of_kwh_times_rate_by_period():
    p = toy_plan(fixed=10.0)
    cal = calendar()
    load = RNG.uniform(0.2, 2.0, HOURS)
    summer = np.isin(cal.month_h, [5, 6, 7, 8])
    peak = (cal.local_hod >= 16) & (cal.local_hod < 21)
    rate = np.where(summer, np.where(peak, 0.50, 0.30), np.where(peak, 0.40, 0.25))
    b = tar.compute_bill(p, load)
    assert b.energy_usd == pytest.approx(float(load @ rate), rel=1e-12)
    assert b.fixed_usd == pytest.approx(120.0)
    assert b.annual_usd == pytest.approx(float(load @ rate) + 120.0, rel=1e-12)
    assert sum(r["kwh"] for r in b.by_period) == pytest.approx(load.sum(), rel=1e-12)
    assert sum(r["usd"] for r in b.by_period) == pytest.approx(b.energy_usd, rel=1e-12)
    assert b.monthly_usd.sum() == pytest.approx(b.annual_usd, rel=1e-12)


def test_flat_custom_rate_bill():
    p = tar.flat_plan(0.36, "custom", "test")
    load = np.full(HOURS, 0.5)
    assert tar.compute_bill(p, load).annual_usd == pytest.approx(0.36 * 0.5 * HOURS)


def test_nbt_exports_credited_at_export_rate_not_retail():
    p = toy_plan(fixed=0.0)
    load = np.full(HOURS, 1.0)
    export = np.zeros(HOURS)
    export[12::24] = 2.0  # noon exports
    export_rate = np.full(HOURS, 0.07)
    b = tar.compute_bill(p, load, export, export_rate)
    retail = tar.compute_bill(p, load)
    assert b.export_credit_usd == pytest.approx(float(export @ export_rate))
    assert b.annual_usd == pytest.approx(retail.annual_usd - float(export @ export_rate))
    # crediting at retail would have been much larger
    assert float(export @ p.tables()[0]) > 3 * b.export_credit_usd


def test_nbt_credit_never_cashes_out():
    p = toy_plan(fixed=5.0)
    load = np.full(HOURS, 0.1)
    export = np.full(HOURS, 5.0)
    b = tar.compute_bill(p, load, export, np.full(HOURS, 0.1))
    assert b.energy_usd == pytest.approx(0.0)
    assert b.annual_usd == pytest.approx(60.0)  # fixed charges still apply


# ---------------------------------------------------------------------------
# Load model + timing shifts
# ---------------------------------------------------------------------------


def test_ev_block_conserves_daily_energy_and_wraps():
    p = ev_block(10.0, 7.2, 23)
    assert p.sum() == pytest.approx(10.0)
    assert p[23] == pytest.approx(7.2) and p[0] == pytest.approx(2.8)


def test_timing_shifts_preserve_total_kwh_exactly():
    ctx = Ctx()
    r = req(monthly_kwh=700, ev={"has_ev": True, "miles_per_day": 40, "charge_start_hour": 18}, laundry_hour=19, dishwasher_hour=20)
    lm = build_load(r, ctx, "san_jose")
    base = lm.total()
    for kw in ({"ev_start": 0}, {"ev_start": 11}, {"laundry_hour": 10}, {"dishwasher_hour": 2},
               {"ev_start": 23, "laundry_hour": 7, "dishwasher_hour": 23}):
        t, timing = edited_load(lm, ctx, **kw)
        assert timing
        assert abs(float(t.sum()) - float(base.sum())) < 1e-9 * base.sum()
        assert not np.allclose(t, base)
    arr = RNG.uniform(0, 1, HOURS)
    for h in (1, 5, -3, 23):
        s = shift(arr, h)
        assert np.allclose(np.sort(s.reshape(366, 24), axis=1), np.sort(arr.reshape(366, 24), axis=1))


def test_monthly_kwh_matches_user_totals():
    ctx = Ctx()
    months = [500, 450, 420, 380, 400, 600, 800, 820, 700, 450, 430, 520]
    lm = build_load(req(monthly_kwh=months, ev={"has_ev": True, "miles_per_day": 30}), ctx, "san_jose")
    got = np.bincount(calendar().month_h, weights=lm.total(), minlength=12)
    assert np.allclose(got, months, rtol=1e-9)
    assert lm.source == "simulated_from_monthly"
    assert all(v.min() >= 0 for v in lm.components.values())


def test_setpoint_change_uses_cooling_assumption():
    ctx = Ctx()
    lm = build_load(req(monthly_kwh=700, cooling={"has_ac": True}), ctx, "fresno")
    t, timing = edited_load(lm, ctx, ac_delta_f=2.0)
    pct = float(ctx.a("cooling_pct_change_per_degF")) / 100
    assert not timing
    assert lm.total().sum() - t.sum() == pytest.approx(lm.components["cooling"].sum() * pct * 2, rel=1e-9)


# ---------------------------------------------------------------------------
# PV + battery
# ---------------------------------------------------------------------------


def test_pv_self_consumed_plus_exported_equals_production():
    cal = calendar()
    load = RNG.uniform(0.3, 1.5, HOURS)
    pv = np.where((cal.hod >= 7) & (cal.hod <= 17), RNG.uniform(0, 4, HOURS), 0.0)
    for batt in (0.0, 10.0):
        fl = dispatch(load, pv, batt, 4.0, 0.85, (cal.hod >= 16) & (cal.hod < 21))
        assert fl.self_consumed_kwh + fl.export.sum() == pytest.approx(pv.sum(), rel=1e-12)
        assert np.allclose(fl.grid_import + fl.direct + fl.discharge, load)
        assert fl.grid_import.min() >= -1e-12 and fl.export.min() >= -1e-12


def test_battery_discharge_at_most_charge_times_rte():
    cal = calendar()
    load = np.full(HOURS, 1.0)
    pv = np.where((cal.hod >= 9) & (cal.hod <= 15), 3.0, 0.0)
    fl = dispatch(load, pv, 10.0, 4.0, 0.85, (cal.hod >= 16) & (cal.hod < 21))
    assert fl.discharge.sum() > 0
    assert fl.discharge.sum() <= fl.charge.sum() * 0.85 + 1e-9
    assert fl.discharge.max() <= 4.0 + 1e-12 and fl.charge.max() <= 4.0 + 1e-12
    hi = (cal.hod >= 16) & (cal.hod < 21)
    assert fl.discharge[~hi].sum() == 0  # only in peak hours


def test_npv_matches_explicit_sum():
    up, s, n, r, e, d = 20000.0, 1500.0, 25, 0.05, 0.04, 0.005
    explicit = -up + sum(s * ((1 + e) * (1 - d)) ** (t - 1) / (1 + r) ** t for t in range(1, n + 1))
    assert npv(up, s, n, r, e, d) == pytest.approx(explicit, rel=1e-10)


# ---------------------------------------------------------------------------
# Carbon
# ---------------------------------------------------------------------------


def test_carbon_is_sum_kwh_times_intensity():
    load = RNG.uniform(0, 2, HOURS)
    inten = intensity_kg_per_kwh()[0]
    assert hourly_kg(load) == pytest.approx(float(np.sum(load * inten)), rel=1e-12)
    assert 0.05 < inten.mean() < 0.4


# ---------------------------------------------------------------------------
# Green Button parsing
# ---------------------------------------------------------------------------


def _green_button(minutes: int, days: int = 400, value_per_hour=lambda d, h: 0.5 + 0.1 * h) -> str:
    lines = ["Name,Test Person", 'Address,"1 Main St, San Jose CA"', "Account Number,0000", "", "TYPE,DATE,START TIME,END TIME,USAGE (kWh),COST,NOTES"]
    d0 = dt.date(2025, 1, 1)
    n = 60 // minutes
    for i in range(days):
        d = d0 + dt.timedelta(days=i)
        for h in range(24):
            for q in range(n):
                m0 = q * minutes
                v = value_per_hour(d, h) / n
                lines.append(f"Electric usage,{d.isoformat()},{h:02d}:{m0:02d},{h:02d}:{m0 + minutes - 1:02d},{v:.5f},$0.10,")
    return "\n".join(lines)


@pytest.mark.parametrize("minutes", [60, 15])
def test_green_button_hourly_and_15min(minutes):
    res = parse_green_button(_green_button(minutes))
    m = np.asarray(res["matrix_kwh"])
    assert m.shape == (12, 2, 24)
    assert res["interval_minutes"] == minutes
    assert res["days"] == 400
    assert np.allclose(m[0, 0], [0.5 + 0.1 * h for h in range(24)], atol=1e-3)
    assert res["annual_kwh_estimate"] == pytest.approx(366 * sum(0.5 + 0.1 * h for h in range(24)), rel=1e-3)


def test_green_button_other_column_order_and_gaps():
    lines = ["Some utility export", "DATE,USAGE (kWh),START TIME,TYPE"]
    for i in range(31):  # January only
        d = dt.date(2025, 1, 1) + dt.timedelta(days=i)
        for h in range(24):
            lines.append(f"{d.strftime('%m/%d/%Y')},1.0,{h:02d}:00,Electric usage")
    lines.append("01/05/2025,2.0,00:00,Natural gas usage")
    res = parse_green_button("\n".join(lines))
    m = np.asarray(res["matrix_kwh"])
    assert np.allclose(m, 1.0)  # other months filled from January
    assert any("No data for" in w for w in res["warnings"])
    assert any("natural-gas" in w for w in res["warnings"])


def test_green_button_garbage_warns():
    res = parse_green_button("hello,world\n1,2")
    assert res["days"] == 0 and res["warnings"]


# ---------------------------------------------------------------------------
# End to end
# ---------------------------------------------------------------------------


def test_options_endpoint():
    r = client.get("/api/household/options")
    assert r.status_code == 200
    d = r.json()
    assert d["default_plan"] == "E-TOU-C"
    assert {"pge", "pge_svce", "sce"} <= {u["id"] for u in d["utilities"]}
    assert d["solar_profile_cities"]


def _post(body: dict) -> dict:
    r = client.post("/api/household/plan", json=body)
    assert r.status_code == 200, r.text
    d = r.json()
    finite_json(d)
    return d


def test_pge_600_kwh_etouc_ranges():
    d = _post({"zip": "95112", "utility": "pge", "rate_plan": "E-TOU-C", "monthly_kwh": 600, "has_solar": False, "has_battery": False})
    assert d["usage"]["annual_kwh"] == pytest.approx(7200, rel=1e-6)
    assert 2000 <= d["bill"]["annual_usd"] <= 3500
    assert 0.30 <= d["bill"]["effective_usd_per_kwh"] <= 0.60
    assert 0.1 <= d["carbon"]["annual_kg_hourly"] / d["usage"]["annual_kwh"] <= 0.3
    assert d["load_source"] == "simulated_from_monthly"
    assert d["solar"] is None
    assert len(d["usage"]["avg_day_kwh"]["summer"]) == 24 and len(d["bill"]["periods_by_hour"]["summer"]) == 24
    assert {p["plan"] for p in d["bill"]["plan_comparison"]} >= {"E-TOU-C", "E-TOU-D"}
    for s in d["whatif"]["scenarios"]:
        if s["preserves_total_kwh"] and not s["id"].startswith("solar"):
            assert abs(s["annual_kwh_change"]) < 1e-3
    assert d["assumptions"] and all(a["provenance"]["source"] for a in d["assumptions"])


def test_svce_ev_evening_charging():
    d = _post({"zip": "94086", "utility": "pge_svce", "rate_plan": "unknown", "monthly_kwh": 650, "has_solar": False, "has_battery": False,
               "ev": {"has_ev": True, "miles_per_day": 30, "charge_start_hour": 18}})
    assert d["bill"]["plan"] == "E-TOU-C"
    assert "SVCE" in d["sources"]["provider"]
    assert d["usage"]["by_end_use_kwh"]["ev"] > 2000
    ids = {s["id"]: s for s in d["whatif"]["scenarios"]}
    assert ids["ev_midnight"]["annual_usd_saved"] > 0 and ids["ev_midnight"]["preserves_total_kwh"]
    assert ids["ev_midday"]["annual_kg_saved"] > ids["ev_midnight"]["annual_kg_saved"]  # midday is cleaner
    assert any(r["id"] == "svce_greenprime" for r in d["recommendations"])


def test_interval_matrix_input():
    mat = [[[0.4 + 0.05 * h for h in range(24)] for _ in range(2)] for _ in range(12)]
    d = _post({"utility": "pge", "rate_plan": "E-TOU-D", "interval_matrix_kwh": mat, "has_solar": False, "has_battery": False})
    assert d["load_source"] == "interval_data"
    assert d["usage"]["annual_kwh"] == pytest.approx(366 * sum(0.4 + 0.05 * h for h in range(24)), rel=1e-6)
    bad = _post({"utility": "pge", "rate_plan": "E-TOU-C", "interval_matrix_kwh": [[[1.0]]], "monthly_kwh": 500,
                 "has_solar": False, "has_battery": False})
    assert bad["load_source"] == "simulated_from_monthly"
    assert any("interval_matrix_kwh" in w for w in bad["warnings"])


def test_solar_and_battery():
    d = _post({"zip": "95008", "utility": "pge", "rate_plan": "E-TOU-C", "monthly_kwh": 600, "has_solar": False, "has_battery": False,
               "owns_home": True, "whatif": {"solar_kw": 6, "battery_kwh": 10, "years": 25}})
    s = d["solar"]
    assert s and s["applicable"]
    assert s["self_consumed_kwh"] + s["exported_kwh"] == pytest.approx(s["annual_production_kwh"], abs=0.2)
    assert 1100 * 6 <= s["annual_production_kwh"] <= 1900 * 6
    assert s["battery_discharge_kwh"] > 0
    assert s["annual_savings_usd"] > 0 and s["bill_after_usd"] < s["bill_before_usd"]
    assert s["payback_years"] is None or 3 <= s["payback_years"] <= 40
    assert s["upfront_cost_usd"] > 0
    p = d["projection"]
    assert len(p["years"]) == 25 and p["with_solar_usd"] is not None
    assert p["cumulative_savings_usd"][0] < 0  # upfront cost first


def test_renter_solar_not_applicable():
    d = _post({"zip": "94110", "utility": "pge", "rate_plan": "E-TOU-C", "monthly_kwh": 350, "has_solar": False, "has_battery": False,
               "owns_home": False, "whatif": {"solar_kw": 5}})
    assert d["solar"] is not None and d["solar"]["applicable"] is False
    assert all(not s["applicable"] for s in d["whatif"]["scenarios"] if s["id"].startswith("solar"))
    assert d["whatif"]["combined"]["annual_usd_saved"] == pytest.approx(0, abs=0.01)
    assert any(r["id"] == "renter_green_power" for r in d["recommendations"])


def test_sce_custom_rate():
    d = _post({"zip": "90012", "utility": "sce", "rate_plan": "unknown", "custom_rate_usd_per_kwh": 0.36, "monthly_kwh": 500,
               "has_solar": False, "has_battery": False})
    assert d["bill"]["plan"] == "custom"
    assert d["bill"]["annual_usd"] == pytest.approx(0.36 * 6000, rel=1e-6)
    d2 = _post({"utility": "sce", "rate_plan": "unknown", "monthly_kwh": 500, "has_solar": False, "has_battery": False})
    assert any("not loaded" in w for w in d2["bill"]["warnings"])


def test_benchmark_and_existing_solar():
    d = _post({"utility": "pge", "rate_plan": "E-ELEC", "has_solar": True, "has_battery": False, "occupants": 4,
               "electric_heating": True, "cooling": {"has_ac": True, "setpoint_f": 76}})
    assert d["load_source"] == "simulated_from_benchmark"
    assert d["solar"] is not None and d["solar"]["upfront_cost_usd"] == 0 and d["solar"]["payback_years"] is None
    assert any("no size was given" in w for w in d["warnings"])


def test_missing_tariff_data_falls_back_with_warning(monkeypatch):
    monkeypatch.setattr(tar, "pge_plans", lambda: ({}, ("PG&E tariff file (data/household/tariffs_pge.json) not loaded.",)))
    monkeypatch.setattr(tar, "svce_plans", lambda: {})
    res = plan(req(monthly_kwh=600)).model_dump()
    finite_json(res)
    assert res["bill"]["plan"] == "custom"
    assert any("not loaded" in w for w in res["warnings"] + res["bill"]["warnings"])


def test_plan_is_fast():
    import time

    body = {"zip": "94086", "utility": "pge_svce", "rate_plan": "EV2-A", "monthly_kwh": [600] * 12, "has_solar": True,
            "existing_solar_kw": 5, "has_battery": True, "existing_battery_kwh": 13.5, "ev": {"has_ev": True, "miles_per_day": 40},
            "cooling": {"has_ac": True}, "owns_home": True, "whatif": {"solar_kw": 3, "battery_kwh": 5, "ev_charge_start_hour": 1}}
    _post(body)  # warm caches
    t0 = time.perf_counter()
    for _ in range(3):
        _post(body)
    assert (time.perf_counter() - t0) / 3 < 0.5  # target < 150 ms; generous for CI
    assert math.isfinite(1.0)


def test_map_pin_lat_lon_wins_over_zip_and_sets_profile_and_climate():
    base = {"utility": "pge", "rate_plan": "E-TOU-C", "monthly_kwh": 600, "has_solar": False, "has_battery": False,
            "cooling": {"has_ac": True}}
    # Typed ZIP is San Francisco (coastal) but the pin is in Fresno (inland): the pin wins.
    pin = _post({**base, "zip": "94103", "lat": 36.75, "lon": -119.78})
    assert pin["location"]["lat"] == pytest.approx(36.75) and pin["location"]["lon"] == pytest.approx(-119.78)
    assert pin["location"]["solar_profile_city"].lower().startswith("fresno")
    assert "map pin" in (pin["location"]["note"] or "")
    zip_only = _post({**base, "zip": "94103"})
    assert zip_only["location"]["solar_profile_city"].lower().startswith("san francisco")
    climate = {a["key"]: a["value"] for a in pin["assumptions"]}.get("climate", "")
    assert "inland" in climate.lower()
    # Inland cooling is larger, so the same monthly totals put more of summer use into cooling.
    assert pin["usage"]["by_end_use_kwh"].get("cooling", 0) > zip_only["usage"]["by_end_use_kwh"].get("cooling", 0)
    # An incomplete pin is rejected instead of silently returning another place's data.
    assert client.post("/api/household/plan", json={**base, "zip": "94103", "lat": 36.75}).status_code == 422
    # Non-finite or out-of-range coordinates are rejected.
    assert client.post("/api/household/plan", json={**base, "lat": 120, "lon": 0}).status_code == 422
