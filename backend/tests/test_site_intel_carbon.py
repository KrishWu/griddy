"""Carbon-aware load shifting + SCI.  OWNER: workstream E."""

import time

import numpy as np
import pytest

from app.builder.service import list_presets
from app.pipeline import run_scenario
from app.site_intel import carbon
from app.site_intel.carbon import CarbonAwareRequest, best_window, carbon_aware, carbon_findings

PRESETS = {p.id: p for p in list_presets()}


@pytest.fixture(scope="module")
def results():
    return {pid: run_scenario(p) for pid, p in PRESETS.items()}


def shifted_series(res, share):
    """Rebuild the full shifted year from the per-day algorithm (the API returns one chart day)."""
    x = carbon._arrays(res.scenario, res.simulation)
    f = carbon._gas_factors()
    out = x["demand"].copy()
    for day in range((len(out) + 23) // 24):
        delta, _ = carbon._shift_day(x, day, share, res.scenario.demand.peak_mw, f)
        out[day * 24 : day * 24 + len(delta)] += delta
    return x["demand"], out


@pytest.mark.parametrize("pid", list(PRESETS))
def test_shift_conserves_daily_energy_and_respects_peak(results, pid):
    res = results[pid]
    base, shifted = shifted_series(res, 0.3)
    n = len(base) // 24 * 24
    assert np.allclose(base[:n].reshape(-1, 24).sum(1), shifted[:n].reshape(-1, 24).sum(1), rtol=1e-9, atol=1e-6)
    assert shifted.max() <= res.scenario.demand.peak_mw + 1e-6
    assert (shifted >= base * (1 - 0.3) - 1e-6).all()  # never removes more than the flexible share
    r = carbon_aware(CarbonAwareRequest(scenario=res.scenario, simulation=res.simulation, flexible_share=0.3))
    assert 0 <= r.avoided_t_co2e <= r.baseline_t_co2e and r.shifted_t_co2e == pytest.approx(r.baseline_t_co2e - r.avoided_t_co2e, abs=0.2)


def test_baseline_matches_evaluate_emissions(results):
    for res in results.values():
        r = carbon_aware(CarbonAwareRequest(scenario=res.scenario, simulation=res.simulation, flexible_share=0.0))
        assert r.baseline_t_co2e == pytest.approx(res.evaluation.emissions.annual_t_co2e, rel=0.01)
        assert r.avoided_t_co2e == 0 and r.shifted_mwh_per_yr == 0


def test_grid_connected_saves_carbon_and_sci_falls(results):
    res = results["grid_connected"]
    r = carbon_aware(CarbonAwareRequest(scenario=res.scenario, simulation=res.simulation, flexible_share=0.3))
    assert r.avoided_t_co2e > 0 and 0 < r.avoided_pct < 0.5
    assert 50 < r.sci_g_per_gpu_hour_before < 1000  # g CO2e per GPU-hour
    assert r.sci_g_per_gpu_hour_after < r.sci_g_per_gpu_hour_before
    assert len(r.hours) == 24 and r.provenance
    more = carbon_aware(CarbonAwareRequest(scenario=res.scenario, simulation=res.simulation, flexible_share=0.6))
    assert more.avoided_t_co2e >= r.avoided_t_co2e - 1e-6  # more flexibility never hurts


def test_runs_fast_enough_for_every_pipeline_run(results):
    res = results["grid_connected"]
    t = time.perf_counter()
    carbon_aware(CarbonAwareRequest(scenario=res.scenario, simulation=res.simulation, flexible_share=0.3))
    assert time.perf_counter() - t < 1.0


def test_best_window_is_carbon_aware_sdk_shaped():
    from datetime import datetime

    signal = np.array([300.0] * 24 + [400, 400, 100, 100, 100, 100] + [400] * 18)
    w = best_window(signal, datetime.fromisoformat("2024-01-01T00:00:00-08:00"), 1, 4, "CAISO")
    assert w["windowSize"] == 240 and len(w["forecastData"]) == 21
    (best,) = w["optimalDataPoints"]
    assert best["timestamp"] == "2024-01-02T02:00:00-08:00" and best["value"] == 100.0 and best["duration"] == 240
    assert {"location", "dataStartAt", "dataEndAt"} <= w.keys()


def test_carbon_findings(results):
    res = results["grid_connected"]
    assert carbon_findings(res.scenario, res.simulation) == []  # presets have no flexible share
    flexible = res.scenario.model_copy(update={"demand": res.scenario.demand.model_copy(update={"flexible_share": 0.3})})
    (f,) = carbon_findings(flexible, res.simulation)
    assert f.id == "carbon_aware_shift" and f.metric > 0 and "SCI" in f.detail


def test_community_demand_has_no_sci(results):
    res = next((r for r in results.values() if r.scenario.demand.kind == "community"), None)
    if res is None:
        pytest.skip("no community preset")
    r = carbon_aware(CarbonAwareRequest(scenario=res.scenario, simulation=res.simulation, flexible_share=0.3))
    assert r.sci_g_per_gpu_hour_before is None and r.sci_inputs == {}
