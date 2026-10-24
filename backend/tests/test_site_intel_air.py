"""Air quality: nonattainment lookup, AQI snapshot fallback, AIR_PERMIT_RISK.  OWNER: workstream E."""

import pytest

from app.builder.service import list_presets
from app.contract import LngLat
from app.pipeline import run_scenario
from app.site_intel import air
from app.site_intel.config import DEMO_SITES

BUTTONWILLOW = DEMO_SITES["kern"]["location"]


@pytest.fixture
def no_key(monkeypatch):
    monkeypatch.delenv("AIRNOW_API_KEY", raising=False)

    def no_network(*_a, **_k):
        raise AssertionError("network call without AIRNOW_API_KEY")

    monkeypatch.setattr(air.httpx, "get", no_network)


@pytest.fixture(scope="module")
def hybrid():
    preset = next(p for p in list_presets() if p.id == "hybrid")
    return preset, run_scenario(preset)


def test_san_joaquin_valley_is_extreme_ozone_and_serious_pm25():
    areas = air.nonattainment_at(BUTTONWILLOW)
    got = {(a["naaqs"], a["classification"]) for a in areas}
    assert ("2015 8-hour ozone", "Extreme") in got
    assert any(a["pollutant"] == "PM2.5" and a["classification"] == "Serious" for a in areas)
    assert all("San Joaquin Valley" in a["area"] for a in areas)
    assert air.nox_threshold_t(areas) == pytest.approx(9.1, abs=0.05)  # 10 short tons/yr in an Extreme ozone area


def test_attainment_sites_have_no_areas():
    assert air.nonattainment_at(LngLat(lon=-120.5, lat=41.5)) == []  # Modoc County
    assert air.nonattainment_at(LngLat(lon=-125.5, lat=36.0)) == []  # Pacific Ocean


def test_snapshot_fallback_without_key(no_key):
    ctx = air.air_context(BUTTONWILLOW)
    assert ctx.source == "airnow_snapshot" and ctx.aqi is not None and 0 <= ctx.aqi <= 500
    assert ctx.category == air.aqi_category(ctx.aqi) and ctx.distance_km <= air.SEARCH_KM
    payload = air.air_quality_dict(ctx)
    assert {"aqi", "pollutant", "category"} <= payload.keys()
    ids = {f.id: f.severity for f in air.air_findings(ctx)}
    assert ids["air_nonattainment"] == "warn" and "air_quality" in ids
    assert {p.source for p in ctx.provenance} >= {"EPA Green Book nonattainment areas", "AirNow (U.S. EPA and partners), preliminary data"}


def test_far_from_any_monitor(no_key):
    ctx = air.air_context(LngLat(lon=-100.0, lat=40.0))
    assert ctx.aqi is None and air.air_quality_dict(ctx) is None
    assert {f.id: f.severity for f in air.air_findings(ctx)} == {"air_quality": "info", "air_nonattainment": "pass"}


def test_live_failure_falls_back_to_snapshot(monkeypatch, tmp_path):
    monkeypatch.setenv("AIRNOW_API_KEY", "test-key")
    monkeypatch.setattr(air, "AIRNOW_CACHE", tmp_path)

    def down(*_a, **_k):
        raise air.httpx.ConnectTimeout("down")

    monkeypatch.setattr(air.httpx, "get", down)
    assert air.air_context(BUTTONWILLOW).source == "airnow_snapshot"


@pytest.mark.parametrize("category_cutoffs", [(0, "Good"), (50, "Good"), (51, "Moderate"), (151, "Unhealthy"), (301, "Hazardous")])
def test_aqi_categories(category_cutoffs):
    aqi, name = category_cutoffs
    assert air.aqi_category(aqi) == name


def test_air_permit_risk(hybrid):
    preset, res = hybrid
    ev = res.evaluation.model_copy(deep=True)
    ev.extras["nox_t_per_yr"] = 120.0
    f = air.air_permit_risk(preset, res.simulation, ev)
    assert f is not None and f.id == "AIR_PERMIT_RISK" and f.severity == "warn"
    assert f.metric == 120.0 and f.threshold == pytest.approx(9.1, abs=0.05) and "above" in f.detail

    ev.extras["nox_t_per_yr"] = 0.0
    assert air.air_permit_risk(preset, res.simulation, ev) is None

    elsewhere = preset.model_copy(update={"site": preset.site.model_copy(update={"location": LngLat(lon=-120.5, lat=41.5)})})
    ev.extras["nox_t_per_yr"] = 120.0
    assert air.air_permit_risk(elsewhere, res.simulation, ev) is None


def test_air_permit_risk_without_c_numbers_uses_gas_generation(hybrid):
    preset, res = hybrid
    ev = res.evaluation.model_copy(deep=True)
    for k in ("nox_t_per_yr", "pm25_t_per_yr", "nox_t_per_yr_scr"):
        ev.extras.pop(k, None)
    assert sum(res.simulation.hourly.generation_mw["gas_cc"]) > 0
    f = air.air_permit_risk(preset, res.simulation, ev)
    assert f is not None and f.metric is None and "not yet quantified" in f.detail

    grid_only = next(p for p in list_presets() if p.id == "grid_connected")
    g = run_scenario(grid_only)
    g.evaluation.extras.pop("nox_t_per_yr", None)
    assert air.air_permit_risk(grid_only, g.simulation, g.evaluation) is None


@pytest.mark.parametrize("bad", ["12", None, float("nan"), True, [], {"x": 1}])
def test_air_permit_risk_tolerates_malformed_extras(hybrid, bad):
    preset, res = hybrid
    ev = res.evaluation.model_copy(deep=True)
    ev.extras["nox_t_per_yr"] = bad
    f = air.air_permit_risk(preset, res.simulation, ev)
    assert f is not None and f.metric is None  # treated as "not quantified"; gas still runs in Hybrid
