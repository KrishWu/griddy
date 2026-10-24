"""GriddyGrade: the site-location model's projected data center feasibility score.  OWNER: workstream B (Phase 2).

The site artifact (ml/site_location) gives every 5 km cell in California the trained models'
suitability for each technology, p_<kind>: how much the cell looks like places where solar, wind,
battery and gas plants were actually built (grid access, resource, nearby demand growth on A's
forecast, interconnection-queue congestion, air quality). A data center campus needs power it can
build or buy nearby, so its feasibility signal is the mean suitability across the scored kinds.

Score = percentile rank of that suitability among all cells, scaled to 1-100 with one decimal: the
best cell in California scores 100, the worst 1. A clicked point takes the inverse-distance mean of
the cells within 1.5 grid spacings, so the score moves smoothly (a click on a cell centre is that
cell). Only points inside California (Census county outlines, A's data/explore/counties_ca.geojson)
are scored; a California point farther than COVERAGE_SPACINGS grid spacings from any cell sits in a
county the artifact has no cells for yet, and says so.
"Projected" because the nearby-demand features use the forecast year in the artifact manifest.
Screening only: no substitute for an interconnection study.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from functools import lru_cache
from typing import Any

import numpy as np

from app import DATA_DIR
from app.contract import LngLat, Model, Provenance
from app.sites.service import KIND_LABEL, _site_artifact

log = logging.getLogger(__name__)

NEIGHBOR_SPACINGS = 1.5  # cells within this many grid spacings feed a clicked point (IDW)
COVERAGE_SPACINGS = 2.0  # beyond this from the nearest cell, the model has no opinion
CELL_SNAP_KM = 0.25  # a click this close to a cell centre is that cell
COUNTIES_PATH = DATA_DIR / "explore" / "counties_ca.geojson"
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


@lru_cache(maxsize=1)
def _counties():
    """California county outlines (A's Census boundaries), prepared for point lookups; None if missing."""
    try:
        from shapely import prepare
        from shapely.geometry import shape
        from shapely.strtree import STRtree

        feats = json.loads(COUNTIES_PATH.read_text(encoding="utf-8"))["features"]
        geoms = [shape(f["geometry"]) for f in feats]
        for g in geoms:
            prepare(g)
        return STRtree(geoms), geoms, [f["properties"].get("name") for f in feats]
    except Exception:  # noqa: BLE001 - without outlines, fall back to distance-only coverage
        log.exception("county outlines unavailable; GriddyGrade coverage falls back to distance only")
        return None


def county_at(location: LngLat) -> tuple[bool | None, str | None]:
    """(inside California?, county name). (None, None) when the outlines can't be read."""
    c = _counties()
    if c is None:
        return None, None
    from shapely.geometry import Point

    tree, geoms, names = c
    pt = Point(location.lon, location.lat)
    for i in tree.query(pt):
        if geoms[int(i)].covers(pt):
            return True, names[int(i)]
    return False, None


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
    above = n - int(np.searchsorted(idx.sorted_comp, x, side="right"))
    pct = np.floor(1000.0 * below / n) / 10.0  # floored: never claims 100.0% short of the top cell
    return score, float(pct), above + 1


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
    in_ca, county = county_at(location)
    if in_ca is False:
        return SiteGrade(
            **common,
            in_coverage=False,
            nearest_cell_km=round(float(d[nearest]), 1),
            note="Outside California: the site-location model covers California only.",
        )
    if d[nearest] > COVERAGE_SPACINGS * idx.spacing_km:
        where = f"{county} County" if county else "this area"
        return SiteGrade(
            **common,
            in_coverage=False,
            nearest_cell_km=round(float(d[nearest]), 1),
            county=county,
            note=f"The site-location model has no cells for {where} yet (nearest scored cell {d[nearest]:.0f} km away).",
        )

    if d[nearest] <= CELL_SNAP_KM:
        near = np.array([nearest])  # on a cell centre: that cell's own score, rank and percentile
    else:
        near = np.flatnonzero(d <= NEIGHBOR_SPACINGS * idx.spacing_km)
        if near.size == 0:
            near = np.array([nearest])
    w = 1.0 / np.maximum(d[near], CELL_SNAP_KM) ** 2  # inverse-distance weights
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
        county=county or str(idx.county[nearest]),
        drivers=drivers,
    )


def clear_cache() -> None:
    _cache.clear()
