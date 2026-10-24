"""Model signals for the power plant GriddyGrade: B's site-location artifact.  OWNER: workstream E.

ml_context(location) reads the site's own 5 km cell of B's site artifact (ml/site_location,
committed under ml/artifacts/; read-only, no network, a few ms) for two things the rule-based
grade can't compute itself:

  - Siting similarity per technology (site_cell.suitability): the trained model's probability
    that the cell resembles where operating plants of that technology were built (EIA-860, 5 MW
    and up, online since 2000): solar_pv, onshore_wind, battery, gas_cc (all gas plants). The
    grade scores it as an inferred submetric of the technology's resource prerequisites.
  - The cell's annual solar and wind resource (site_cell.resource): ERA5 reanalysis 2024 means
    from the Open-Meteo archive, sampled on a 0.5 degree grid and interpolated to the 5 km cells
    (ml/site_location/fetch_resource.py). resource_basis says so, so the grade can check that a
    value is compatible with its reference range before scoring it.

Plus the county's active interconnection requests (queue_mw, LBNL Queued Up), shown as context.
The cell's grid distances, population and nonattainment flag are not passed on: A's summary and
E's EPA layer have them, so nothing is read twice.

The result goes in SiteIntel.extras["ml"]; the browser maps it onto the grade
(feasibilityInput.ts), so this needs no contract change and no new request.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any

import numpy as np

from app.contract import Finding, LngLat, Provenance
from app.ml_bridge import latest

log = logging.getLogger(__name__)

MAX_CELL_KM = 5.0  # a California point is at most ~3.5 km from a 5 km cell center
QUEUE_HIGH_MW = 10_000  # a county queue this large gets a needs_utility_study finding
QUEUED_UP_URL = "https://emp.lbl.gov/queues"
EARTH_KM = 6371.0088
# How B's resource columns were made (ml/site_location/fetch_resource.py: STEP_DEG, the default
# --year and the Open-Meteo variables it asks for). Update with a re-fetch.
RESOURCE_BASIS = {
    "source": "ERA5 reanalysis via the Open-Meteo archive",
    "url": "https://open-meteo.com/en/docs/historical-weather-api",
    "period": "2024",
    "years": 1,
    "grid_deg": 0.5,
    "grid_km": 50.0,  # 0.5 degree is ~45-55 km in California; the IDW to 5 km cells adds no detail
    "ghi_unit": "kWh/m2/day",
    "wind_height_m": 100,
    "wind_unit": "m/s",
}


@dataclass(frozen=True)
class _Table:
    """One site artifact as numpy arrays, so a lookup is a few vector operations."""

    artifact_id: str
    mode: str
    scenario: str
    year: int
    spacing_km: float
    metrics: dict[str, Any]
    lon: np.ndarray
    lat: np.ndarray
    cell: np.ndarray
    county: np.ndarray
    queue_mw: np.ndarray
    ghi: np.ndarray | None
    wind100: np.ndarray | None
    p: dict[str, np.ndarray]


def _col(c, name: str) -> np.ndarray | None:
    return c[name].to_numpy(float) if name in c.columns else None


@lru_cache(maxsize=2)
def _load(path: str, mtime: float) -> _Table:
    from ml.contract.site_artifact import read_site_artifact

    art = read_site_artifact(path)
    c, m = art.candidates, art.manifest
    return _Table(
        artifact_id=m.artifact_id,
        mode=m.mode,
        scenario=m.scenario,
        year=int(m.year),
        spacing_km=float(m.grid_spacing_km),
        metrics=dict(m.model_metrics),
        lon=c["lon"].to_numpy(float),
        lat=c["lat"].to_numpy(float),
        cell=c["cell"].to_numpy(int),
        county=c["county"].astype(str).to_numpy(),
        queue_mw=c["queue_mw"].to_numpy(float),
        ghi=_col(c, "ghi_kwh_m2_day"),
        wind100=_col(c, "wind100_ms"),
        p={k: c[f"p_{k}"].to_numpy(float) for k in m.kinds if f"p_{k}" in c.columns},
    )


def _table() -> _Table | None:
    path = latest("site_location", "LATEST")
    if path is None:
        return None
    try:
        return _load(str(path), (Path(path) / "manifest.json").stat().st_mtime)
    except Exception:  # noqa: BLE001 - a broken artifact must not break a click on the map
        log.exception("site artifact %s is unreadable", path)
        return None


def _km(t: _Table, loc: LngLat) -> np.ndarray:
    """Great-circle km from the point to every cell center."""
    lat0, lon0 = np.radians(loc.lat), np.radians(loc.lon)
    lat, lon = np.radians(t.lat), np.radians(t.lon)
    a = np.sin((lat - lat0) / 2) ** 2 + np.cos(lat0) * np.cos(lat) * np.sin((lon - lon0) / 2) ** 2
    return 2 * EARTH_KM * np.arcsin(np.sqrt(np.clip(a, 0.0, 1.0)))


def _r(v: float, nd: int = 3) -> float | None:
    v = float(v)
    return round(v, nd) if np.isfinite(v) else None


def ml_context(loc: LngLat) -> dict[str, Any]:
    """extras["ml"] for a site. available is False (with a reason) when the signals don't apply."""
    t = _table()
    if t is None:
        return {"available": False, "reason": "site-location artifact not found"}
    km = _km(t, loc)
    i = int(np.argmin(km))
    if km[i] > MAX_CELL_KM:
        return {"available": False, "reason": f"no {t.spacing_km:g} km grid cell within {MAX_CELL_KM:g} km (outside California)"}

    resource = {
        "ghi_kwh_m2_day": _r(t.ghi[i]) if t.ghi is not None else None,
        "wind100_ms": _r(t.wind100[i]) if t.wind100 is not None else None,
    }
    return {
        "available": True,
        "site_artifact": {
            "id": t.artifact_id,
            "mode": t.mode,
            "scenario": t.scenario,
            "year": t.year,
            "grid_spacing_km": t.spacing_km,
            "model_metrics": {
                k: {"roc_auc": _r(v["spatial_cv_roc_auc"]), "pr_auc": _r(v["spatial_cv_pr_auc"]) if "spatial_cv_pr_auc" in v else None}
                for k, v in t.metrics.items()
                if k in t.p and isinstance(v, dict) and "spatial_cv_roc_auc" in v
            },
        },
        "cell": {
            "id": int(t.cell[i]),
            "lon": _r(t.lon[i], 4),
            "lat": _r(t.lat[i], 4),
            "distance_km": _r(km[i], 2),
            "county": str(t.county[i]),
        },
        "site_cell": {
            "suitability": {k: _r(p[i], 4) for k, p in t.p.items()},
            "resource": resource,
        },
        "resource_basis": RESOURCE_BASIS,
        "queue_mw": _r(t.queue_mw[i], 1),
    }


def ml_provenance(ctx: dict[str, Any]) -> list[Provenance]:
    if not ctx.get("available"):
        return []
    art = ctx["site_artifact"]
    auc = " · ".join(f"{k.replace('_', ' ')} {v['roc_auc']:.2f}" for k, v in art["model_metrics"].items())
    b = ctx.get("resource_basis") or RESOURCE_BASIS
    return [
        Provenance(
            kind="observed",
            source="LBNL Queued Up: active interconnection requests by county",
            url=QUEUED_UP_URL,
            note=f"County total, read from B's site artifact {art['id']}",
        ),
        Provenance(
            kind="inferred",
            source=f"Griddy site-location model (B), {art['id']}",
            note=(
                f"Siting similarity: how much the site's 5 km cell resembles where solar, wind, battery and gas plants were built "
                f"(spatial-CV ROC-AUC {auc}). A similarity score, not a resource measurement or a feasibility finding."
            ),
        ),
        Provenance(
            kind="observed",
            source=f"{b['source']}: {b['period']} mean solar irradiance and {b['wind_height_m']} m wind",
            url=b.get("url"),
            note=f"{b['grid_deg']} degree grid interpolated to 5 km cells (ml/site_location); one year, not a long-term mean.",
        ),
    ]


def ml_findings(ctx: dict[str, Any]) -> list[Finding]:
    if not ctx.get("available"):
        return []
    q, county = ctx["queue_mw"], ctx["cell"]["county"]
    if q is None or q < QUEUE_HIGH_MW:
        return []
    return [
        Finding(
            id="interconnection_queue_congested",
            module="site",
            severity="warn",
            title="Congested interconnection queue",
            detail=(
                f"{county} County has {q:,.0f} MW of active interconnection requests (LBNL Queued Up). "
                "New projects here are likely to wait on cluster studies and network upgrades, and queued "
                "projects compete for the same transmission headroom: ask the utility for an interconnection study early."
            ),
            metric=q,
            threshold=QUEUE_HIGH_MW,
            needs_utility_study=True,
        )
    ]
