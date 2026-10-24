"""Labelled siting data: where each technology was actually built vs. where it wasn't.  OWNER: workstream B.

Positives: operating EIA-860 plants of the technology (>= MIN_PLANT_MW, online since MIN_FIRST_YEAR).
Negatives: candidate grid cells with no plant of that technology within NEGATIVE_EXCLUSION_KM, sampled
NEGATIVES_PER_POSITIVE per positive. This is revealed preference: the model learns what sites
developers chose look like (grid access, people, demand nearby). It is not a ground-truth
"optimal site" label, and grid built *for* a plant can make that plant's site look better than it was.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd
from scipy.spatial import cKDTree

from ml.site_location.config import MIN_FIRST_YEAR, MIN_PLANT_MW, NEGATIVE_EXCLUSION_KM, NEGATIVES_PER_POSITIVE, SPATIAL_BLOCK_KM
from ml.site_location.features import compute_features
from ml.site_location.geodata import GeoData


@dataclass
class TrainingSet:
    X: pd.DataFrame
    y: np.ndarray
    groups: np.ndarray  # spatial block id per row
    meta: pd.DataFrame  # x, y, label, plant id/name (positives)


def positives(geo: GeoData, tech: str) -> pd.DataFrame:
    p = geo.plants
    first = pd.to_numeric(p["first_year"], errors="coerce")
    return p[(p["fuel"] == tech) & (p["capacity_mw"] >= MIN_PLANT_MW) & (first >= MIN_FIRST_YEAR)].reset_index(drop=True)


def spatial_blocks(x: np.ndarray, y: np.ndarray, block_km: float = SPATIAL_BLOCK_KM) -> np.ndarray:
    b = block_km * 1000.0
    return (np.floor(x / b).astype(np.int64) * 100_000 + np.floor(y / b).astype(np.int64)).astype(np.int64)


def build_training_set(geo: GeoData, grid: pd.DataFrame, grid_features: pd.DataFrame, demand: pd.DataFrame, tech: str, seed: int = 7) -> TrainingSet:
    pos = positives(geo, tech)
    if len(pos) < 20:
        raise ValueError(f"only {len(pos)} {tech} plants qualify: too few to learn from")
    same_tech = geo.plants[geo.plants["fuel"] == tech]
    d_same = cKDTree(same_tech[["x", "y"]].to_numpy()).query(grid[["x", "y"]].to_numpy())[0] / 1000.0
    pool = np.flatnonzero(d_same > NEGATIVE_EXCLUSION_KM)
    n_neg = min(len(pool), NEGATIVES_PER_POSITIVE * len(pos))
    neg_idx = np.random.default_rng(seed).choice(pool, size=n_neg, replace=False)

    Xp = compute_features(pos["x"].to_numpy(), pos["y"].to_numpy(), geo, demand)
    Xn = grid_features.iloc[neg_idx].reset_index(drop=True)
    X = pd.concat([Xp, Xn], ignore_index=True)
    y = np.r_[np.ones(len(Xp)), np.zeros(len(Xn))]
    mx = np.r_[pos["x"].to_numpy(), grid["x"].to_numpy()[neg_idx]]
    my = np.r_[pos["y"].to_numpy(), grid["y"].to_numpy()[neg_idx]]
    meta = pd.DataFrame({"x": mx, "y": my, "label": y, "plant_id": list(pos["id"]) + [None] * n_neg, "name": list(pos["name"]) + [None] * n_neg})
    return TrainingSet(X=X, y=y, groups=spatial_blocks(mx, my), meta=meta)
