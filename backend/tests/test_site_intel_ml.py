"""Model signals for the GriddyGrade (app/site_intel/ml.py), offline.  OWNER: workstream E.

Ranges and invariants only: B's and A's artifacts will keep changing the numbers.
"""

import json

import numpy as np
import pytest

from app.contract import LngLat
from app.site_intel import ml, service
from app.site_intel.config import DEMO_SITES

KERN = DEMO_SITES["kern"]["location"]
ALAMEDA = LngLat(lon=-121.9, lat=37.6)
OUT_OF_STATE = {"Las Vegas": LngLat(lon=-115.14, lat=36.17), "Phoenix": LngLat(lon=-112.07, lat=33.45), "50 km off Monterey": LngLat(lon=-122.5, lat=36.6)}

needs_artifact = pytest.mark.skipif(ml._table() is None, reason="no site-location artifact under ml/artifacts/site_location")


@pytest.fixture
def offline(monkeypatch):
    monkeypatch.delenv("EE_PROJECT", raising=False)
    monkeypatch.delenv("AIRNOW_API_KEY", raising=False)


@needs_artifact
def test_california_point_finds_a_cell_within_3_5_km():
    ctx = ml.ml_context(KERN)
    assert ctx["available"] is True
    assert 0 <= ctx["cell"]["distance_km"] <= 3.6
    assert ctx["cell"]["county"] == "Kern"


@needs_artifact
def test_every_point_between_cells_is_within_3_5_km():
    t = ml._table()
    rng = np.random.default_rng(7)
    for i in rng.choice(len(t.cell), 40, replace=False):
        # up to half a cell (2.5 km) off a cell center in each direction
        dlat, dlon = rng.uniform(-2.5, 2.5, 2) / 111.0
        p = LngLat(lon=float(t.lon[i] + dlon / np.cos(np.radians(t.lat[i]))), lat=float(t.lat[i] + dlat))
        ctx = ml.ml_context(p)
        assert ctx["available"] and ctx["cell"]["distance_km"] <= 3.6, (p, ctx.get("cell"))


@needs_artifact
@pytest.mark.parametrize("name", OUT_OF_STATE)
def test_out_of_state_point_finds_no_cell(name):
    ctx = ml.ml_context(OUT_OF_STATE[name])
    assert ctx["available"] is False
    assert "outside California" in ctx["reason"]
    assert ml.ml_findings(ctx) == [] and ml.ml_provenance(ctx) == []


def test_missing_artifact_is_unavailable(monkeypatch):
    monkeypatch.setattr(ml, "latest", lambda *_: None)
    assert ml.ml_context(KERN) == {"available": False, "reason": "site-location artifact not found"}


@needs_artifact
def test_signals_are_in_range_and_leave_gas_and_double_counts_out():
    ctx = ml.ml_context(ALAMEDA)
    json.dumps(ctx, allow_nan=False)  # what the API returns: no NaN
    assert ctx["queue_mw"] >= 0
    clean = ctx["clean_build"]
    assert set(clean) == {"radius_km", "solar_pv", "onshore_wind", "battery"}  # no gas_cc
    for kind in ("solar_pv", "onshore_wind", "battery"):
        assert 0 <= clean[kind]["best"] <= 1
        assert clean[kind]["distance_km"] <= ml.CLEAN_RADIUS_KM
    assert "in_nonattainment" not in json.dumps(ctx)  # E scores EPA designations itself
    assert "d_line_hv_km" not in json.dumps(ctx)  # A's summary has the grid distances
    for kind, m in ctx["site_artifact"]["model_metrics"].items():
        assert kind != "gas_cc" and 0.5 <= m["roc_auc"] <= 1


@needs_artifact
def test_forecast_context_prefers_p50():
    f = ml.ml_context(ALAMEDA)["forecast"]
    if f is None:
        pytest.skip("no demand forecast artifact")
    region = f["region"]
    assert region["base_peak_mw_p50"] > 0
    assert region["peak_mw_p50"] <= region["peak_mw_p90"]
    assert (f["scenario"], f["year"]) == ("mid", 2035)
    assert 0 <= f["metrics"].get("p10_p90_coverage", 0.5) <= 1


@needs_artifact
def test_a_broken_forecast_leaves_the_other_signals(monkeypatch):
    import app.forecast.service as fs

    def boom(*_):
        raise RuntimeError("forecast down")

    monkeypatch.setattr(fs, "forecast", boom)
    ctx = ml.ml_context(ALAMEDA)
    assert ctx["available"] is True and ctx["forecast"] is None and ctx["queue_mw"] >= 0


@needs_artifact
def test_congested_queue_needs_a_utility_study(offline):
    ctx = ml.ml_context(KERN)
    assert ctx["queue_mw"] >= ml.QUEUE_HIGH_MW  # Kern has the largest county queue in California
    intel = service.site_intel(KERN)
    f = next(f for f in intel.findings if f.id == "interconnection_queue_congested")
    assert f.needs_utility_study is True and f.severity == "warn"
    assert f.metric == pytest.approx(ctx["queue_mw"]) and f.threshold == ml.QUEUE_HIGH_MW


@needs_artifact
def test_site_intel_carries_the_signals_and_their_provenance(offline):
    intel = service.site_intel(ALAMEDA)
    ctx = intel.extras["ml"]
    assert ctx["available"] is True
    sources = {p.source: p for p in intel.provenance}
    model = next(p for s, p in sources.items() if s.startswith("Griddy site-location model"))
    assert model.kind == "inferred" and ctx["site_artifact"]["id"] in model.source and "ROC-AUC" in (model.note or "")
    assert any(p.kind == "observed" and "Queued Up" in p.source for p in intel.provenance)
    if ctx["queue_mw"] < ml.QUEUE_HIGH_MW:
        assert not any(f.id == "interconnection_queue_congested" for f in intel.findings)


def test_site_intel_survives_broken_signals(offline, monkeypatch):
    def boom(*_):
        raise RuntimeError("artifact unreadable")

    monkeypatch.setattr(ml, "ml_context", boom)
    intel = service.site_intel(KERN)
    assert intel.extras["ml"]["available"] is False
    assert not any(f.id == "site_intel_error" for f in intel.findings)
