"""Site recommendations endpoint (Phase 2).  OWNER: workstream B.

Uses the committed site artifact (ml/artifacts/site_location), C's catalog and B's 2024 profiles; the
demand forecast is replaced by a fixed one so these tests don't depend on workstream A's artifact.
"""

import time

import pytest
from fastapi.testclient import TestClient

import app.ml_bridge as bridge
from app.contract import DemandForecast, ForecastRequest, RegionForecast, SiteRecommendation, SiteRequest
from app.evaluate.catalog import get_catalog
from app.main import app
from app.sites import service

client = TestClient(app)


def _forecast(req: ForecastRequest) -> DemandForecast:
    regions = [
        RegionForecast(region="PGAE", name="PG&E", base_peak_mw=21000, base_energy_mwh=99e6, peak_mw_p50=22800, peak_mw_p90=23000, energy_mwh=109e6, growth_peak_mw_p90=2000),
        RegionForecast(region="SCE", name="SCE", base_peak_mw=25500, base_energy_mwh=106e6, peak_mw_p50=26300, peak_mw_p90=26500, energy_mwh=111e6, growth_peak_mw_p90=1000),
    ]
    return DemandForecast(available=True, mode="ml", scenario=req.scenario, year=req.year, regions=regions)


@pytest.fixture(autouse=True)
def _setup(monkeypatch):
    monkeypatch.setattr(service, "forecast", _forecast)
    service.clear_caches()
    yield
    service.clear_caches()


def test_recommendation_covers_the_growth():
    rec = service.recommend(SiteRequest(forecast=ForecastRequest(scenario="mid", year=2035)))
    assert rec.available and rec.mode in ("model", "heuristic") and rec.sites
    need = {k: v for k, v in rec.nameplate_need_mw.items() if "/" not in k}
    alloc = {k: v for k, v in rec.allocated_mw.items() if "/" not in k}
    assert set(need) == {"solar_pv", "onshore_wind", "battery", "gas_cc"}
    for kind, mw in need.items():
        assert alloc.get(kind, 0) + rec.unmet_mw.get(kind, 0) == pytest.approx(mw, abs=1.0)
    assert not rec.unmet_mw  # California has room for this much
    # Sizing: solar = 80% clean x 75% solar of the new energy at its capacity factor.
    cf = rec.extras["annual_capacity_factor"]
    assert need["solar_pv"] == pytest.approx(15e6 * 0.8 * 0.75 / (8760 * cf["solar_pv"]), rel=1e-3)
    firm_left = 3000 - need["solar_pv"] * rec.capacity_credit["solar_pv"] - need["onshore_wind"] * rec.capacity_credit["onshore_wind"]
    assert need["battery"] == pytest.approx(firm_left * 0.7 / rec.capacity_credit["battery"], rel=1e-3)


def test_capacity_credit_and_costs_come_from_the_data():
    credit = service.capacity_credit()
    assert 0.0 < credit["solar_pv"] < 0.2  # solar is mostly gone at the net-load peak
    assert 0.0 < credit["onshore_wind"] < 0.5
    rec = service.recommend(SiteRequest())
    cat = get_catalog()
    solar = next(s for s in rec.sites if s.kind == "solar_pv")
    spec = next(t for t in cat.techs if t.kind == "solar_pv")
    assert solar.capex_usd == pytest.approx(spec.capex_usd_per_kw * solar.mw * 1000, rel=1e-3)  # mw is rounded to 0.1
    assert solar.gen_tie_usd == pytest.approx(solar.d_line_hv_km * cat.transmission.line_usd_per_km, rel=1e-2)  # km rounded to 0.01
    assert all(s.mw <= service.cell_cap_mw(s.kind, 5.0) + 0.05 for s in rec.sites)  # mw rounded to 0.1
    assert rec.total_capex_usd > 0 and all(s.reason for s in rec.sites)
    assert any("ATB" in p.source for p in rec.provenance)


def test_mix_and_weights_are_respected():
    no_gas = service.recommend(SiteRequest(mix={"battery": 1.0, "gas_cc": 0.0}))
    assert not any(s.kind == "gas_cc" for s in no_gas.sites)
    cleaner = service.recommend(SiteRequest(mix={"clean_energy_share": 1.0}))
    base = service.recommend(SiteRequest())
    assert cleaner.nameplate_need_mw["solar_pv"] > base.nameplate_need_mw["solar_pv"]
    strict_air = service.recommend(SiteRequest(weights={"air": 50.0}))
    gas = [s for s in strict_air.sites if s.kind == "gas_cc"]
    assert gas and not any(s.in_nonattainment for s in gas)


def test_unavailable_paths(monkeypatch, tmp_path):
    monkeypatch.setattr(service, "forecast", lambda req: DemandForecast(available=False, mode="unavailable", scenario=req.scenario, year=req.year))
    assert not service.recommend(SiteRequest()).available
    monkeypatch.setattr(service, "forecast", _forecast)
    monkeypatch.setattr(bridge, "ML_ARTIFACTS_DIR", tmp_path)
    service.clear_caches()
    rec = service.recommend(SiteRequest())
    assert not rec.available and rec.mode == "unavailable"


def test_api_and_speed():
    res = client.post("/api/sites/whatif", json={"forecast": {"scenario": "mid", "year": 2035}, "mix": {"gas_cc": 0}})
    assert res.status_code == 200
    rec = SiteRecommendation.model_validate(res.json())
    assert rec.available and not any(s.kind == "gas_cc" for s in rec.sites)
    assert client.get("/api/sites", params={"scenario": "high", "year": 2040}).status_code == 200
    service.recommend(SiteRequest())
    t = time.perf_counter()
    for share in (0.5, 0.7, 0.9):
        service.recommend(SiteRequest(mix={"clean_energy_share": share}))
    assert (time.perf_counter() - t) / 3 < 1.0  # interactive
