"""Satellite imagery overlay: live Earth Engine Sentinel-2 tiles, else cached offline tiles.  OWNER: workstream E.

Live (EE_PROJECT set): a May-Sep 2024 Sentinel-2 L2A median composite, SCL cloud-masked,
clipped to a 5 km box around the site. getMapId() runs on EVERY request and its URL is
never stored, because Earth Engine map ids expire after a few hours.

Offline: prep/imagery.py saves this same live layer's tiles once into
data/site_intel/tiles/{z}/{x}/{y}.png + meta.json, served by
GET /api/site/tiles/{z}/{x}/{y}.png (router.py, via tile_path()).

Nothing here raises to its caller: every failure falls back to the cache, then to an
'info' finding saying the overlay is unavailable.
"""

from __future__ import annotations

import json
import logging
import math
from pathlib import Path
from typing import Any

from app.contract import Finding, LngLat, MapOverlay, Provenance
from app.site_intel import earthengine
from app.site_intel.config import TILES
from app.site_intel.geo import EARTH_KM, haversine_km

log = logging.getLogger(__name__)

# The look, shared by the live layer and the offline prep script so both render alike.
S2_COLLECTION = "COPERNICUS/S2_SR_HARMONIZED"  # L2A surface reflectance x 10000, 2022+ offset removed
SEASON = ("2024-05-01", "2024-10-01")  # dry season (end exclusive): fewest clouds over the Central Valley
BANDS = ("B4", "B3", "B2")  # red, green, blue (10 m)
VIS: dict[str, float] = {"min": 0, "max": 3000, "gamma": 1.2}
SCL_CLEAR = (2, 4, 5, 6, 7, 11)  # SCL classes kept: dark area, vegetation, bare, water, unclassified, snow
MAX_CLOUDY_PCT = 20  # scene-level CLOUDY_PIXEL_PERCENTAGE filter before the pixel mask
HALF_KM = 2.5  # imagery box half-width (a 5 km box: the 2 km screening buffer plus margin)
NEAR_KM = 5.0  # use the cached tiles when the site is inside or this close to their bounds
LIVE_TIMEOUT_S = 10.0
MAX_Z = 22

TILE_URL = "/api/site/tiles/{z}/{x}/{y}.png"  # literal placeholders; A's MapView makes it absolute
LABEL = "Sentinel-2 2024 true color"
ATTRIBUTION_LIVE = "Contains modified Copernicus Sentinel data 2024, processed in Google Earth Engine"
ATTRIBUTION_CACHED = ATTRIBUTION_LIVE  # prep/imagery.py saves the live Earth Engine layer's tiles
EE_URL = "https://developers.google.com/earth-engine/datasets/catalog/COPERNICUS_S2_SR_HARMONIZED"
STYLE = f"SCL cloud-masked median of B4/B3/B2, stretch {VIS['min']:g}-{VIS['max']:g}, gamma {VIS['gamma']:g}"

Overlays = tuple[list[MapOverlay], list[Provenance], list[Finding]]


def site_box(loc: LngLat, half_km: float = HALF_KM) -> tuple[float, float, float, float]:
    """[west, south, east, north] of a square box half_km on each side of the site."""
    dlat = math.degrees(half_km / EARTH_KM)
    dlon = dlat / max(math.cos(math.radians(loc.lat)), 1e-6)
    return (round(loc.lon - dlon, 6), round(loc.lat - dlat, 6), round(loc.lon + dlon, 6), round(loc.lat + dlat, 6))


def _km_outside(loc: LngLat, bounds: list[float]) -> float:
    """0 inside the bounds, else the distance to their nearest edge."""
    w, s, e, n = bounds
    nearest = LngLat(lon=min(max(loc.lon, w), e), lat=min(max(loc.lat, s), n))
    return haversine_km(loc, nearest)


# ---------------------------------------------------------------------------
# Offline tiles
# ---------------------------------------------------------------------------

_meta_cache: tuple[tuple[str, int], dict[str, Any] | None] | None = None


def _valid_meta(meta: Any) -> bool:
    if not isinstance(meta, dict):
        return False
    b = meta.get("bounds")
    if not (isinstance(b, list) and len(b) == 4 and all(isinstance(v, (int, float)) and math.isfinite(v) for v in b)):
        return False
    return b[0] < b[2] and b[1] < b[3]


def tiles_meta() -> dict[str, Any] | None:
    """data/site_intel/tiles/meta.json (re-read only when the file changes), or None if missing/corrupt."""
    global _meta_cache
    path = TILES / "meta.json"
    try:
        stamp = (str(path), path.stat().st_mtime_ns)
    except OSError:
        return None
    if _meta_cache is not None and _meta_cache[0] == stamp:
        return dict(_meta_cache[1]) if _meta_cache[1] else None
    try:
        meta = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        log.warning("imagery tiles meta.json unreadable: %s", exc)
        meta = None
    if meta is not None and not _valid_meta(meta):
        log.warning("imagery tiles meta.json has no valid bounds; ignoring the cached tiles")
        meta = None
    _meta_cache = (stamp, meta)
    return dict(meta) if meta else None


def tile_path(z: int, x: int, y: int) -> Path | None:
    """The cached PNG for XYZ tile z/x/y, or None. Ints only; the path can never leave TILES."""
    try:
        if not all(type(v) is int for v in (z, x, y)):  # rejects str, float and bool
            return None
        if not (0 <= z <= MAX_Z and 0 <= x < 2**z and 0 <= y < 2**z):
            return None
        root = TILES.resolve()
        p = (root / str(z) / str(x) / f"{y}.png").resolve()
        return p if p.is_relative_to(root) and p.is_file() else None
    except (OSError, ValueError, RuntimeError):
        return None


def _cached(loc: LngLat) -> Overlays | None:
    meta = tiles_meta()
    if meta is None:
        return None
    off_km = _km_outside(loc, meta["bounds"])
    if off_km > NEAR_KM:
        return None
    captured = meta.get("captured") or "unknown date"
    scenes = [s.get("date") for s in meta.get("scenes", []) if isinstance(s, dict) and s.get("date")]
    note = f"cached tiles, captured {captured}"
    if scenes:
        note += f"; median of {len(scenes)} scenes ({', '.join(scenes)})"
    if meta.get("style"):
        note += f"; {meta['style']}"
    overlay = MapOverlay(
        id="satellite",
        label=f"{LABEL} (cached)",
        type="raster",
        url=TILE_URL,
        opacity=0.9,
        attribution=meta.get("attribution") or ATTRIBUTION_CACHED,
    )
    prov = Provenance(kind="observed", source=str(meta.get("source") or "Copernicus Sentinel-2 L2A 2024"), url=meta.get("url"), note=note)
    findings: list[Finding] = []
    if off_km > 0:
        findings.append(
            Finding(
                id="imagery_cached_nearby",
                module="site",
                severity="info",
                title="Satellite overlay covers a nearby area",
                detail=f"The cached satellite tiles cover the demo area, {off_km:.1f} km from this site; "
                "live imagery of other sites isn't enabled on this deployment.",
                metric=round(off_km, 2),
                threshold=NEAR_KM,
            )
        )
    return [overlay], [prov], findings


# ---------------------------------------------------------------------------
# Live Earth Engine layer
# ---------------------------------------------------------------------------


def _live_map_id(ee: Any, box: tuple[float, float, float, float]) -> dict[str, Any]:
    """Build the composite and ask Earth Engine for a (short-lived) map id. Runs inside earthengine.run()."""
    region = ee.Geometry.Rectangle(list(box), geodesic=False)  # planar: straight edges, like the cached box
    keep_from, keep_to = list(SCL_CLEAR), [1] * len(SCL_CLEAR)

    def mask_clouds(img: Any) -> Any:
        return img.updateMask(img.select("SCL").remap(keep_from, keep_to, 0))

    composite = (
        ee.ImageCollection(S2_COLLECTION)
        .filterBounds(region)
        .filterDate(*SEASON)
        .filter(ee.Filter.lt("CLOUDY_PIXEL_PERCENTAGE", MAX_CLOUDY_PCT))
        .map(mask_clouds)
        .select(list(BANDS))
        .median()
        .clip(region)
    )
    return composite.getMapId({"bands": list(BANDS), **VIS})


def _live(loc: LngLat) -> Overlays | None:
    ee = earthengine.get_ee()
    if ee is None:
        return None
    box = site_box(loc)
    try:
        map_id = earthengine.run(lambda: _live_map_id(ee, box), timeout=LIVE_TIMEOUT_S)
    except earthengine.EEUnavailable as exc:
        log.info("live imagery unavailable, trying cached tiles: %s", exc)
        return None
    url = map_id["tile_fetcher"].url_format  # fresh every request; never cache it (expires in hours)
    if not (isinstance(url, str) and url.startswith("https://") and "{z}" in url):
        raise ValueError(f"unexpected Earth Engine tile URL: {url!r}")
    overlay = MapOverlay(id="satellite", label=LABEL, type="raster", url=url, opacity=0.9, attribution=ATTRIBUTION_LIVE)
    prov = Provenance(
        kind="observed",
        source=f"Copernicus Sentinel-2 L2A, May-Sep 2024 median (Google Earth Engine {S2_COLLECTION})",
        url=EE_URL,
        note=f"live Earth Engine tiles; {STYLE}; {2 * HALF_KM:g} km box around the site",
    )
    return [overlay], [prov], []


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------


def _unavailable(loc: LngLat) -> Finding:
    try:
        st = earthengine.status()
        ee_why = "live imagery is unavailable right now" if st.get("configured") else "live imagery of other sites isn't enabled on this deployment"
    except Exception:  # noqa: BLE001
        ee_why = "live imagery isn't available"
    try:
        meta = tiles_meta()
        where = f" {str(meta['site']).capitalize()}" if meta and meta.get("site") else ""
    except Exception:  # noqa: BLE001
        where = ""
    return Finding(
        id="imagery_unavailable",
        module="site",
        severity="info",
        title="No satellite overlay here",
        detail=f"Satellite imagery is cached only for the{where} demo area, and {ee_why}, "
        f"so none is drawn at {loc.lat:.3f}, {loc.lon:.3f}.",
    )


def imagery_overlays(loc: LngLat) -> Overlays:
    """(overlays, provenance, findings) for the satellite layer at a site. Never raises."""
    try:
        live = _live(loc)
        if live is not None:
            return live
    except Exception as exc:  # noqa: BLE001 - any EE/ee-API surprise means "use the cache"
        log.warning("live imagery failed, trying cached tiles: %s", exc)
    try:
        cached = _cached(loc)
        if cached is not None:
            return cached
    except Exception as exc:  # noqa: BLE001
        log.warning("cached imagery failed: %s", exc)
    try:
        return [], [], [_unavailable(loc)]
    except Exception:  # noqa: BLE001 - last resort, e.g. an invalid location
        return [], [], []
