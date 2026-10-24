"""Model and resource signals for the power plant GriddyGrade (app/site_intel/ml.py), offline.  OWNER: workstream E.

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
def test_site_cell_signals_are_in_range_and_leave_double_counts_out():
    ctx = ml.ml_context(ALAMEDA)
    json.dumps(ctx, allow_nan=False)  # what the API returns: no NaN
    assert ctx["queue_mw"] >= 0
    suit = ctx["site_cell"]["suitability"]
    assert {"solar_pv", "onshore_wind", "gas_cc"} <= set(suit)  # every generation kind the model learned
    assert all(0 <= p <= 1 for p in suit.values())
    res = ctx["site_cell"]["resource"]
    assert 3 <= res["ghi_kwh_m2_day"] <= 8 and 0 < res["wind100_ms"] < 20
    basis = ctx["resource_basis"]
    assert basis["wind_height_m"] == 100 and basis["grid_km"] >= 25 and basis["years"] == 1  # what the grade checks before scoring
    assert "in_nonattainment" not in json.dumps(ctx)  # E reads EPA designations itself
    assert "d_line_hv_km" not in json.dumps(ctx)  # A's summary and grid_tiers have the grid distances
    assert "clean_build" not in ctx and "forecast" not in ctx  # data center signals are gone
    for m in ctx["site_artifact"]["model_metrics"].values():
        assert 0.5 <= m["roc_auc"] <= 1


@needs_artifact
def test_site_cell_is_the_nearest_cell_not_the_best_nearby():
    t = ml._table()
    i = int(np.argmax(t.p["solar_pv"]))
    p = LngLat(lon=float(t.lon[i]), lat=float(t.lat[i]))
    ctx = ml.ml_context(p)
    assert ctx["cell"]["id"] == int(t.cell[i]) and ctx["cell"]["distance_km"] < 0.01
    assert ctx["site_cell"]["suitability"]["solar_pv"] == pytest.approx(float(t.p["solar_pv"][i]), abs=1e-4)


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
    era5 = next(p for p in intel.provenance if "ERA5" in p.source)
    assert era5.kind == "observed" and "not a long-term mean" in (era5.note or "")
    if ctx["queue_mw"] < ml.QUEUE_HIGH_MW:
        assert not any(f.id == "interconnection_queue_congested" for f in intel.findings)


def test_site_intel_survives_broken_signals(offline, monkeypatch):
    def boom(*_):
        raise RuntimeError("artifact unreadable")

    monkeypatch.setattr(ml, "ml_context", boom)
    intel = service.site_intel(KERN)
    assert intel.extras["ml"]["available"] is False
    assert not any(f.id == "site_intel_error" for f in intel.findings)
