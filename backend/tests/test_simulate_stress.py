"""Stress-test screening rules.  OWNER: workstream B.

Severity and needs_utility_study behavior per rule, on the presets and small variants.
"""

from __future__ import annotations

import time
from types import SimpleNamespace

import numpy as np
import pytest

from app.builder.service import list_presets
from app.contract import Asset, Finding, Scenario
from app.evaluate.catalog import get_catalog
from app.simulate import stress
from app.simulate.dispatch import Drivers, Fleet
from app.simulate.engine import prepare, simulate
from app.simulate.stress import stress_test

CATALOG = get_catalog()
PRESETS = {p.id: p for p in list_presets()}


def _run(sc: Scenario) -> dict[str, Finding]:
    findings = stress_test(sc, simulate(sc, CATALOG))
    ids = [f.id for f in findings]
    assert len(ids) == len(set(ids)), ids  # the UI keys findings on module + id
    return {f.id: f for f in findings}


def _grid(sc: Scenario, **kw) -> Scenario:
    return sc.model_copy(update={"grid": sc.grid.model_copy(update=kw)}, deep=True)


def _battery_hours(sc: Scenario, hours: float) -> Scenario:
    assets = [a.model_copy(update={"duration_h": hours}) if a.kind == "battery" else a for a in sc.assets]
    return sc.model_copy(update={"assets": assets}, deep=True)


@pytest.mark.parametrize("preset", list(PRESETS))
def test_every_preset_screens_quickly_without_errors(preset):
    sc = PRESETS[preset]
    sim = simulate(sc, CATALOG)
    t = time.perf_counter()
    findings = stress_test(sc, sim)
    assert time.perf_counter() - t < 0.5
    assert not [f for f in findings if f.id.endswith("_error")]
    assert all(f.module in ("stress", "simulate") for f in findings)


def test_hybrid_passes_base_year_and_flags_thin_margins():
    f = _run(PRESETS["hybrid"])
    assert f["unmet_demand"].severity == "pass"
    assert f["storage_duration"].severity == "pass"  # gas + imports alone cover every hour
    assert f["n_minus_1"].severity in ("pass", "warn")
    assert f["heat_wave"].severity in ("pass", "warn")
    assert "firm_capacity" in f


def test_renewable_heavy_needs_firming():
    f = _run(PRESETS["renewable_heavy"])
    assert f["unmet_demand"].severity == "fail"
    assert f["storage_duration"].severity in ("warn", "fail")
    assert f["storage_duration"].metric > f["storage_duration"].threshold


def test_gigawatt_campus_on_230kv_needs_a_study():
    f = _run(_grid(PRESETS["grid_connected"], poi_voltage_kv=230))
    poi = f["poi_voltage"]
    assert poi.severity == "fail" and poi.needs_utility_study
    assert poi.metric == pytest.approx(1100)


def test_poi_capacity_bands():
    assert _run(_grid(PRESETS["hybrid"], poi_voltage_kv=500))["poi_voltage"].severity == "pass"
    assert _run(_grid(PRESETS["hybrid"], poi_voltage_kv=230))["poi_voltage"].severity == "pass"  # 300 MW
    assert _run(_grid(PRESETS["hybrid"], poi_voltage_kv=115))["poi_voltage"].severity == "fail"
    assert _run(_grid(PRESETS["hybrid"], import_limit_mw=500, poi_voltage_kv=230))["poi_voltage"].severity == "warn"


def test_explore_failure_never_breaks_the_screen(monkeypatch):
    import app.explore.service as explore

    def boom(_loc):
        raise RuntimeError("GIS down")

    monkeypatch.setattr(explore, "summarize_site", boom)
    stress._explore_kv.cache_clear()
    try:
        sc = _grid(PRESETS["hybrid"], poi_voltage_kv=None)
        sc = sc.model_copy(update={"site": sc.site.model_copy(update={"location": sc.site.location.model_copy(update={"lat": 36.11})})})
        poi = _run(sc)["poi_voltage"]
        assert poi.severity == "info" and poi.needs_utility_study
    finally:
        stress._explore_kv.cache_clear()


def test_community_feeder_is_a_distribution_interconnection():
    f = _run(PRESETS["community_microgrid"])
    assert f["poi_voltage"].severity == "info" and f["poi_voltage"].needs_utility_study
    assert "Rule 21" in f["interconnection_unverified"].detail


def test_islanded_campus_skips_grid_checks():
    f = _run(_grid(PRESETS["hybrid"], connected=False))
    assert "poi_voltage" not in f and "import_headroom" not in f and "interconnection_unverified" not in f
    assert f["unmet_demand"].severity == "fail"


def test_no_gas_means_no_n_minus_1():
    assert "n_minus_1" not in _run(PRESETS["grid_connected"])


def test_battery_credit_depends_on_daily_deficit():
    # 4 h of storage firms a 4 h evening peak far better than a 14 h night.
    peaky = np.r_[np.full(20, -1.0), np.full(4, 1.0)]
    flat_night = np.r_[np.full(10, -1.0), np.full(14, 1.0)]
    assert stress._daily_deficit_hours(np.tile(peaky, 30)) == 4
    assert stress._daily_deficit_hours(np.tile(flat_night, 30)) == 14


# --- reruns ----------------------------------------------------------------


@pytest.mark.parametrize("preset", ["hybrid", "renewable_heavy"])
def test_unstressed_rerun_reproduces_the_base_window(preset):
    # A rerun must change only the stress: same dispatch policy (grid charging), same
    # lookahead past the window, same starting SOC. renewable_heavy is short in its
    # N-1 week (94 h), so a policy mismatch shows up as extra unmet hours.
    sc = PRESETS[preset]
    sim, prep = simulate(sc, CATALOG), prepare(sc, CATALOG)
    assert prep.fleet.grid_charging
    windows = [stress._n1_window(sim, prep), stress._heat_window(sc, prep), slice(0, 168), slice(prep.n - 168, prep.n)]
    for w in windows:
        d = stress._rerun(prep, sim, w)
        assert len(d.unmet_mw) == len(d.soc_mwh) == w.stop - w.start
        base_h, base_mwh = stress._shortfall(sim.hourly.unmet_mw[w])
        h, mwh = stress._shortfall(d.unmet_mw)
        assert h == base_h, w
        assert mwh == pytest.approx(base_mwh, abs=stress.RERUN_TOL_MWH), w
        assert np.abs(d.soc_mwh - np.asarray(sim.hourly.battery_soc_mwh[w])).max() < 0.05, w


def test_stress_reruns_report_the_increment_over_the_base_year():
    sc = PRESETS["renewable_heavy"]
    sim, prep = simulate(sc, CATALOG), prepare(sc, CATALOG)
    f = {x.id: x for x in stress_test(sc, sim)}
    for fid, w in (("heat_wave", stress._heat_window(sc, prep)), ("n_minus_1", stress._n1_window(sim, prep))):
        base_h, _ = stress._shortfall(sim.hourly.unmet_mw[w])
        assert base_h > 0  # this preset is already short in both weeks
        assert f"{base_h:,} h" in f[fid].detail and "already unmet" in f[fid].detail
        assert 0 <= f[fid].metric <= (w.stop - w.start) - base_h  # added hours only


def test_community_heat_wave_says_no_load_was_added():
    f = _run(PRESETS["community_microgrid"])["heat_wave"]
    assert "no added load modeled" in f.detail and "extra cooling" not in f.detail
    assert "observed" in f.title


def test_n_minus_1_takes_out_one_plant_not_two():
    sc = PRESETS["hybrid"]
    gas = [Asset(id="g1", kind="gas_cc", capacity_mw=200), Asset(id="g2", kind="gas_cc", capacity_mw=200)]
    sc = sc.model_copy(update={"assets": [a for a in sc.assets if a.kind != "gas_cc"] + gas}, deep=True)
    f = _run(_grid(sc, import_limit_mw=600))["n_minus_1"]
    assert "a 200 MW CC block" in f.detail and "2 plants" in f.detail


# --- storage duration --------------------------------------------------------


def _toy_storage(demand, solar_mw, *, batt_mwh, batt_mw=100.0, unmet_h=0, **fleet):
    """_storage_duration on hand-built hourly inputs (rte 1, so MWh add up exactly)."""
    demand = np.asarray(demand, float)
    n = len(demand)
    prep = SimpleNamespace(
        n=n,
        fleet=Fleet(solar_mw=1000.0, batt_mw=batt_mw, batt_mwh=batt_mwh, rte=1.0, **fleet),
        drivers=Drivers(demand, np.asarray(solar_mw, float) / 1000, np.zeros(n), np.zeros(n), np.zeros(n)),
    )
    sim = SimpleNamespace(summary=SimpleNamespace(hours_unmet=unmet_h))
    return stress._storage_duration(SimpleNamespace(assumptions=SimpleNamespace(weather_year=2024)), sim, prep)


def test_storage_need_counts_a_short_recharge_only_for_what_it_stores():
    # 12 h short, ONE hour of 10 MW surplus, 11 h short, then a sunny day that refills it.
    solar = np.r_[np.zeros(12), 110.0, np.zeros(11), np.full(24, 300.0)]
    f = _toy_storage(np.full(48, 100.0), solar, batt_mwh=2000)
    assert f.severity == "warn"  # a reset at the 1 h surplus would call 1,200 MWh enough
    assert f.metric == pytest.approx(1200 - 10 + 1100)


def test_storage_need_wraps_across_the_year_end():
    # Short for the last 10 h and the first 10 h: one 20 h stretch, since the year is cyclic.
    solar = np.r_[np.zeros(10), np.full(28, 200.0), np.zeros(10)]
    f = _toy_storage(np.full(48, 100.0), solar, batt_mwh=1500)
    assert f.severity == "warn" and f.metric == pytest.approx(2000)
    assert "over the 20 h from Jan 2 14:00 PST (20 h of them short)" in f.detail


def test_storage_that_can_never_refill_fails():
    f = _toy_storage(np.full(48, 100.0), np.full(48, 50.0), batt_mwh=10_000)
    assert f.severity == "fail" and "no battery size" in f.detail


def test_spare_imports_count_as_recharge_only_with_grid_charging():
    # Nights 50 MW short even at the 50 MW import limit; by day solar covers the load,
    # leaving the whole import limit spare, but only rule 6 may charge from it.
    solar = np.tile(np.r_[np.zeros(12), np.full(12, 100.0)], 2)
    off = _toy_storage(np.full(48, 100.0), solar, batt_mwh=1000, import_limit_mw=50.0)
    on = _toy_storage(np.full(48, 100.0), solar, batt_mwh=1000, import_limit_mw=50.0, grid_charging=True)
    assert off.severity == "fail"  # 600 MWh short a night, nothing to refill from
    assert on.severity == "pass" and on.metric == pytest.approx(600) and "spare imports" in on.detail


def test_storage_never_passes_a_year_with_unmet_demand():
    solar = np.r_[np.zeros(12), np.full(36, 300.0)]
    assert _toy_storage(np.full(48, 100.0), solar, batt_mwh=2000).severity == "pass"
    f = _toy_storage(np.full(48, 100.0), solar, batt_mwh=2000, unmet_h=5)
    assert f.severity == "warn" and "5 h unmet" in f.detail


@pytest.mark.parametrize("hours", [16.0, 48.0])
def test_long_battery_screens_agree_with_unmet_demand(hours):
    # More battery hours lift the firm-capacity credit, but renewable_heavy still runs short
    # in multi-day lulls; neither screen may pass next to a failing unmet-demand check.
    f = _run(_battery_hours(PRESETS["renewable_heavy"], hours))
    assert f["unmet_demand"].severity == "fail"
    assert f["storage_duration"].severity != "pass"
    assert f["firm_capacity"].severity != "pass"


# --- firm capacity -----------------------------------------------------------


def test_firm_capacity_is_measured_against_the_facility_peak_in_percent():
    # 1,100 MW of imports vs the 1,000 MW facility peak (the flat profile only draws 900 MW).
    g = _run(PRESETS["grid_connected"])["firm_capacity"]
    assert g.severity == "warn" and 9 < g.metric < 11 and g.threshold == 15.0
    assert "facility peak 1,000 MW" in g.detail and "simulated max 900 MW" in g.detail
    assert f"{g.metric:+.1f}% margin" in g.detail  # the card shows the number it judged
    assert "forced-outage" not in g.detail  # no gas, no EFOR credit text
    h = _run(PRESETS["hybrid"])["firm_capacity"]
    assert f"{h.metric:+.1f}% margin" in h.detail and h.metric < h.threshold
    assert "(CC)" in h.detail and "(CT)" not in h.detail


def test_firm_capacity_with_no_demand_is_info():
    sc = PRESETS["hybrid"]
    sc = sc.model_copy(update={"demand": sc.demand.model_copy(update={"peak_mw": 0.0})}, deep=True)
    f = _run(sc)["firm_capacity"]
    assert f.severity == "info" and f.metric is None


# --- grid ties -----------------------------------------------------------------


def test_import_headroom_ignores_interruptible_battery_charging():
    # Rule 6 fills spare import capacity with battery charging; that isn't load.
    sc = PRESETS["grid_connected"].model_copy(update={"assets": [Asset(id="b", kind="battery", capacity_mw=300, duration_h=4)]}, deep=True)
    sim = simulate(sc, CATALOG)
    assert sim.summary.peak_import_mw > 0.9 * sc.grid.import_limit_mw  # total flow does hit the limit
    f = stress._import_headroom(sc, sim)
    assert f.severity == "pass" and f.metric < 0.9 * sc.grid.import_limit_mw
    assert "interruptible battery charging" in f.detail
    # Without the hourly series (older engine), all imports count as load.
    bare = sim.model_copy(update={"extras": {k: v for k, v in sim.extras.items() if k != "battery_grid_charge_mw"}})
    assert stress._import_headroom(sc, bare).severity == "warn"


def test_poi_bands_follow_real_voltage_classes():
    assert stress._poi_band(220) == stress._poi_band(230) == (400, 600)  # SCE's 220 kV network
    assert stress._poi_band(66) == stress._poi_band(69) == (50, 100)
    assert stress._poi_band(161) == stress._poi_band(138)
    assert stress._poi_band(287) == stress._poi_band(345)
    assert stress._poi_band(765) == stress._poi_band(500)
    assert stress._poi_band(12) is None
    assert _run(_grid(PRESETS["hybrid"], poi_voltage_kv=220))["poi_voltage"].severity == "pass"  # 300 MW
    feeder = _run(_grid(PRESETS["hybrid"], import_limit_mw=60, poi_voltage_kv=12))["poi_voltage"]
    assert feeder.severity == "info" and feeder.needs_utility_study and "distribution" in feeder.title
    for bad in (-999999.0, 0.0, float("nan")):  # HIFLD sentinel, zero, missing
        poi = _run(_grid(PRESETS["hybrid"], poi_voltage_kv=bad))["poi_voltage"]
        assert poi.severity == "info" and "unknown" in poi.title


def test_explore_hiccup_is_retried_not_cached(monkeypatch):
    import app.explore.service as explore

    calls = []

    def flaky(loc):
        calls.append(loc)
        if len(calls) == 1:
            raise RuntimeError("GIS hiccup")
        return SimpleNamespace(nearest_line_kv=230.0, nearest_substations=[])

    monkeypatch.setattr(explore, "summarize_site", flaky)
    stress._explore_kv.cache_clear()
    try:
        assert [stress._poi_kv_from_explore(-119.47, 35.4) for _ in range(3)] == [None, 230.0, 230.0]
        assert len(calls) == 2  # retried after the failure, then cached
    finally:
        stress._explore_kv.cache_clear()
