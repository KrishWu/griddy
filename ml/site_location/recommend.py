"""Where to build: rank sites for the forecast demand growth and pick a portfolio.  OWNER: workstream B.

    python -m ml.site_location.recommend --run ml/site_location/runs/<run_id> --scenario mid --year 2035
    python -m ml.site_location.recommend --run <run> --demand <forecast artifact dir> --portfolio '{"solar": 1.5, "battery": 1.0}'

1. Need. From A's forecast artifact: per region, the county P90 peak in the target year minus the
   base year (new peak load, incl. new data centers). The portfolio converts each MW of new peak
   into nameplate MW per technology (an explicit, editable assumption: solar's peak contribution
   is small, so it takes more nameplate than gas).
2. Suitability. The trained models score every 5 km cell with target-year demand features: the
   probability that a cell looks like the places such plants were actually built.
3. Selection. A linear program (HiGHS) places the nameplate need on cells in the same region,
   minimizing a weighted cost: low suitability, distance to a 220 kV+ line (gen-tie), how much
   capacity is already queued in the county (congestion), and distance from where demand grows.
   Unplaceable need shows up as unmet (slack), never as a silent failure.

Outputs: ml/artifacts/site_location/<id>/ recommended_sites.geojson (map-ready points), suitability.csv.gz
(every cell x tech), summary.json (need, allocation, unmet, assumptions, model metrics, caveats).
These are ranked screening candidates, not buildable sites: land, permits and interconnection capacity
need a utility study.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
from collections.abc import Callable
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.optimize import linprog

from ml.contract.demand_artifact import BASE_SCENARIO, DemandArtifact, read_artifact
from ml.site_location.config import ARTIFACTS_DIR, DEMAND_ARTIFACTS_DIR, GRID_SPACING_KM
from ml.site_location.features import FEATURES, candidate_grid, compute_features, demand_points, radius_sum
from ml.site_location.geodata import GeoData, geodata

# Nameplate MW per MW of new peak demand (assumption; override with --portfolio).
DEFAULT_PORTFOLIO = {"solar": 1.4, "battery": 0.8, "wind": 0.2, "gas": 0.3}
# Max nameplate per 5 km cell (25 km²), by technology (assumption: room for one large project per cell).
CELL_CAP_MW = {"solar": 300.0, "wind": 200.0, "battery": 400.0, "gas": 500.0}
DEFAULT_WEIGHTS = {"suitability": 1.0, "grid": 0.5, "queue": 0.3, "growth": 0.5}
CANDIDATES_PER_REGION_TECH = 200
UNMET_PENALTY = 100.0  # per MW: far above any real cell's cost, so slack is used only when cells run out

Scorer = Callable[[pd.DataFrame], np.ndarray]


def region_need(artifact: DemandArtifact, scenario: str, year: int) -> pd.Series:
    """New P90 peak (MW) per region: target year minus base year, floored at 0."""
    c = artifact.county
    key = ["geoid", "region"]
    fut = c[(c["scenario"] == scenario) & (c["year"] == year)].set_index(key)["peak_mw_p90"]
    if fut.empty:
        raise SystemExit(f"artifact has no rows for scenario={scenario!r} year={year}; it has {sorted(artifact.manifest.scenarios)} x {artifact.manifest.years}")
    base = c[(c["scenario"] == BASE_SCENARIO) & (c["year"] == artifact.manifest.base_year)].set_index(key)["peak_mw_p90"]
    growth = fut.sub(base.reindex(fut.index).fillna(0.0))
    return growth.groupby(level="region").sum().clip(lower=0.0)


def county_region(artifact: DemandArtifact) -> dict[str, str]:
    """Each county's main region: where most of its base-year energy is."""
    c = artifact.county
    base = c[(c["scenario"] == BASE_SCENARIO) & (c["year"] == artifact.manifest.base_year)]
    top = base.sort_values("annual_energy_mwh", ascending=False).drop_duplicates("geoid")
    return dict(zip(top["geoid"], top["region"]))


def growth_points(geo: GeoData, artifact: DemandArtifact, scenario: str, year: int) -> pd.DataFrame:
    """Block-group points carrying the county's demand *growth* (GWh/yr) to the target year."""
    fut = demand_points(geo, artifact, scenario, year)
    base = demand_points(geo, artifact, BASE_SCENARIO, artifact.manifest.base_year)
    return fut.assign(gwh=(fut["gwh"] - base["gwh"]).clip(lower=0.0))


def _norm(v: np.ndarray) -> np.ndarray:
    hi = np.nanmax(v) if len(v) else 0.0
    return v / hi if hi > 0 else np.zeros_like(v)


def build_candidates(grid: pd.DataFrame, scores: dict[str, np.ndarray], features: pd.DataFrame, geo: GeoData, regions: dict[str, str], growth_150: np.ndarray, weights: dict) -> pd.DataFrame:
    """One row per (cell, tech) with its cost; only the best CANDIDATES_PER_REGION_TECH per region and tech."""
    region = grid["geoid"].map(regions)
    queue = grid["geoid"].map(geo.queue_mw).fillna(0.0).to_numpy()
    grid_term = np.minimum(features["d_line_hv_km"].to_numpy(), 100.0) / 100.0
    rows = []
    for tech, p in scores.items():
        cost = (
            weights["suitability"] * (1.0 - p)
            + weights["grid"] * grid_term
            + weights["queue"] * _norm(queue)
            + weights["growth"] * (1.0 - _norm(growth_150))
        )
        rows.append(
            pd.DataFrame(
                {
                    "cell": np.arange(len(grid)),
                    "tech": tech,
                    "region": region.to_numpy(),
                    "geoid": grid["geoid"].to_numpy(),
                    "lon": grid["lon"].to_numpy(),
                    "lat": grid["lat"].to_numpy(),
                    "suitability": p,
                    "cost": cost,
                    "d_line_hv_km": features["d_line_hv_km"].to_numpy(),
                    "d_sub_hv_km": features["d_sub_hv_km"].to_numpy(),
                    "queue_mw": queue,
                    "growth_150km_gwh": growth_150,
                }
            )
        )
    cand = pd.concat(rows, ignore_index=True).dropna(subset=["region"])
    return cand.sort_values("cost").groupby(["region", "tech"], group_keys=False).head(CANDIDATES_PER_REGION_TECH).reset_index(drop=True)


def solve(cand: pd.DataFrame, need: dict[tuple[str, str], float], cell_cap: dict[str, float] = CELL_CAP_MW) -> tuple[pd.DataFrame, dict[tuple[str, str], float]]:
    """Place nameplate need[(region, tech)] on candidate cells at least total cost. Returns (allocations, unmet MW)."""
    keys = [k for k, v in need.items() if v > 0]
    n, m = len(cand), len(keys)
    c = np.r_[cand["cost"].to_numpy(), np.full(m, UNMET_PENALTY)]
    A = np.zeros((m, n + m))
    for j, (region, tech) in enumerate(keys):
        A[j, :n] = -((cand["region"] == region) & (cand["tech"] == tech)).to_numpy(dtype=float)
        A[j, n + j] = -1.0
    b = -np.array([need[k] for k in keys])
    bounds = [(0.0, cell_cap[t]) for t in cand["tech"]] + [(0.0, None)] * m
    res = linprog(c, A_ub=A if m else None, b_ub=b if m else None, bounds=bounds, method="highs")
    if res.status != 0:
        raise RuntimeError(f"site selection LP failed: {res.message}")
    alloc = cand.assign(mw=res.x[:n])
    unmet = {k: float(res.x[n + j]) for j, k in enumerate(keys)}
    return alloc[alloc["mw"] > 0.5].reset_index(drop=True), unmet


def _reason(r) -> str:
    parts = [f"{r.suitability:.0%} similar to where {r.tech} plants were built", f"{r.d_line_hv_km:.1f} km to a 220 kV+ line"]
    if r.queue_mw > 0:
        parts.append(f"{r.queue_mw / 1000:.1f} GW already queued in the county")
    parts.append(f"{r.growth_150km_gwh:,.0f} GWh/yr of new demand within 150 km")
    return "; ".join(parts)


def to_geojson(alloc: pd.DataFrame, county_names: dict[str, str]) -> dict:
    feats = []
    for r in alloc.itertuples(index=False):
        feats.append(
            {
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [round(r.lon, 5), round(r.lat, 5)]},
                "properties": {
                    "id": f"site-{r.tech}-{r.cell}",
                    "name": f"Candidate {r.tech} site, {county_names.get(r.geoid, r.geoid)} County",
                    "tech": r.tech,
                    "mw": round(float(r.mw), 1),
                    "region": r.region,
                    "county": county_names.get(r.geoid),
                    "suitability": round(float(r.suitability), 3),
                    "d_line_hv_km": round(float(r.d_line_hv_km), 2),
                    "d_sub_hv_km": round(float(r.d_sub_hv_km), 2),
                    "queue_mw": round(float(r.queue_mw), 1),
                    "growth_150km_gwh": round(float(r.growth_150km_gwh), 1),
                    "reason": _reason(r),
                    "provenance": "ranked",
                },
            }
        )
    return {"type": "FeatureCollection", "features": feats}


def recommend(
    scorers: dict[str, Scorer],
    artifact: DemandArtifact,
    scenario: str,
    year: int,
    geo: GeoData,
    portfolio: dict[str, float],
    weights: dict[str, float],
    spacing_km: float = GRID_SPACING_KM,
) -> dict:
    grid = candidate_grid(geo, spacing_km)
    X = compute_features(grid["x"].to_numpy(), grid["y"].to_numpy(), geo, demand_points(geo, artifact, scenario, year))
    scores = {tech: np.asarray(f(X[FEATURES]), dtype=float) for tech, f in scorers.items() if portfolio.get(tech, 0) > 0}
    gp = growth_points(geo, artifact, scenario, year)
    growth_150 = radius_sum(grid["x"].to_numpy(), grid["y"].to_numpy(), gp["x"].to_numpy(), gp["y"].to_numpy(), gp["gwh"].to_numpy(), 150.0)
    peak_need = region_need(artifact, scenario, year)
    need = {(r, t): float(peak_need.get(r, 0.0)) * share for r in peak_need.index for t, share in portfolio.items() if t in scores}
    cand = build_candidates(grid, scores, X, geo, county_region(artifact), growth_150, weights)
    alloc, unmet = solve(cand, need)
    county_names = dict(zip(geo.counties["geoid"], geo.counties["name"]))
    suit = grid[["lon", "lat", "geoid"]].assign(**{f"p_{t}": s for t, s in scores.items()})
    return {"alloc": alloc, "unmet": unmet, "peak_need": peak_need, "need": need, "geojson": to_geojson(alloc, county_names), "suitability": suit}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--run", type=Path, required=True, help="ml/site_location/runs/<run_id>")
    ap.add_argument("--demand", type=Path, default=None, help="forecast artifact (default: LATEST_FORECAST)")
    ap.add_argument("--scenario", default="mid")
    ap.add_argument("--year", type=int, default=2035)
    ap.add_argument("--portfolio", type=json.loads, default=DEFAULT_PORTFOLIO, help="nameplate MW per MW of new peak, by tech (JSON)")
    ap.add_argument("--weights", type=json.loads, default=DEFAULT_WEIGHTS, help="cost weights (JSON)")
    ap.add_argument("--out", type=Path, default=None)
    args = ap.parse_args()

    import xgboost as xgb

    if args.demand is None:
        ptr = DEMAND_ARTIFACTS_DIR / "LATEST_FORECAST"
        if not ptr.is_file():
            raise SystemExit("no forecast artifact yet (LATEST_FORECAST missing): pass --demand <dir> or wait for A's export")
        args.demand = DEMAND_ARTIFACTS_DIR / ptr.read_text(encoding="utf-8").strip()
    artifact = read_artifact(args.demand, load_hourly=False)
    if artifact.manifest.kind != "forecast":
        raise SystemExit("recommendations need a forecast artifact (a baseline has no future years)")
    spec = json.loads((args.run / "feature_spec.json").read_text(encoding="utf-8"))
    metrics = json.loads((args.run / "metrics.json").read_text(encoding="utf-8"))
    weights = {**DEFAULT_WEIGHTS, **args.weights}

    def scorer(tech: str) -> Scorer:
        booster = xgb.Booster()
        booster.load_model(args.run / f"{tech}.ubj")
        booster.set_param({"device": "cpu"})
        return lambda X: booster.predict(xgb.DMatrix(X[spec["features"]]))

    scorers = {t: scorer(t) for t in spec["techs"]}
    res = recommend(scorers, artifact, args.scenario, args.year, geodata(), args.portfolio, weights)

    stamp = dt.datetime.now(dt.UTC)
    out = args.out or ARTIFACTS_DIR / f"sites-{args.scenario}-{args.year}-{stamp:%Y%m%d-%H%M%S}"
    out.mkdir(parents=True, exist_ok=True)
    (out / "recommended_sites.geojson").write_text(json.dumps(res["geojson"], separators=(",", ":")), encoding="utf-8")
    res["suitability"].round(4).to_csv(out / "suitability.csv.gz", index=False, compression="gzip")
    alloc = res["alloc"]
    summary = {
        "created_utc": stamp.isoformat(timespec="seconds"),
        "scenario": args.scenario,
        "year": args.year,
        "demand_artifact": artifact.manifest.artifact_id,
        "scenario_assumptions": artifact.manifest.scenarios.get(args.scenario),
        "model_run": args.run.name,
        "model_metrics": {t: {k: m[k] for k in ("spatial_cv_roc_auc", "spatial_cv_pr_auc", "positives")} for t, m in metrics.items()},
        "new_peak_mw_p90_by_region": {r: round(v, 1) for r, v in res["peak_need"].items()},
        "portfolio_nameplate_per_mw_peak": args.portfolio,
        "weights": weights,
        "allocated_mw": {f"{r}/{t}": round(float(v), 1) for (r, t), v in alloc.groupby(["region", "tech"])["mw"].sum().items()},
        "unmet_mw": {f"{r}/{t}": round(v, 1) for (r, t), v in res["unmet"].items() if v > 0.5},
        "sites": len(alloc),
        "caveats": [
            "Suitability = similarity to where plants of that type were built (EIA-860), not a feasibility study.",
            "Land use, zoning, habitat and interconnection capacity are not modeled: every site needs a utility study.",
            "Portfolio and cost weights are assumptions; change them with --portfolio and --weights.",
        ],
    }
    (out / "summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(json.dumps({k: summary[k] for k in ("new_peak_mw_p90_by_region", "allocated_mw", "unmet_mw", "sites")}, indent=2))
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
