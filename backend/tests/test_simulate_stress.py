"""Stress-test screening rules.  OWNER: workstream B.

Severity and needs_utility_study behavior per rule, on the presets and small variants.
"""

from __future__ import annotations

import time

import pytest

from app.builder.service import list_presets
from app.contract import Finding, Scenario
from app.evaluate.catalog import get_catalog
from app.simulate import stress
from app.simulate.engine import simulate
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
    stress._poi_kv_from_explore.cache_clear()
    try:
        sc = _grid(PRESETS["hybrid"], poi_voltage_kv=None)
        sc = sc.model_copy(update={"site": sc.site.model_copy(update={"location": sc.site.location.model_copy(update={"lat": 36.11})})})
        poi = _run(sc)["poi_voltage"]
        assert poi.severity == "info" and poi.needs_utility_study
    finally:
        stress._poi_kv_from_explore.cache_clear()


def test_islanded_campus_skips_grid_checks():
    f = _run(_grid(PRESETS["hybrid"], connected=False))
    assert "poi_voltage" not in f and "import_headroom" not in f and "interconnection_unverified" not in f
    assert f["unmet_demand"].severity == "fail"


def test_no_gas_means_no_n_minus_1():
    assert "n_minus_1" not in _run(PRESETS["grid_connected"])


def test_battery_credit_depends_on_daily_deficit():
    # 4 h of storage firms a 4 h evening peak far better than a 14 h night.
    import numpy as np

    peaky = np.r_[np.full(20, -1.0), np.full(4, 1.0)]
    flat_night = np.r_[np.full(10, -1.0), np.full(14, 1.0)]
    assert stress._daily_deficit_hours(np.tile(peaky, 30)) == 4
    assert stress._daily_deficit_hours(np.tile(flat_night, 30)) == 14
