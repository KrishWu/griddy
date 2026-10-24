"""Export the site artifact the website reads (ml/contract/site_artifact.py).  OWNER: workstream B.

    python -m ml.site_location.export_sites --run ml/site_location/runs/<run_id>   # trained models
    python -m ml.site_location.export_sites --heuristic                            # transparent score, no models

Scores every 5 km cell for each technology and stores the scores with the features the website's
live site selection needs (grid distances, county queue, demand growth nearby, resource, air quality).
The website then places any what-if demand growth on these cells (backend/app/sites).

The heuristic is a fixed, documented blend of the same features, so the site picker works before the
models are trained; replace it with --run once they are.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
from pathlib import Path

import numpy as np
import pandas as pd

from ml.contract.demand_artifact import BASE_SCENARIO, read_artifact
from ml.contract.site_artifact import SiteManifest, write_site_artifact
from ml.site_location.config import DEMAND_ARTIFACTS_DIR, GRID_SPACING_KM, SITE_ARTIFACTS_DIR, TECH_TO_KIND, TECHS
from ml.site_location.features import FEATURES, candidate_grid, compute_features, demand_points, radius_sum
from ml.site_location.geodata import geodata
from ml.site_location.recommend import county_region, growth_points

PROVENANCE = [
    {"kind": "observed", "source": "EIA-860 2024 operating plants (where each technology was built)", "url": "https://www.eia.gov/electricity/data/eia860/", "note": None},
    {"kind": "observed", "source": "CEC transmission lines (CC BY 4.0) and OpenStreetMap substations (ODbL)", "url": None, "note": "Distances to 220 kV+ lines and substations"},
    {"kind": "observed", "source": "ERA5 reanalysis via Open-Meteo: 2024 mean solar irradiance and 100 m wind", "url": "https://open-meteo.com/en/docs/historical-weather-api", "note": "0.5 degree grid, interpolated to 5 km cells"},
    {"kind": "observed", "source": "US EPA nonattainment areas (ozone, PM)", "url": "https://www.epa.gov/green-book", "note": "Air-permit risk for combustion plants"},
    {"kind": "observed", "source": "LBNL Queued Up 2026: active interconnection requests by county (CC BY 4.0)", "url": "https://emp.lbl.gov/queues", "note": "Congestion signal"},
    {"kind": "observed", "source": "US Census 2020 block-group population", "url": None, "note": None},
]


def heuristic_scores(X: pd.DataFrame) -> dict[str, np.ndarray]:
    """Transparent 0-1 scores per technology from the site features (no learning)."""
    grid = np.exp(-X["d_line_hv_km"].to_numpy() / 15.0)
    sub = np.exp(-X["d_sub_hv_km"].to_numpy() / 20.0)
    ghi = np.clip((X["ghi_kwh_m2_day"].to_numpy() - 4.5) / 1.5, 0, 1)
    wind = np.clip((X["wind100_ms"].to_numpy() - 4.0) / 4.0, 0, 1)
    crowd = np.clip(X["log_pop_10km"].to_numpy() / 12.0, 0, 1)
    dem = X["log_demand_150km_gwh"].to_numpy()
    dem = (dem - dem.min()) / max(dem.max() - dem.min(), 1e-9)
    clean_air = 1.0 - X["in_nonattainment"].to_numpy()
    return {
        "solar": 0.45 * grid + 0.35 * ghi + 0.20 * (1 - crowd),
        "wind": 0.40 * grid + 0.50 * wind + 0.10 * (1 - crowd),
        "battery": 0.50 * sub + 0.30 * grid + 0.20 * dem,
        "gas": 0.40 * grid + 0.30 * dem + 0.30 * clean_air,
    }


def model_scores(run: Path, X: pd.DataFrame) -> tuple[dict[str, np.ndarray], dict]:
    import xgboost as xgb

    spec = json.loads((run / "feature_spec.json").read_text(encoding="utf-8"))
    metrics = json.loads((run / "metrics.json").read_text(encoding="utf-8"))
    if spec["features"] != FEATURES:
        raise SystemExit(f"run {run.name} was trained on different features; retrain or check out its code")
    out = {}
    for tech in spec["techs"]:
        booster = xgb.Booster()
        booster.load_model(run / f"{tech}.ubj")
        booster.set_param({"device": "cpu"})
        out[tech] = booster.predict(xgb.DMatrix(X[FEATURES]))
    keep = ("spatial_cv_roc_auc", "spatial_cv_pr_auc", "positives")
    return out, {TECH_TO_KIND[t]: {k: m.get(k) for k in keep} for t, m in metrics.items()}


def latest_demand() -> Path:
    for kind in ("FORECAST", "BASELINE"):
        ptr = DEMAND_ARTIFACTS_DIR / f"LATEST_{kind}"
        if ptr.is_file():
            return DEMAND_ARTIFACTS_DIR / ptr.read_text(encoding="utf-8").strip()
    raise SystemExit(f"no demand artifact in {DEMAND_ARTIFACTS_DIR}: pull A's artifact or pass --demand <dir>")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--run", type=Path, help="ml/site_location/runs/<run_id>")
    src.add_argument("--heuristic", action="store_true")
    ap.add_argument("--demand", type=Path, default=None, help="demand artifact (default: LATEST_FORECAST, else LATEST_BASELINE)")
    ap.add_argument("--scenario", default="mid")
    ap.add_argument("--year", type=int, default=2035)
    ap.add_argument("--out", type=Path, default=None)
    args = ap.parse_args()

    art = read_artifact(args.demand or latest_demand(), load_hourly=False)
    forecast = art.manifest.kind == "forecast" and args.scenario in art.manifest.scenarios and args.year in art.manifest.years
    scenario, year = (args.scenario, args.year) if forecast else (BASE_SCENARIO, art.manifest.base_year)
    geo = geodata()
    grid = candidate_grid(geo, GRID_SPACING_KM)
    X = compute_features(grid["x"].to_numpy(), grid["y"].to_numpy(), geo, demand_points(geo, art, scenario, year))
    if forecast:
        gp = growth_points(geo, art, scenario, year)
        growth = radius_sum(grid["x"].to_numpy(), grid["y"].to_numpy(), gp["x"].to_numpy(), gp["y"].to_numpy(), gp["gwh"].to_numpy(), 150.0)
    else:
        growth = np.zeros(len(grid))

    if args.run:
        scores, metrics = model_scores(args.run, X)
        mode, producer = "model", {"package": "ml.site_location", "model_version": args.run.name}
    else:
        scores, metrics = heuristic_scores(X), {}
        mode, producer = "heuristic", {"package": "ml.site_location", "model_version": "heuristic-v1"}

    names = dict(zip(geo.counties["geoid"], geo.counties["name"]))
    cand = pd.DataFrame(
        {
            "cell": np.arange(len(grid)),
            "lon": grid["lon"].round(5),
            "lat": grid["lat"].round(5),
            "geoid": grid["geoid"].astype(str),
            "county": grid["geoid"].map(names),
            "region": grid["geoid"].map(county_region(art)),
            "d_line_hv_km": X["d_line_hv_km"].round(3),
            "d_sub_hv_km": X["d_sub_hv_km"].round(3),
            "queue_mw": grid["geoid"].map(geo.queue_mw).fillna(0.0).round(1),
            "growth_150km_gwh": np.round(growth, 2),
            "in_nonattainment": X["in_nonattainment"].astype(int),
            "ghi_kwh_m2_day": X["ghi_kwh_m2_day"].round(3),
            "wind100_ms": X["wind100_ms"].round(3),
        }
    )
    kinds = []
    for tech in TECHS:
        if tech in scores:
            cand[f"p_{TECH_TO_KIND[tech]}"] = np.clip(scores[tech], 0, 1).round(4)
            kinds.append(TECH_TO_KIND[tech])
    cand = cand.dropna(subset=["region", "county"]).reset_index(drop=True)

    stamp = dt.datetime.now(dt.UTC)
    artifact_id = f"sites-{mode}-{stamp:%Y%m%d-%H%M%S}"
    manifest = SiteManifest(
        artifact_id=artifact_id,
        mode=mode,
        created_utc=stamp.isoformat(timespec="seconds"),
        demand_artifact_id=art.manifest.artifact_id,
        scenario=scenario,
        year=int(year),
        kinds=kinds,
        grid_spacing_km=GRID_SPACING_KM,
        producer=producer,
        model_metrics=metrics,
        provenance=PROVENANCE,
    )
    path = write_site_artifact(args.out or SITE_ARTIFACTS_DIR / artifact_id, manifest, cand)
    if args.out is None:
        (SITE_ARTIFACTS_DIR / "LATEST").write_text(f"{artifact_id}\n", encoding="utf-8")
    print(f"{len(cand):,} candidate cells, kinds {kinds}, mode {mode}; wrote {path}")


if __name__ == "__main__":
    main()
