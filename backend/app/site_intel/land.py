"""Land screening of the 2 km buffer around a site, from Google Earth Engine.  OWNER: workstream E.

get_land_stats(loc) answers from, in order: the committed demo-area grid
(data/site_intel/areas/*.json, built by prep/land.py), the runtime cache of earlier
Earth Engine answers, then live Earth Engine. It never raises.

One Earth Engine round trip computes everything in screening.LandStats:
  ESA WorldCover v200 (2021, 10 m) class shares
  USDA NASS CDL (latest year) fallowed (61) vs actively cultivated shares
  USGS 3DEP 10 m mean slope
  WDPA protected-area share, JRC Global Surface Water share (occurrence >= 50%)
  ERA5-Land 2024 mean daily solar radiation (GHI)
"""

from __future__ import annotations

import json
import logging
import threading
from datetime import date
from pathlib import Path
from typing import Any

from app.contract import LngLat, Provenance
from app.site_intel import earthengine
from app.site_intel.config import AREAS, BUFFER_KM, CACHE, key_center, site_key
from app.site_intel.screening import CDL_ACTIVE, CDL_FALLOW, WORLDCOVER, LandStats

log = logging.getLogger(__name__)

LAND_CACHE = CACHE / "land"
LAND_TIMEOUT_S = 15.0
CATALOG = "https://developers.google.com/earth-engine/datasets/catalog/"
GHI_YEAR = 2024

SOURCES = [
    Provenance(kind="observed", source="ESA WorldCover 10 m v200 (2021) via Google Earth Engine", url=CATALOG + "ESA_WorldCover_v200"),
    Provenance(kind="observed", source="USDA NASS Cropland Data Layer via Google Earth Engine", url=CATALOG + "USDA_NASS_CDL"),
    Provenance(kind="observed", source="USGS 3DEP 10 m DEM via Google Earth Engine (slope)", url=CATALOG + "USGS_3DEP_10m_collection"),
    Provenance(kind="observed", source="WDPA protected areas (UNEP-WCMC & IUCN) via Google Earth Engine", url=CATALOG + "WCMC_WDPA_current_polygons"),
    Provenance(kind="observed", source="JRC Global Surface Water v1.4 via Google Earth Engine", url=CATALOG + "JRC_GSW1_4_GlobalSurfaceWater"),
    Provenance(
        kind="observed",
        source=f"ERA5-Land daily solar radiation {GHI_YEAR} via Google Earth Engine",
        url=CATALOG + "ECMWF_ERA5_LAND_DAILY_AGGR",
        note="Mean of daily surface_solar_radiation_downwards_sum at the site, as kWh/m2/day",
    ),
]


# ---------------------------------------------------------------------------
# Earth Engine
# ---------------------------------------------------------------------------


def ee_dictionary(ee: Any, loc: LngLat, buffer_km: float = BUFFER_KM) -> Any:
    """Server-side ee.Dictionary of every raw statistic; .getInfo() is the single round trip."""
    pt = ee.Geometry.Point([loc.lon, loc.lat])
    buf = pt.buffer(buffer_km * 1000, 1)
    mean = ee.Reducer.mean()
    hist = ee.Reducer.frequencyHistogram()

    def reduce(img: Any, reducer: Any, scale: float) -> Any:
        return img.reduceRegion(reducer=reducer, geometry=buf, scale=scale, maxPixels=1e9)

    worldcover = ee.ImageCollection("ESA/WorldCover/v200").first().select(["Map"], ["v"])
    cdl = ee.ImageCollection("USDA/NASS/CDL").filterBounds(pt).sort("system:time_start", False).first()
    # A mosaic has no native projection; give it the tiles' so slope is computed at 10 m, not 1 deg.
    dem_tiles = ee.ImageCollection("USGS/3DEP/10m_collection").filterBounds(buf).select("elevation")
    dem = dem_tiles.mosaic().setDefaultProjection(dem_tiles.first().projection())
    wdpa = (
        ee.FeatureCollection("WCMC/WDPA/current/polygons")
        .filterBounds(buf)
        .filter(ee.Filter.neq("STATUS", "Proposed"))
        .filter(ee.Filter.neq("REALM", "Marine"))
    )
    protected = ee.Image.constant(0).byte().paint(wdpa, 1).rename("v")  # painting dissolves overlaps
    water = ee.Image("JRC/GSW1_4/GlobalSurfaceWater").select("occurrence").unmask(0).gte(50).rename("v")
    ghi = (
        ee.ImageCollection("ECMWF/ERA5_LAND/DAILY_AGGR")
        .filterDate(f"{GHI_YEAR}-01-01", f"{GHI_YEAR + 1}-01-01")
        .select(["surface_solar_radiation_downwards_sum"], ["v"])
        .mean()
    )
    return ee.Dictionary(
        {
            "worldcover": reduce(worldcover, hist, 10).get("v"),
            "cdl": reduce(cdl.select(["cropland"], ["v"]), hist, 30).get("v"),
            "cdl_year": ee.Date(cdl.get("system:time_start")).get("year"),
            "slope": reduce(ee.Terrain.slope(dem).rename("v"), mean, 10).get("v"),
            "protected": reduce(protected, mean, 30).get("v"),
            "water": reduce(water, mean, 30).get("v"),
            "ghi_j_m2_day": ghi.reduceRegion(reducer=mean, geometry=pt, scale=11132).get("v"),
        }
    )


def _shares(hist: dict[str, float] | None) -> dict[int, float]:
    total = sum((hist or {}).values())
    return {int(float(k)): v / total for k, v in (hist or {}).items()} if total else {}


def stats_from_raw(raw: dict[str, Any], buffer_km: float = BUFFER_KM) -> LandStats:
    """Turn the getInfo() dictionary into LandStats (pure, so it is unit-testable)."""
    wc = _shares(raw.get("worldcover"))
    cdl = _shares(raw.get("cdl"))

    def num(key: str, scale: float = 1.0) -> float | None:
        v = raw.get(key)
        return round(float(v) * scale, 4) if isinstance(v, (int, float)) else None

    return LandStats(
        land_cover={WORLDCOVER[k]: round(v, 4) for k, v in sorted(wc.items(), key=lambda kv: -kv[1]) if k in WORLDCOVER},
        mean_slope_deg=num("slope"),
        fallow_share=round(cdl.get(CDL_FALLOW, 0.0), 4) if cdl else None,
        active_crop_share=round(sum(v for k, v in cdl.items() if k in CDL_ACTIVE), 4) if cdl else None,
        protected_share=num("protected"),
        water_share=num("water"),
        solar_ghi_kwh_m2_day=num("ghi_j_m2_day", 1 / 3.6e6),
        cdl_year=int(raw["cdl_year"]) if isinstance(raw.get("cdl_year"), (int, float)) else None,
        buffer_km=buffer_km,
        method="earth_engine",
        computed_at=date.today().isoformat(),
        sources=SOURCES,
    )


def land_stats_ee(loc: LngLat, buffer_km: float = BUFFER_KM) -> LandStats:
    """Live Earth Engine screening. Raises earthengine.EEUnavailable on any failure."""
    ee = earthengine.get_ee()
    if ee is None:
        raise earthengine.EEUnavailable("Earth Engine not configured")
    raw = earthengine.run(lambda: ee_dictionary(ee, loc, buffer_km).getInfo(), timeout=LAND_TIMEOUT_S)
    return stats_from_raw(raw, buffer_km)


# ---------------------------------------------------------------------------
# Committed demo-area grids + runtime cache
# ---------------------------------------------------------------------------

_areas_lock = threading.Lock()
_areas: tuple[tuple, dict[str, LandStats]] | None = None


def _load_areas() -> dict[str, LandStats]:
    """site_key -> LandStats over every committed area file (re-read when the files change)."""
    global _areas
    files = sorted(AREAS.glob("*.json")) if AREAS.is_dir() else []
    stamp = tuple((f.name, f.stat().st_mtime_ns) for f in files)
    with _areas_lock:
        if _areas is not None and _areas[0] == stamp:
            return _areas[1]
        cells: dict[str, LandStats] = {}
        for f in files:
            try:
                area = json.loads(f.read_text(encoding="utf-8"))
                sources = [Provenance.model_validate(p) for p in area.get("sources", [])]
                for key, cell in area["cells"].items():
                    cells[key] = LandStats.model_validate({**cell, "sources": sources})
            except (OSError, ValueError, KeyError, TypeError) as exc:
                log.warning("ignoring unreadable area file %s: %s", f.name, exc)
        _areas = (stamp, cells)
        return cells


def load_area_cell(loc: LngLat) -> LandStats | None:
    return _load_areas().get(site_key(loc))


def _cache_file(loc: LngLat) -> Path:
    return LAND_CACHE / f"{site_key(loc).replace(',', '_')}.json"


def _read_cache(loc: LngLat) -> LandStats | None:
    try:
        return LandStats.model_validate_json(_cache_file(loc).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _write_cache(loc: LngLat, stats: LandStats) -> None:
    try:
        path = _cache_file(loc)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(stats.model_dump_json(), encoding="utf-8")
    except OSError as exc:
        log.warning("could not cache land stats: %s", exc)


def get_land_stats(loc: LngLat) -> tuple[LandStats | None, str]:
    """(stats, tier) with tier in offline_area | cache | earth_engine | unavailable. Never raises."""
    try:
        if (cell := load_area_cell(loc)) is not None:
            return cell, "offline_area"
        if (cached := _read_cache(loc)) is not None:
            return cached, "cache"
        if earthengine.get_ee() is not None:
            # Screen the cell center (what the cache key names), so every click in the cell agrees.
            stats = land_stats_ee(key_center(site_key(loc)))
            _write_cache(loc, stats)
            return stats, "earth_engine"
    except Exception as exc:  # noqa: BLE001 - EEUnavailable, malformed EE output, disk errors
        log.warning("land screening unavailable: %s", exc)
    return None, "unavailable"
