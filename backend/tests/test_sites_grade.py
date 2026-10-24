"""GriddyGrade from the site-location model (GET /api/sites/grade).  OWNER: workstream B.

Runs on the committed site artifact (ml/artifacts/site_location). Invariants and orderings only:
the scores move whenever the model is re-exported.
"""

import time

import numpy as np
import pytest
from fastapi.testclient import TestClient

import app.ml_bridge as bridge
from app.contract import LngLat
from app.main import app
from app.sites import grade as g
from app.sites import service

client = TestClient(app)


@pytest.fixture(scope="module")
def idx():
    i = g._index()
    if i is None:
        pytest.skip("no site artifact committed")
    return i


def _score(lon: float, lat: float) -> dict:
    r = client.get("/api/sites/grade", params={"lon": lon, "lat": lat})
    assert r.status_code == 200
    return r.json()


def test_best_cell_is_100_and_worst_is_1(idx):
    best, worst = int(idx.composite.argmax()), int(idx.composite.argmin())
    assert g.score_from_composite(idx, float(idx.composite[best]))[0] == 100.0
    assert g.score_from_composite(idx, float(idx.composite[worst]))[0] == 1.0
    # A click exactly on the best cell's centre scores 100 too.
    assert _score(float(idx.lon[best]), float(idx.lat[best]))["score"] == 100.0


def test_scores_stay_in_1_to_100_with_one_decimal(idx):
    rng = np.random.default_rng(7)
    for i in rng.choice(len(idx.composite), 300, replace=False):
        s = _score(float(idx.lon[i]) + rng.uniform(-0.02, 0.02), float(idx.lat[i]) + rng.uniform(-0.02, 0.02))
        assert s["in_coverage"] and 1.0 <= s["score"] <= 100.0
        assert s["score"] == round(s["score"], 1)
        assert 0.0 <= s["percentile"] <= 100.0 and 1 <= s["rank"] <= s["n_cells"]


def test_score_is_monotonic_in_model_suitability(idx):
    xs = np.quantile(idx.composite, np.linspace(0, 1, 50))
    scores = [g.score_from_composite(idx, float(x))[0] for x in xs]
    assert scores == sorted(scores)
    assert 40 <= g.score_from_composite(idx, float(np.median(idx.composite)))[0] <= 60  # percentile scaling


def test_sites_from_the_spec_rank_sensibly():
    buttonwillow = _score(-119.47, 35.40)  # by Midway 500 kV, gas + solar country
    fremont = _score(-121.992, 37.529)  # 3 km from 230 kV substations, dense Bay Area
    mendocino = _score(-123.114, 39.650)  # 72 km from any 220 kV+ line
    assert buttonwillow["score"] > fremont["score"] > mendocino["score"]
    assert buttonwillow["score"] >= 85 and mendocino["score"] <= 40
    assert {d["key"] for d in mendocino["drivers"]} >= {"d_line_hv_km", "d_sub_hv_km"}
    line = next(d for d in mendocino["drivers"] if d["key"] == "d_line_hv_km")
    assert line["value"] > 50


def test_outside_california_has_no_score():
    for lon, lat in ((-126.5, 36.0), (-116.0, 39.5)):
        s = _score(lon, lat)
        assert s["available"] and not s["in_coverage"] and s["score"] is None
        assert "Outside" in s["note"]


def test_missing_artifact_degrades_gracefully(monkeypatch):
    monkeypatch.setattr(service, "latest", lambda *_: None)
    g.clear_cache()
    try:
        s = _score(-119.47, 35.40)
        assert not s["available"] and s["score"] is None
    finally:
        g.clear_cache()


def test_grade_reports_model_and_provenance():
    s = _score(-119.47, 35.40)
    assert s["model"]["artifact_id"] and s["model"]["year"] >= 2025
    assert set(s["suitability"]) == set(s["model"]["roc_auc"])
    assert any("site-location model" in p["source"] for p in s["provenance"])
    assert "1 = worst" in s["method"]


def test_grade_is_fast(idx):
    g.grade(LngLat(lon=-119.47, lat=35.40))
    t = time.perf_counter()
    for _ in range(20):
        g.grade(LngLat(lon=-120.5, lat=37.1))
    assert (time.perf_counter() - t) / 20 < 0.05


def test_bridge_points_at_committed_artifact():
    assert bridge.latest("site_location", "LATEST") is not None
