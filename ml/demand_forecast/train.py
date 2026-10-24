"""Train the hourly demand-shape model on GPU.  OWNER: workstream A.

    python -m ml.demand_forecast.train                    # CUDA (default)
    python -m ml.demand_forecast.train --device cpu       # any machine, slower
    python -m ml.demand_forecast.train --dry-run          # build + check the data, no training

Model: one XGBoost booster with a multi-quantile objective (P10/P50/P90) over all seven
regions (region is a categorical feature), ~400k hourly rows. Split by time, never at
random: train < VALID_YEAR, early-stop on VALID_YEAR, and report accuracy on
>= TEST_FROM_YEAR, which the model never sees. A naive climatology baseline (mean shape
by region x month x weekday/weekend x hour from the training years) is scored on the same
rows, so the metrics say how much the weather-aware model actually adds.

Outputs: ml/demand_forecast/runs/<run_id>/
    model.ubj            the booster          feature_spec.json   features, categories, quantiles, best iteration
    metrics.json         held-out accuracy    region_base.json    base-year observed load per region (the level)
    region_geo.json      county shares + weather points used
"""

from __future__ import annotations

import argparse
import calendar
import datetime as dt
import json
import subprocess
import time

import numpy as np
import pandas as pd

from ml.demand_forecast.config import BASE_YEAR, QUANTILES, RUNS_DIR, TEST_FROM_YEAR, VALID_YEAR
from ml.demand_forecast.dataset import FEATURES, REGION_IDS, TARGET, build_training_frame, load_eia930, load_weather
from ml.demand_forecast.geo import region_geo

PARAMS = {
    "objective": "reg:quantileerror",
    "quantile_alpha": list(QUANTILES),
    "tree_method": "hist",
    "max_depth": 8,
    "learning_rate": 0.05,
    "min_child_weight": 20,
    "subsample": 0.8,
    "colsample_bytree": 0.8,
    "max_bin": 256,
    "max_cat_to_onehot": 16,
    "seed": 7,
}
NUM_ROUNDS = 4000
EARLY_STOP = 200


def git_sha() -> str | None:
    try:
        return subprocess.run(["git", "rev-parse", "--short", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return None


def check_device(device: str) -> None:
    import xgboost as xgb

    if device.startswith("cuda") and not xgb.build_info().get("USE_CUDA"):
        raise SystemExit("This xgboost build has no CUDA support. Install the official wheel (pip install xgboost) or pass --device cpu.")


def split(frame: pd.DataFrame, valid_year: int, test_from: int) -> dict[str, pd.DataFrame]:
    return {
        "train": frame[frame["year"] < valid_year],
        "valid": frame[frame["year"] == valid_year],
        "test": frame[frame["year"] >= test_from],
    }


CLIM_KEYS = ["region", "month", "is_weekend", "hour"]


def climatology(train: pd.DataFrame) -> pd.Series:
    """Naive baseline: mean ratio by region, month, weekend flag and hour over the training years."""
    return train.astype({"region": str}).groupby(CLIM_KEYS)[TARGET].mean()


def predict_climatology(clim: pd.Series, df: pd.DataFrame) -> np.ndarray:
    keys = pd.MultiIndex.from_frame(df[CLIM_KEYS].astype({"region": str}))
    return clim.reindex(keys).to_numpy()


def score(df: pd.DataFrame, pred: np.ndarray, base: np.ndarray) -> dict:
    """Accuracy in MW (ratio x the region-year mean). pred: (n, 3) quantiles; base: (n,) climatology."""
    scale = df["year_mean_mw"].to_numpy()
    actual = df["demand_mw"].to_numpy()
    p10, p50, p90 = (pred[:, i] * scale for i in range(3))
    naive = base * scale
    out = {
        "rows": int(len(df)),
        "mape_p50_pct": float(np.mean(np.abs(p50 - actual) / actual) * 100),
        "mae_p50_mw": float(np.mean(np.abs(p50 - actual))),
        "mape_climatology_pct": float(np.nanmean(np.abs(naive - actual) / actual) * 100),
        "p10_p90_coverage": float(np.mean((actual >= p10) & (actual <= p90))),
        "pinball": {str(q): float(np.mean(np.maximum(q * (actual - v), (q - 1) * (actual - v)))) for q, v in zip(QUANTILES, (p10, p50, p90))},
    }
    peaks = []
    for (_, _), g in df.assign(p50=p50).groupby(["region", df["ts_pst"].dt.to_period("M")], observed=True):
        peaks.append(abs(g["p50"].max() - g["demand_mw"].max()) / g["demand_mw"].max())
    out["monthly_peak_error_pct"] = float(np.mean(peaks) * 100) if peaks else None
    by_region = {}
    for region, g in df.assign(p50=p50).groupby("region", observed=True):
        by_region[str(region)] = float(np.mean(np.abs(g["p50"] - g["demand_mw"]) / g["demand_mw"]) * 100)
    out["mape_p50_pct_by_region"] = by_region
    return out


def region_base(load: pd.DataFrame, base_year: int) -> dict:
    """Observed base-year level per region: the anchor that scenario growth scales."""
    df = load.assign(year=(load["ts_utc"] - pd.Timedelta(hours=8)).dt.year)
    df = df[df["year"] == base_year]
    hours = 8784 if calendar.isleap(base_year) else 8760
    out = {}
    for region, g in df.groupby("region"):
        mean = float(g["demand_mw"].mean())
        out[str(region)] = {
            "base_year": base_year,
            "mean_mw": mean,
            "annual_energy_mwh": mean * hours,
            "observed_peak_mw": float(g["demand_mw"].max()),
            "coverage": float(g["demand_mw"].notna().sum() / hours),
        }
    missing = set(REGION_IDS) - set(out)
    if missing:
        raise SystemExit(f"no {base_year} load for regions {sorted(missing)}: fetch EIA-930 for {base_year}")
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--device", default="cuda", help='"cuda", "cuda:1", or "cpu"')
    ap.add_argument("--run-id", default=None)
    ap.add_argument("--valid-year", type=int, default=VALID_YEAR)
    ap.add_argument("--test-from", type=int, default=TEST_FROM_YEAR)
    ap.add_argument("--base-year", type=int, default=BASE_YEAR)
    ap.add_argument("--rounds", type=int, default=NUM_ROUNDS)
    ap.add_argument("--dry-run", action="store_true", help="build the dataset and report the splits; do not train")
    args = ap.parse_args()

    geo = region_geo()
    load = load_eia930()
    frame = build_training_frame(load, load_weather(geo))
    parts = split(frame, args.valid_year, args.test_from)
    for name, part in parts.items():
        years = sorted(part["year"].unique().tolist())
        print(f"{name:5s}: {len(part):>8,} rows, years {years}, regions {sorted(part['region'].astype(str).unique())}")
    if parts["train"].empty or parts["valid"].empty:
        raise SystemExit("train/valid split is empty: fetch more EIA-930 years")
    if args.dry_run:
        print("dry run: data is ready; not training")
        return

    import xgboost as xgb

    check_device(args.device)
    run_id = args.run_id or f"demand-{dt.datetime.now(dt.UTC):%Y%m%d-%H%M%S}"
    out = RUNS_DIR / run_id
    out.mkdir(parents=True, exist_ok=False)

    params = {**PARAMS, "device": args.device}
    X = {k: v[FEATURES] for k, v in parts.items()}
    dtrain = xgb.QuantileDMatrix(X["train"], parts["train"][TARGET], enable_categorical=True, max_bin=PARAMS["max_bin"])
    dvalid = xgb.QuantileDMatrix(X["valid"], parts["valid"][TARGET], ref=dtrain, enable_categorical=True)
    t0 = time.time()
    booster = xgb.train(
        params, dtrain, num_boost_round=args.rounds, evals=[(dtrain, "train"), (dvalid, "valid")], early_stopping_rounds=EARLY_STOP, verbose_eval=100
    )
    train_s = time.time() - t0
    best = int(booster.best_iteration)

    def predict(df: pd.DataFrame) -> np.ndarray:
        p = booster.predict(xgb.DMatrix(df[FEATURES], enable_categorical=True), iteration_range=(0, best + 1))
        return np.sort(np.clip(p, 0.0, None), axis=1)  # quantiles must not cross

    clim = climatology(parts["train"])
    metrics = {"device": args.device, "train_seconds": round(train_s, 1), "best_iteration": best}
    for name in ("valid", "test"):
        if not parts[name].empty:
            metrics[name] = score(parts[name], predict(parts[name]), predict_climatology(clim, parts[name]))
    if "test" not in metrics:
        print(f"note: no data >= {args.test_from}; validation metrics only (they were used for early stopping)")

    booster.save_model(out / "model.ubj")
    spec = {
        "features": FEATURES,
        "region_categories": REGION_IDS,
        "quantiles": list(QUANTILES),
        "best_iteration": best,
        "train_years": sorted(parts["train"]["year"].unique().tolist()),
        "valid_year": args.valid_year,
        "trend_year_max": int(frame["year"].max()),
        "params": params,
        "xgboost": xgb.__version__,
        "git_sha": git_sha(),
    }
    (out / "feature_spec.json").write_text(json.dumps(spec, indent=2), encoding="utf-8")
    (out / "metrics.json").write_text(json.dumps(metrics, indent=2), encoding="utf-8")
    (out / "region_base.json").write_text(json.dumps(region_base(load, args.base_year), indent=2), encoding="utf-8")
    (out / "region_geo.json").write_text(json.dumps(geo.to_json(), indent=1), encoding="utf-8")
    print(json.dumps({k: v for k, v in metrics.items() if k != "valid"}, indent=2))
    print(f"saved {out}")


if __name__ == "__main__":
    main()
