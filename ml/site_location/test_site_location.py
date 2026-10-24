"""Unit tests for the site-location pipeline. No model is trained: recommendations run with stub
scorers in place of the XGBoost models.  Run from the repo root:  python -m pytest ml"""

from __future__ import annotations

import json

import numpy as np
import pandas as pd
import pytest
from shapely.geometry import LineString, box

from ml.contract.demand_artifact import Manifest, read_artifact, write_artifact
from ml.site_location.config import EXPLORE_DIR, NEGATIVE_EXCLUSION_KM
from ml.site_location.dataset import build_training_set, spatial_blocks
from ml.site_location.features import FEATURES, candidate_grid, compute_features, demand_points, radius_sum
from ml.site_location.geodata import GeoData, geodata
from ml.site_location.recommend import region_need, recommend, solve

KM = 1000.0


def _toy_geo() -> GeoData:
    """Two 100 km x 100 km 'counties' side by side; a 230 kV line along y = 50 km in the west one."""
    counties = pd.DataFrame({"geoid": ["06001", "06003"], "name": ["West", "East"]})
    counties["geometry"] = [box(0, 0, 100 * KM, 100 * KM), box(100 * KM, 0, 200 * KM, 100 * KM)]
    subs = pd.DataFrame({"id": ["s1", "s2"], "name": ["Big", "Small"], "voltage_kv": [500.0, 69.0], "substation_type": [None, None], "x": [10 * KM, 150 * KM], "y": [50 * KM, 50 * KM]})
    rng = np.random.default_rng(0)
    plants = pd.DataFrame(
        {
            "id": [f"p{i}" for i in range(30)],
            "name": [f"Plant {i}" for i in range(30)],
            "fuel": "solar",
            "capacity_mw": 50.0,
            "first_year": 2015,
            "x": rng.uniform(5, 95, 30) * KM,
            "y": 50 * KM + rng.uniform(-3, 3, 30) * KM,  # all hug the line
        }
    )
    pop = pd.DataFrame({"x": [20 * KM, 180 * KM], "y": [20 * KM, 80 * KM], "population": [10_000, 50_000], "geoid": ["06001", "06003"]})
    line = LineString([(0, 50 * KM), (100 * KM, 50 * KM)])
    land = box(0, 0, 200 * KM, 100 * KM)
    return GeoData(plants, subs, [line], [line], pop, counties, land, {"06001": 5000.0, "06003": 0.0}, box(140 * KM, 0, 200 * KM, 100 * KM))


def _toy_artifact(tmp_path, geoids=("06001", "06003")):
    rows = []
    for scenario, year, f in (("base", 2024, 1.0), ("mid", 2035, 1.5)):
        for g in geoids:
            rows.append(
                {"geoid": g, "county": g, "region": "PGAE", "scenario": scenario, "year": year, "annual_energy_mwh": 1e6 * f, "avg_mw": 114.0 * f,
                 "peak_mw_p50": 200.0 * f, "peak_mw_p90": 220.0 * f, "added_load_mw": 0.0, "population_share": 1 / len(geoids),
                 "kind": "observed_downscaled" if scenario == "base" else "forecast"}
            )
    m = Manifest("toy", "forecast", 2024, [2024, 2035], {"base": {}, "mid": {}}, "2026-10-24T00:00:00Z", {"package": "test"})
    return read_artifact(write_artifact(tmp_path / "art", m, pd.DataFrame(rows)))


def test_radius_sum_matches_brute_force():
    rng = np.random.default_rng(1)
    wx, wy, w = rng.uniform(0, 300 * KM, 2000), rng.uniform(0, 300 * KM, 2000), rng.uniform(0, 10, 2000)
    px, py = rng.uniform(50 * KM, 250 * KM, 50), rng.uniform(50 * KM, 250 * KM, 50)
    got = radius_sum(px, py, wx, wy, w, 50.0)
    exact = np.array([w[np.hypot(wx - x, wy - y) <= 50 * KM].sum() for x, y in zip(px, py)])
    assert np.allclose(got, exact, rtol=0.15)  # binning to radius/10 moves weights by < 4 km


def test_compute_features_distances(tmp_path):
    geo = _toy_geo()
    demand = demand_points(geo, _toy_artifact(tmp_path), "base", 2024)
    X = compute_features(np.array([10 * KM, 150 * KM]), np.array([60 * KM, 50 * KM]), geo, demand)
    assert list(X.columns) == FEATURES
    assert X.loc[0, "d_line_hv_km"] == pytest.approx(10.0) and X.loc[0, "d_sub_hv_km"] == pytest.approx(10.0)
    assert X.loc[1, "d_sub_any_km"] == pytest.approx(0.0) and X.loc[1, "sub_kv_max_10km"] == 69.0
    assert X.loc[1, "log_demand_50km_gwh"] > 0  # East county's demand sits within 50 km
    assert X.loc[0, "in_nonattainment"] == 0 and X.loc[1, "in_nonattainment"] == 1
    assert 3.5 < X["ghi_kwh_m2_day"].min() and X["ghi_kwh_m2_day"].max() < 7.0  # ERA5 resource interpolated in


def test_training_set_negatives_stay_away_from_plants(tmp_path):
    geo = _toy_geo()
    grid = candidate_grid(geo, 5.0)
    demand = demand_points(geo, _toy_artifact(tmp_path), "base", 2024)
    ts = build_training_set(geo, grid, compute_features(grid["x"].to_numpy(), grid["y"].to_numpy(), geo, demand), demand, "solar")
    assert ts.y.sum() == 30 and (ts.y == 0).sum() > 0
    neg = ts.meta[ts.meta["label"] == 0]
    d = np.min(np.hypot(neg["x"].to_numpy()[:, None] - geo.plants["x"].to_numpy(), neg["y"].to_numpy()[:, None] - geo.plants["y"].to_numpy()), axis=1)
    assert (d > NEGATIVE_EXCLUSION_KM * KM).all()
    assert len(ts.groups) == len(ts.y) and spatial_blocks(np.array([1.0, 49_999.0]), np.array([0.0, 0.0]))[0] == spatial_blocks(np.array([49_999.0]), np.array([0.0]))[0]


def test_solve_fills_cheapest_cells_then_reports_unmet():
    cand = pd.DataFrame({"tech": ["solar", "solar", "gas"], "region": ["PGAE"] * 3, "cost": [0.1, 0.5, 0.2]})
    alloc, unmet = solve(cand, {("PGAE", "solar"): 350.0, ("PGAE", "gas"): 100.0}, {"solar": 300.0, "gas": 500.0})
    by_cost = alloc.set_index("cost")["mw"]
    assert by_cost[0.1] == pytest.approx(300) and by_cost[0.5] == pytest.approx(50) and by_cost[0.2] == pytest.approx(100)
    assert sum(unmet.values()) == pytest.approx(0)
    _, unmet = solve(cand, {("PGAE", "solar"): 700.0}, {"solar": 300.0, "gas": 500.0})
    assert unmet[("PGAE", "solar")] == pytest.approx(100)


def test_region_need_is_peak_growth(tmp_path):
    need = region_need(_toy_artifact(tmp_path), "mid", 2035)
    assert need["PGAE"] == pytest.approx(2 * 220 * 0.5)


@pytest.mark.skipif(not (EXPLORE_DIR / "plants_ca.geojson").is_file(), reason="needs data/explore layers")
def test_recommend_on_real_layers_with_stub_scorers(tmp_path):
    geo = geodata()
    counties = json.loads((EXPLORE_DIR / "counties_ca.geojson").read_text(encoding="utf-8"))["features"]
    art = _toy_artifact(tmp_path, tuple(f["properties"]["geoid"] for f in counties))

    def near_grid(X: pd.DataFrame) -> np.ndarray:  # stub: likes cells close to 220 kV+ lines
        return 1.0 / (1.0 + X["d_line_hv_km"].to_numpy() / 10.0)

    res = recommend({"solar": near_grid, "battery": near_grid}, art, "mid", 2035, geo, {"solar": 1.0, "battery": 0.5}, {"suitability": 1, "grid": 0.5, "queue": 0.3, "growth": 0.5}, spacing_km=20.0)
    total_need = 58 * 220 * 0.5  # every county's P90 peak grows 50%
    alloc = res["alloc"].groupby("tech")["mw"].sum()
    assert alloc["solar"] + sum(v for (r, t), v in res["unmet"].items() if t == "solar") == pytest.approx(total_need * 1.0, rel=1e-6)
    feats = res["geojson"]["features"]
    assert feats and all(f["properties"]["reason"] and f["properties"]["provenance"] == "ranked" for f in feats)
    assert np.median([f["properties"]["d_line_hv_km"] for f in feats]) < 20


def test_heuristic_scores_are_bounded_and_sensible(tmp_path):
    from ml.site_location.export_sites import heuristic_scores

    geo = _toy_geo()
    demand = demand_points(geo, _toy_artifact(tmp_path), "base", 2024)
    X = compute_features(np.array([10 * KM, 150 * KM, 190 * KM]), np.array([50 * KM, 95 * KM, 95 * KM]), geo, demand)
    s = heuristic_scores(X)
    for p in s.values():
        assert ((p >= 0) & (p <= 1)).all()
    assert s["solar"][0] > s["solar"][1]  # on the 230 kV line beats 45 km away
    assert s["gas"][0] > s["gas"][2]  # clean air + grid beats nonattainment + far
