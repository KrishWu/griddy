"""GriddyGrade: the site-location model's projected data center feasibility score.  OWNER: workstream B (Phase 2).

The site artifact (ml/site_location) gives every 5 km cell in California the trained models'
suitability for each technology, p_<kind>: how much the cell looks like places where solar, wind,
battery and gas plants were actually built (grid access, resource, nearby demand growth on A's
forecast, interconnection-queue congestion, air quality). A data center campus needs power it can
build or buy nearby, so its feasibility signal is the mean suitability across the scored kinds.

Score = percentile rank of that suitability among all cells, scaled to 1-100 with one decimal: the
best cell in California scores 100, the worst 1. A clicked point takes the inverse-distance mean of
the cells within 1.5 grid spacings, so the score moves smoothly; points farther than COVERAGE_SPACINGS
grid spacings from any cell (offshore, out of state) are outside the model's coverage and get no score.
"Projected" because the nearby-demand features use the forecast year in the artifact manifest.
Screening only: no substitute for an interconnection study.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np

from app.contract import LngLat, Model, Provenance
from app.sites.service import KIND_LABEL, _site_artifact

NEIGHBOR_SPACINGS = 1.5  # cells within this many grid spacings feed a clicked point (IDW)
COVERAGE_SPACINGS = 2.0  # beyond this from the nearest cell, the model has no opinion
KM_PER_DEG_LAT = 110.57
KM_PER_DEG_LON_EQ = 111.32
DRIVERS = {
    "d_line_hv_km": ("Nearest 220 kV+ line", "km"),
    "d_sub_hv_km": ("Nearest 220 kV+ substation", "km"),
    "queue_mw": ("County interconnection queue", "MW"),
    "growth_150km_gwh": ("New demand within 150 km", "GWh/yr"),
    "ghi_kwh_m2_day": ("Solar resource", "kWh/m²/day"),
    "wind100_ms": ("Wind at 100 m", "m/s"),
    "in_nonattainment": ("In an EPA nonattainment area", ""),
}


class GradeDriver(Model):
    key: str
    label: str
    value: float
    unit: str


class SiteGrade(Model):
    """What GET /api/sites/grade returns. score is None when unavailable or outside coverage."""

    location: LngLat
    available: bool
    in_coverage: bool
    score: float | None = None
    percentile: float | None = None
    rank: int | None = None
    n_cells: int = 0
    suitability: dict[str, float] = {}
    composite: float | None = None
    nearest_cell_km: float | None = None
    cells_used: int = 0
    county: str | None = None
    drivers: list[GradeDriver] = []
    model: dict[str, Any] = {}
    method: str = ""
    note: str | None = None
    provenance: list[Provenance] = []


@dataclass(frozen=True)
class _Index:
    lon: np.ndarray
    lat: np.ndarray
    p: np.ndarray  # cells x kinds
    composite: np.ndarray
    sorted_comp: np.ndarray
    lo_mid: float
    hi_mid: float
    features: dict[str, np.ndarray]
    county: np.ndarray
    kinds: tuple[str, ...]
    spacing_km: float
    manifest: Any


_cache: dict[int, _Index] = {}


def _index() -> _Index | None:
    art = _site_artifact()
    if art is None:
        return None
    hit = _cache.get(id(art))
    if hit is not None:
        return hit
    c, m = art.candidates, art.manifest
    kinds = tuple(m.kinds)
    p = c[[f"p_{k}" for k in kinds]].to_numpy(float)
    comp = p.mean(axis=1)
    s = np.sort(comp)
    idx = _Index(
        lon=c["lon"].to_numpy(float),
        lat=c["lat"].to_numpy(float),
        p=p,
        composite=comp,
        sorted_comp=s,
        lo_mid=_midrank(s, s[0]),
        hi_mid=_midrank(s, s[-1]),
        features={k: c[k].to_numpy(float) for k in DRIVERS},
        county=c["county"].astype(str).to_numpy(),
        kinds=kinds,
        spacing_km=float(m.grid_spacing_km),
        manifest=m,
    )
    _cache.clear()  # one artifact at a time; a new export replaces the old index
    _cache[id(art)] = idx
    return idx


def _midrank(sorted_vals: np.ndarray, x: float) -> float:
    """Rank of x among sorted_vals, ties sharing the middle rank (0-based)."""
    lo = np.searchsorted(sorted_vals, x, side="left")
    hi = np.searchsorted(sorted_vals, x, side="right")
    return (lo + hi - 1) / 2.0


def score_from_composite(idx: _Index, x: float) -> tuple[float, float, int]:
    """(score 1-100 one decimal, percentile 0-100 of cells strictly below, rank 1 = best)."""
    mid = _midrank(idx.sorted_comp, x)
    span = idx.hi_mid - idx.lo_mid
    frac = (mid - idx.lo_mid) / span if span > 0 else 1.0
    score = round(1.0 + 99.0 * min(1.0, max(0.0, frac)), 1)
    n = len(idx.sorted_comp)
    below = int(np.searchsorted(idx.sorted_comp, x, side="left"))
    rank = n - int(np.searchsorted(idx.sorted_comp, x, side="right")) + 1
    return score, round(100.0 * below / n, 1), rank


def _provenance(m) -> list[Provenance]:
    out = [Provenance(**p) for p in (m.provenance or []) if isinstance(p, dict)]
    auc = ", ".join(f"{KIND_LABEL.get(k, k)} {v.get('spatial_cv_roc_auc', float('nan')):.2f}" for k, v in (m.model_metrics or {}).items())
    out.insert(
        0,
        Provenance(
            kind="simulated",
            source=f"Griddy site-location model {m.producer.get('model_version', m.artifact_id)} ({m.mode}), {m.scenario} demand {m.year}",
            note=f"Spatial-CV ROC-AUC: {auc}" if auc else None,
        ),
    )
    return out


def grade(location: LngLat) -> SiteGrade:
    idx = _index()
    if idx is None:
        return SiteGrade(location=location, available=False, in_coverage=False, note="Site-location model artifact unavailable.")
    m = idx.manifest
    model = {
        "artifact_id": m.artifact_id,
        "mode": m.mode,
        "scenario": m.scenario,
        "year": m.year,
        "model_version": m.producer.get("model_version"),
        "roc_auc": {k: v.get("spatial_cv_roc_auc") for k, v in (m.model_metrics or {}).items()},
    }
    method = (
        f"Mean of the model's {', '.join(KIND_LABEL.get(k, k) for k in idx.kinds)} suitability, ranked against all "
        f"{len(idx.composite):,} California cells ({idx.spacing_km:g} km grid): 100 = best cell, 1 = worst."
    )
    kx = KM_PER_DEG_LON_EQ * np.cos(np.radians(location.lat))
    d = np.hypot((idx.lon - location.lon) * kx, (idx.lat - location.lat) * KM_PER_DEG_LAT)
    nearest = int(d.argmin())
    common = dict(location=location, available=True, n_cells=len(idx.composite), model=model, method=method, provenance=_provenance(m))
    if d[nearest] > COVERAGE_SPACINGS * idx.spacing_km:
        return SiteGrade(
            **common,
            in_coverage=False,
            nearest_cell_km=round(float(d[nearest]), 1),
            note=f"Outside the model's California coverage (nearest scored cell {d[nearest]:.0f} km away).",
        )

    near = np.flatnonzero(d <= NEIGHBOR_SPACINGS * idx.spacing_km)
    if near.size == 0:
        near = np.array([nearest])
    w = 1.0 / np.maximum(d[near], 0.25) ** 2  # inverse-distance weights; a point on a cell centre is that cell
    w /= w.sum()
    p = w @ idx.p[near]
    comp = float(p.mean())
    score, pct, rank = score_from_composite(idx, comp)
    drivers = []
    for key, (label, unit) in DRIVERS.items():
        v = idx.features[key][near]
        val = float(v[np.argmax(w)]) if key == "in_nonattainment" else float(w @ v)
        drivers.append(GradeDriver(key=key, label=label, value=round(val, 2), unit=unit))
    return SiteGrade(
        **common,
        in_coverage=True,
        score=score,
        percentile=pct,
        rank=rank,
        suitability={k: round(float(v), 4) for k, v in zip(idx.kinds, p)},
        composite=round(comp, 5),
        nearest_cell_km=round(float(d[nearest]), 2),
        cells_used=int(near.size),
        county=str(idx.county[nearest]),
        drivers=drivers,
    )


def clear_cache() -> None:
    _cache.clear()
