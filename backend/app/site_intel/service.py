"""Satellite + environmental site screening.  OWNER: workstream E (Site Intelligence).

site_intel(location) answers "is this land and this air shed a good place to build?"
for the 2 km buffer around a site: land cover, fallowed vs active farmland, slope,
protected land, surface water and solar resource (land.py), a satellite overlay
(imagery.py), and air quality + nonattainment status (air.py). Each part prefers the
committed offline data for the demo areas, then the runtime cache, then live Earth
Engine / AirNow when their keys are set, and it never raises: a missing key or a slow
API becomes a finding, so the core map -> build -> simulate flow never depends on it.

site_findings(scenario, sim, evaluation) adds the result-dependent findings
(AIR_PERMIT_RISK, carbon-aware shifting) to every /api/run from cached data only.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Callable
from concurrent.futures import Future, ThreadPoolExecutor
from typing import Any, TypeVar

from app.contract import EvaluationResult, Finding, LngLat, MapOverlay, Provenance, Scenario, SimulationResult, SiteIntel
from app.site_intel import air, carbon, imagery, land
from app.site_intel.config import BUFFER_KM, key_center, site_key
from app.site_intel.earthengine import status as ee_status
from app.site_intel.geo import circle_feature
from app.site_intel.screening import land_findings

log = logging.getLogger(__name__)
T = TypeVar("T")

DEADLINE_S = 30.0  # whole request; each source also has its own shorter timeout
_pool = ThreadPoolExecutor(max_workers=6, thread_name_prefix="site-intel")
_SEVERITY_ORDER = {"fail": 0, "warn": 1, "pass": 2, "info": 3}

LAND_TIER_NOTE = {
    "offline_area": "Precomputed screening grid for this demo area (committed offline data, 0.01 deg cells)",
    "cache": "Cached Google Earth Engine result for this site",
    "earth_engine": "Live Google Earth Engine",
}


def _finding(id_: str, severity: str, title: str, detail: str) -> Finding:
    return Finding(id=id_, module="site", severity=severity, title=title, detail=detail)  # type: ignore[arg-type]


def _wait(fut: Future[T], deadline: float, default: T, what: str) -> T:
    try:
        return fut.result(timeout=max(0.1, deadline - time.monotonic()))
    except Exception:  # noqa: BLE001 - one slow or broken source must not take the others down
        log.exception("site_intel: %s failed", what)
        return default


def site_intel(location: LngLat) -> SiteIntel:
    try:
        return _site_intel(location)
    except Exception as exc:  # noqa: BLE001 - sponsor integrations never break a click on the map
        log.exception("site_intel failed")
        return SiteIntel(
            location=location,
            findings=[_finding("site_intel_error", "warn", "Site screening unavailable", str(exc)[:200])],
            provenance=[Provenance(kind="assumption", source="Griddy site screening (error fallback)")],
        )


def _site_intel(loc: LngLat) -> SiteIntel:
    deadline = time.monotonic() + DEADLINE_S
    f_land = _pool.submit(land.get_land_stats, loc)
    f_img = _pool.submit(imagery.imagery_overlays, loc)
    f_air = _pool.submit(air.air_context, loc)
    stats, tier = _wait(f_land, deadline, (None, "unavailable"), "land screening")
    overlays, img_prov, img_findings = _wait(f_img, deadline, ([], [], []), "imagery")
    ctx = _wait(f_air, deadline, None, "air quality")

    findings: list[Finding] = []
    provenance: list[Provenance] = []
    extras: dict[str, Any] = {"site_key": site_key(loc), "buffer_km": BUFFER_KM, "land_tier": tier, "earth_engine": ee_status()}

    if stats is not None:
        # Land is screened for the 0.01 deg cell center (the cache key), not the exact click.
        center = key_center(site_key(loc))
        extras |= {
            "screened_center": center.model_dump(),
            "fallow_share": stats.fallow_share,
            "active_crop_share": stats.active_crop_share,
            "protected_share": stats.protected_share,
            "water_share": stats.water_share,
            "cdl_year": stats.cdl_year,
            "land_method": stats.method,
            "land_computed_at": stats.computed_at,
        }
        findings += land_findings(stats)
        provenance += stats.sources
        provenance.append(Provenance(kind="inferred", source="Griddy screening thresholds (app/site_intel/screening.py)", note=LAND_TIER_NOTE.get(tier)))
        overlays = [*overlays, _buffer_overlay(center)]
    else:
        findings.append(
            _finding(
                "land_screening_unavailable",
                "warn",
                "Satellite screening unavailable here",
                "No offline screening covers this site and Earth Engine isn't configured (EE_PROJECT). "
                "Click inside a demo area (Kern, Tracy or Los Banos) or set up Earth Engine.",
            )
        )

    findings += img_findings
    provenance += img_prov
    if ctx is not None:
        findings += air.air_findings(ctx)
        provenance += ctx.provenance
        extras["nonattainment"] = ctx.nonattainment
    else:
        findings.append(_finding("air_quality_unavailable", "info", "Air quality unavailable", "AirNow data could not be loaded for this site."))

    findings.sort(key=lambda f: _SEVERITY_ORDER.get(f.severity, 9))
    return SiteIntel(
        location=loc,
        land_cover=stats.land_cover if stats else {},
        mean_slope_deg=stats.mean_slope_deg if stats else None,
        solar_ghi_kwh_m2_day=stats.solar_ghi_kwh_m2_day if stats else None,
        air_quality=air.air_quality_dict(ctx) if ctx is not None else None,
        overlays=overlays,
        findings=findings,
        provenance=provenance,
        extras=extras,
    )


def _buffer_overlay(center: LngLat) -> MapOverlay:
    fc = {"type": "FeatureCollection", "features": [circle_feature(center, BUFFER_KM, {"label": f"{BUFFER_KM:g} km screening buffer"})]}
    return MapOverlay(id="site-buffer", label=f"{BUFFER_KM:g} km screening buffer", type="geojson", data=fc, opacity=0.5)


def site_findings(scenario: Scenario, sim: SimulationResult, evaluation: EvaluationResult) -> list[Finding]:
    """Findings that need the scenario's results, appended to every /api/run and /api/compare.

    Cached data only (no network): AIR_PERMIT_RISK when on-site gas adds NOx in a
    nonattainment area, and the carbon-aware saving when the demand has a flexible share.
    """
    checks: list[Callable[[], list[Finding]]] = [
        lambda: [f] if (f := air.air_permit_risk(scenario, sim, evaluation)) else [],
        lambda: carbon.carbon_findings(scenario, sim),
    ]
    out: list[Finding] = []
    for check in checks:
        try:
            out += check()
        except Exception:  # noqa: BLE001 - one broken check must not hide the others
            log.exception("site_findings check failed")
    return out
