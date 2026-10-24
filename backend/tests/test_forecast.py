"""Demand forecast endpoint (Phase 2).  OWNER: workstream A.

Runs on the committed artifacts in ml/artifacts/demand_forecast (an observed baseline until the
trained forecast is exported) plus a small synthetic "ml" artifact. Ranges and invariants only.
"""

import time

import numpy as np
import pandas as pd
import pytest
from fastapi.testclient import TestClient

import app.ml_bridge as bridge
from app.contract import DemandForecast, ForecastRequest
from app.forecast import service
from app.main import app

client = TestClient(app)


@pytest.fixture(autouse=True)
def _fresh_caches():
    service.clear_caches()
    yield
    service.clear_caches()


def test_forecast_from_committed_artifact():
    f = service.forecast(ForecastRequest(scenario="mid", year=2035))
    assert f.available and f.mode in ("ml", "scenario_on_observed")
    assert {r.region for r in f.regions} == {"PGAE", "SCE", "SDGE", "LDWP", "BANC", "IID", "TIDC"}
    assert len(f.counties) >= 54
    assert 1_000 < f.total_growth_peak_mw_p90 < 40_000
    # County peaks add up to the region peaks (coincident split).
    assert sum(c.peak_mw_p90 for c in f.counties) == pytest.approx(sum(r.peak_mw_p90 for r in f.regions), rel=1e-3)
    for r in f.regions:
        assert r.trajectory[0]["year"] == f.base_year and r.trajectory[-1]["year"] == 2035
        assert r.peak_mw_p90 >= r.peak_mw_p50 > 0
    kern = next(c for c in f.counties if c.county == "Kern")
    assert kern.added_load_mw == pytest.approx(1000.0)  # the mid preset's AI campus
    assert f.provenance and f.notes


def test_scenarios_order_and_years():
    g = {s: service.forecast(ForecastRequest(scenario=s, year=2040)).total_growth_peak_mw_p90 for s in ("low", "mid", "high")}
    assert g["low"] < g["mid"] < g["high"]
    early = service.forecast(ForecastRequest(scenario="mid", year=2030)).total_growth_peak_mw_p90
    assert early < service.forecast(ForecastRequest(scenario="mid", year=2040)).total_growth_peak_mw_p90


def test_whatif_levers():
    base = service.forecast(ForecastRequest(scenario="mid", year=2035, data_center_mw={}, data_center_flexible_share=0.0))
    dc = service.forecast(ForecastRequest(scenario="mid", year=2035, data_center_mw={"06029": 1000.0}, data_center_flexible_share=0.0))
    flex = service.forecast(ForecastRequest(scenario="mid", year=2035, data_center_mw={"06029": 1000.0}, data_center_flexible_share=0.5))
    lf = dc.params["data_center_load_factor"]
    assert dc.total_growth_peak_mw_p90 - base.total_growth_peak_mw_p90 == pytest.approx(1000 * lf, abs=1.0)
    assert dc.total_growth_peak_mw_p90 - flex.total_growth_peak_mw_p90 == pytest.approx(500 * lf, abs=1.0)  # flexible load stays off the peak
    energy = lambda f: sum(r.energy_mwh for r in f.regions)  # noqa: E731
    assert energy(flex) == pytest.approx(energy(dc), rel=1e-9)  # ... but still uses energy
    more_ev = service.forecast(ForecastRequest(scenario="mid", year=2035, electrification_growth=0.03))
    assert more_ev.total_growth_peak_mw_p90 > service.forecast(ForecastRequest(scenario="mid", year=2035)).total_growth_peak_mw_p90


def test_dof_population_shifts_growth_between_counties():
    dof = service.forecast(ForecastRequest(scenario="mid", year=2040, use_dof_population=True))
    flat = service.forecast(ForecastRequest(scenario="mid", year=2040, use_dof_population=False, population_growth=0.0))
    by = lambda f: {c.county: c.growth_peak_mw_p90 for c in f.counties}  # noqa: E731
    # DOF projects Riverside growing and Los Angeles shrinking: relative to no population growth,
    # Riverside gains and Los Angeles loses.
    assert by(dof)["Riverside"] > by(flat)["Riverside"]
    assert by(dof)["Los Angeles"] < by(flat)["Los Angeles"]


def test_unavailable_without_artifacts(tmp_path, monkeypatch):
    monkeypatch.setattr(bridge, "ML_ARTIFACTS_DIR", tmp_path)
    f = service.forecast(ForecastRequest())
    assert not f.available and f.mode == "unavailable" and f.regions == []


def _ml_artifact(root):
    from ml.contract import Manifest, write_artifact

    rows = []
    for geoid, county, share in (("06029", "Kern", 0.4), ("06019", "Fresno", 0.6)):
        mwh = 8784 * 1000 * share
        rows.append({"geoid": geoid, "county": county, "region": "PGAE", "scenario": "base", "year": 2024, "annual_energy_mwh": mwh, "avg_mw": mwh / 8784,
                     "peak_mw_p50": mwh / 8784 * 1.5, "peak_mw_p90": mwh / 8784 * 1.5, "added_load_mw": 0.0, "population_share": share, "kind": "observed_downscaled"})
        f = 1.1
        rows.append({"geoid": geoid, "county": county, "region": "PGAE", "scenario": "mid", "year": 2035, "annual_energy_mwh": mwh * f, "avg_mw": mwh * f / 8784,
                     "peak_mw_p50": mwh * f / 8784 * 1.6, "peak_mw_p90": mwh * f / 8784 * 1.8, "added_load_mw": 0.0, "population_share": share, "kind": "forecast"})
    shape = pd.DataFrame({"region": ["PGAE", "PGAE"], "year": [2024, 2035], "peak_ratio_p50": [1.5, 1.6], "peak_ratio_p90": [1.5, 1.8], "weather_years": [6, 6]})
    scen = {"base": {"kind": "observed"}, "mid": {"population_growth": 0.0, "use_dof_population": False, "electrification_growth": 0.01, "efficiency_offset": 0.0, "data_center_mw": {}}}
    m = Manifest("forecast-test", "forecast", 2024, [2024, 2035], scen, "2026-10-24T00:00:00Z", {"package": "test"})
    d = root / "demand_forecast"
    write_artifact(d / "forecast-test", m, pd.DataFrame(rows), shape=shape)
    (d / "LATEST_FORECAST").write_text("forecast-test\n")


def test_ml_mode_uses_model_shapes(tmp_path, monkeypatch):
    _ml_artifact(tmp_path)
    monkeypatch.setattr(bridge, "ML_ARTIFACTS_DIR", tmp_path)
    f = service.forecast(ForecastRequest(scenario="mid", year=2035))
    assert f.mode == "ml" and f.scenarios.keys() == {"mid"}
    r = f.regions[0]
    level = 1000 * 1.01**11
    assert r.peak_mw_p50 == pytest.approx(level * 1.6, abs=0.1) and r.peak_mw_p90 == pytest.approx(level * 1.8, abs=0.1)  # responses round to 0.1 MW
    mid = next(t for t in r.trajectory if t["year"] == 2030)  # ratio interpolated between stored years
    assert mid["peak_mw_p50"] == pytest.approx(1000 * 1.01**6 * (1.5 + 0.1 * 6 / 11), abs=0.1)


def test_api_and_speed():
    res = client.get("/api/forecast", params={"scenario": "high", "year": 2040})
    assert res.status_code == 200
    f = DemandForecast.model_validate(res.json())
    assert f.available and f.scenario == "high" and f.year == 2040
    res = client.post("/api/forecast/whatif", json={"scenario": "mid", "year": 2035, "data_center_mw": {"06029": 2500}})
    assert res.status_code == 200 and next(c for c in res.json()["counties"] if c["county"] == "Kern")["added_load_mw"] == 2500
    assert client.post("/api/forecast/whatif", json={"year": 2100}).status_code == 422
    service.forecast(ForecastRequest())
    t = time.perf_counter()
    for _ in range(10):
        service.forecast(ForecastRequest(scenario="mid", year=2040, electrification_growth=float(np.random.rand() * 0.03)))
    assert (time.perf_counter() - t) / 10 < 0.1  # interactive: well under 100 ms per what-if
