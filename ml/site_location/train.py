"""Train the per-technology siting models on GPU.  OWNER: workstream B.

    python -m ml.site_location.train                         # CUDA, demand from LATEST_BASELINE (or LATEST_FORECAST)
    python -m ml.site_location.train --demand <artifact dir> --device cpu
    python -m ml.site_location.train --dry-run               # build features + labels, no training

One XGBoost classifier per technology (solar, wind, battery, gas). Validation is spatial:
5-fold GroupKFold over 50 km blocks, so a test site never has a training neighbour next
door. Reports out-of-fold ROC-AUC, PR-AUC and precision in the top 10% of scored cells,
then fits the final model on all rows. Training needs only the demand artifact's BASE year,
so it can run on a baseline artifact before A's forecast exists.

Outputs: ml/site_location/runs/<run_id>/
    <tech>.ubj       one model per technology      metrics.json   spatial-CV scores + feature importance
    feature_spec.json  features, demand artifact used, params
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import subprocess
import time
from pathlib import Path

import numpy as np
import pandas as pd

from ml.contract.demand_artifact import BASE_SCENARIO, read_artifact
from ml.site_location.config import CV_FOLDS, DEMAND_ARTIFACTS_DIR, GRID_SPACING_KM, RUNS_DIR, TECHS
from ml.site_location.dataset import build_training_set
from ml.site_location.features import FEATURES, candidate_grid, compute_features, demand_points
from ml.site_location.geodata import geodata

PARAMS = {
    "objective": "binary:logistic",
    "eval_metric": ["aucpr", "auc"],
    "tree_method": "hist",
    "max_depth": 5,
    "learning_rate": 0.05,
    "min_child_weight": 5,
    "subsample": 0.8,
    "colsample_bytree": 0.8,
    "lambda": 2.0,
    "seed": 7,
}
NUM_ROUNDS = 500


def latest_demand_artifact(kind_order=("BASELINE", "FORECAST")) -> Path:
    for kind in kind_order:
        ptr = DEMAND_ARTIFACTS_DIR / f"LATEST_{kind}"
        if ptr.is_file():
            return DEMAND_ARTIFACTS_DIR / ptr.read_text(encoding="utf-8").strip()
    raise SystemExit(f"no demand artifact in {DEMAND_ARTIFACTS_DIR}: pull A's artifact or pass --demand <dir>")


def check_device(device: str) -> None:
    import xgboost as xgb

    if device.startswith("cuda") and not xgb.build_info().get("USE_CUDA"):
        raise SystemExit("This xgboost build has no CUDA support. Install the official wheel (pip install xgboost) or pass --device cpu.")


def precision_at_top(y: np.ndarray, p: np.ndarray, frac: float = 0.1) -> float:
    k = max(1, int(len(p) * frac))
    return float(y[np.argsort(-p)[:k]].mean())


def train_tech(ts, params: dict, rounds: int):
    import xgboost as xgb
    from sklearn.metrics import average_precision_score, roc_auc_score
    from sklearn.model_selection import GroupKFold

    pos_weight = float((ts.y == 0).sum() / max(1, (ts.y == 1).sum()))
    p = {**params, "scale_pos_weight": pos_weight}
    oof = np.zeros(len(ts.y))
    for tr, te in GroupKFold(n_splits=CV_FOLDS).split(ts.X, ts.y, ts.groups):
        booster = xgb.train(p, xgb.DMatrix(ts.X.iloc[tr], ts.y[tr]), num_boost_round=rounds)
        oof[te] = booster.predict(xgb.DMatrix(ts.X.iloc[te]))
    metrics = {
        "positives": int(ts.y.sum()),
        "negatives": int((ts.y == 0).sum()),
        "spatial_cv_roc_auc": float(roc_auc_score(ts.y, oof)),
        "spatial_cv_pr_auc": float(average_precision_score(ts.y, oof)),
        "base_rate": float(ts.y.mean()),
        "precision_top10pct": precision_at_top(ts.y, oof),
    }
    final = xgb.train(p, xgb.DMatrix(ts.X, ts.y), num_boost_round=rounds)
    gain = final.get_score(importance_type="gain")
    total = sum(gain.values()) or 1.0
    metrics["feature_gain_share"] = {f: round(gain.get(f, 0.0) / total, 4) for f in FEATURES}
    return final, metrics


def git_sha() -> str | None:
    try:
        return subprocess.run(["git", "rev-parse", "--short", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return None


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--device", default="cuda", help='"cuda", "cuda:1", or "cpu"')
    ap.add_argument("--demand", type=Path, default=None, help="demand artifact directory (default: LATEST_BASELINE, else LATEST_FORECAST)")
    ap.add_argument("--techs", nargs="+", default=list(TECHS), choices=TECHS)
    ap.add_argument("--rounds", type=int, default=NUM_ROUNDS)
    ap.add_argument("--run-id", default=None)
    ap.add_argument("--dry-run", action="store_true", help="build features and labels; do not train")
    args = ap.parse_args()

    art_dir = args.demand or latest_demand_artifact()
    artifact = read_artifact(art_dir, load_hourly=False)
    base_year = artifact.manifest.base_year
    geo = geodata()
    t0 = time.time()
    grid = candidate_grid(geo, GRID_SPACING_KM)
    demand = demand_points(geo, artifact, BASE_SCENARIO, base_year)
    grid_X = compute_features(grid["x"].to_numpy(), grid["y"].to_numpy(), geo, demand)
    print(f"demand artifact {artifact.manifest.artifact_id} (base year {base_year}); {len(grid):,} candidate cells; features in {time.time() - t0:.0f} s")

    sets = {tech: build_training_set(geo, grid, grid_X, demand, tech) for tech in args.techs}
    for tech, ts in sets.items():
        print(f"{tech:8s} {int(ts.y.sum()):4d} positives, {int((ts.y == 0).sum()):5d} negatives, {len(np.unique(ts.groups))} spatial blocks")
    if args.dry_run:
        print("dry run: data is ready; not training")
        return

    import xgboost as xgb

    check_device(args.device)
    run_id = args.run_id or f"sites-{dt.datetime.now(dt.UTC):%Y%m%d-%H%M%S}"
    out = RUNS_DIR / run_id
    out.mkdir(parents=True, exist_ok=False)
    params = {**PARAMS, "device": args.device}
    metrics = {}
    for tech, ts in sets.items():
        t = time.time()
        model, m = train_tech(ts, params, args.rounds)
        m["train_seconds"] = round(time.time() - t, 1)
        model.save_model(out / f"{tech}.ubj")
        metrics[tech] = m
        print(f"{tech:8s} spatial-CV ROC-AUC {m['spatial_cv_roc_auc']:.3f}  PR-AUC {m['spatial_cv_pr_auc']:.3f} (base rate {m['base_rate']:.3f})")
    spec = {
        "features": FEATURES,
        "techs": list(sets),
        "demand_artifact": artifact.manifest.artifact_id,
        "demand_base_year": base_year,
        "grid_spacing_km": GRID_SPACING_KM,
        "params": params,
        "rounds": args.rounds,
        "xgboost": xgb.__version__,
        "git_sha": git_sha(),
    }
    (out / "feature_spec.json").write_text(json.dumps(spec, indent=2), encoding="utf-8")
    (out / "metrics.json").write_text(json.dumps(metrics, indent=2), encoding="utf-8")
    pd.concat({t: s.meta for t, s in sets.items()}, names=["tech"]).to_csv(out / "training_rows.csv.gz", compression="gzip")
    print(f"saved {out}")


if __name__ == "__main__":
    main()
