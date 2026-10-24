"""Model signals for the GriddyGrade: B's site artifact and A's demand forecast.  OWNER: workstream E.

ml_context(location) answers three questions the rule-based grade can't, from artifacts
already committed under ml/artifacts/ (read-only, no network, a few ms):

  - How congested is the interconnection queue? The county's active requests (queue_mw,
    LBNL Queued Up), from the nearest 5 km cell of B's site artifact.
  - Could clean supply be built nearby? The best solar, wind and battery suitability among
    cells within 25 km. Gas is left out: its scores are optimistic and mostly repeat the
    grid-distance signal. The cell's in_nonattainment flag is not used either (E already
    scores EPA designations), nor its line / substation distances (A's summary has them).
  - How much demand pressure is the region under? A's forecast ("mid", 2035) for the cell's
    region and county, P50 first: the P10-P90 band covered only about half of actual hours
    in testing (the runbook asks for 0.6-0.95), so P90 values are too narrow.

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

from app.contract import Finding, ForecastRequest, LngLat, Provenance
from app.ml_bridge import latest

log = logging.getLogger(__name__)

MAX_CELL_KM = 5.0  # a California point is at most ~3.5 km from a 5 km cell center
CLEAN_RADIUS_KM = 25.0
CLEAN_KINDS = ("solar_pv", "onshore_wind", "battery")
FORECAST_SCENARIO, FORECAST_YEAR = "mid", 2035
QUEUE_HIGH_MW = 10_000  # a county queue this large gets a needs_utility_study finding
QUEUED_UP_URL = "https://emp.lbl.gov/queues"
EARTH_KM = 6371.0088


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
    geoid: np.ndarray
    region: np.ndarray
    queue_mw: np.ndarray
    p: dict[str, np.ndarray]


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
        geoid=c["geoid"].astype(str).to_numpy(),
        region=c["region"].astype(str).to_numpy(),
        queue_mw=c["queue_mw"].to_numpy(float),
        p={k: c[f"p_{k}"].to_numpy(float) for k in CLEAN_KINDS if k in m.kinds},
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


def _r(v: float, nd: int = 3) -> float:
    return round(float(v), nd)


def _forecast(region: str, geoid: str) -> dict[str, Any] | None:
    """A's forecast for the cell's region and county: P50 first, P90 only with its caveat."""
    from app.forecast.service import forecast

    f = forecast(ForecastRequest(scenario=FORECAST_SCENARIO, year=FORECAST_YEAR))
    if not f.available:
        return None
    reg = next((r for r in f.regions if r.region == region), None)
    county = next((c for c in f.counties if c.geoid == geoid), None)
    base = reg.trajectory[0] if reg and reg.trajectory else None
    if reg is None or base is None or not base.get("peak_mw_p50"):
        return None
    metrics = f.metrics or {}
    return {
        "artifact_id": f.artifact_id,
        "mode": f.mode,
        "scenario": f.scenario,
        "year": f.year,
        "base_year": f.base_year,
        "region": {
            "id": reg.region,
            "name": reg.name,
            "base_peak_mw_p50": _r(base["peak_mw_p50"], 1),
            "peak_mw_p50": _r(reg.peak_mw_p50, 1),
            "peak_mw_p90": _r(reg.peak_mw_p90, 1),
        },
        "county": {"geoid": county.geoid, "name": county.county, "peak_mw_p50": _r(county.peak_mw_p50, 1)} if county else None,
        "metrics": {k: metrics.get(k) for k in ("mape_p50_pct", "p10_p90_coverage", "split") if k in metrics},
    }


def ml_context(loc: LngLat) -> dict[str, Any]:
    """extras["ml"] for a site. available is False (with a reason) when the signals don't apply."""
    t = _table()
    if t is None:
        return {"available": False, "reason": "site-location artifact not found"}
    km = _km(t, loc)
    i = int(np.argmin(km))
    if km[i] > MAX_CELL_KM:
        return {"available": False, "reason": f"no {t.spacing_km:g} km grid cell within {MAX_CELL_KM:g} km (outside California)"}

    near = km <= CLEAN_RADIUS_KM
    clean: dict[str, Any] = {"radius_km": CLEAN_RADIUS_KM}
    for kind, p in t.p.items():
        j = int(np.argmax(np.where(near, p, -1.0)))
        clean[kind] = {"best": _r(p[j]), "distance_km": _r(km[j], 1), "lon": _r(t.lon[j], 4), "lat": _r(t.lat[j], 4)}

    try:
        demand = _forecast(str(t.region[i]), str(t.geoid[i]))
    except Exception:  # noqa: BLE001 - the forecast is context; the other signals still apply
        log.exception("demand forecast unavailable for the GriddyGrade")
        demand = None

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
            "geoid": str(t.geoid[i]),
            "region": str(t.region[i]),
        },
        "queue_mw": _r(t.queue_mw[i], 1),
        "clean_build": clean,
        "forecast": demand,
    }


def ml_provenance(ctx: dict[str, Any]) -> list[Provenance]:
    if not ctx.get("available"):
        return []
    art = ctx["site_artifact"]
    auc = " · ".join(f"{k.replace('_', ' ')} {v['roc_auc']:.2f}" for k, v in art["model_metrics"].items())
    out = [
        Provenance(
            kind="observed",
            source="LBNL Queued Up: active interconnection requests by county",
            url=QUEUED_UP_URL,
            note=f"County total, read from B's site artifact {art['id']}",
        ),
        Provenance(
            kind="inferred",
            source=f"Griddy site-location model (B), {art['id']}",
            note=f"Clean-build similarity: how much nearby cells look like where solar, wind and batteries were built (spatial-CV ROC-AUC {auc}). A similarity score, not feasibility.",
        ),
    ]
    if (f := ctx.get("forecast")) is not None:
        m = f.get("metrics") or {}
        acc = f"P50 MAPE {m['mape_p50_pct']:.1f}%" if isinstance(m.get("mape_p50_pct"), (int, float)) else "accuracy not reported"
        cov = f"; the P10-P90 band covered {m['p10_p90_coverage']:.0%} of test hours (target 60-95%), so P90 is too narrow" if isinstance(m.get("p10_p90_coverage"), (int, float)) else ""
        out.append(
            Provenance(
                kind="inferred",
                source=f"Griddy demand forecast (A), {f['artifact_id']}",
                note=f"Scenario '{f['scenario']}', {f['year']}, P50: {acc}{cov}. A scenario, not a prediction.",
            )
        )
    return out


def ml_findings(ctx: dict[str, Any]) -> list[Finding]:
    if not ctx.get("available"):
        return []
    q, county = ctx["queue_mw"], ctx["cell"]["county"]
    if q < QUEUE_HIGH_MW:
        return []
    return [
        Finding(
            id="interconnection_queue_congested",
            module="site",
            severity="warn",
            title="Congested interconnection queue",
            detail=(
                f"{county} County has {q:,.0f} MW of active interconnection requests (LBNL Queued Up). "
                "New large loads here are likely to wait on cluster studies and network upgrades: "
                "ask the utility for a large-load interconnection study early."
            ),
            metric=q,
            threshold=QUEUE_HIGH_MW,
            needs_utility_study=True,
        )
    ]
