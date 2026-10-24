"""Helpers shared by the Explore data-prep scripts (prepare_*.py).  OWNER: workstream A.

Prep scripts run offline, once, from backend/:  .venv/bin/python -m app.explore.prepare_<x>
Raw downloads go to data/explore/raw/ (git-ignored); processed GeoJSON goes to
data/explore/ and is committed. Runtime code (service.py) never imports this module.
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

import httpx

from app import DATA_DIR

OUT_DIR = DATA_DIR / "explore"
RAW_DIR = OUT_DIR / "raw"
CA_ALBERS = "EPSG:3310"  # California Albers (meters): use for distances, buffers, simplification
WGS84 = "EPSG:4326"
USER_AGENT = "Griddy/0.1 (Stanford Cleantech Hackathon 2026; github.com/heruirayli/cleantech-hacks)"
BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"


def download(url: str, dest: Path, *, user_agent: str = BROWSER_UA, retries: int = 3, timeout: float = 300) -> Path:
    """Download url to dest unless it already exists. Returns dest."""
    if dest.exists() and dest.stat().st_size > 0:
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    for attempt in range(1, retries + 1):
        try:
            with httpx.stream("GET", url, headers={"User-Agent": user_agent}, timeout=timeout, follow_redirects=True) as r:
                r.raise_for_status()
                with tmp.open("wb") as f:
                    for chunk in r.iter_bytes():
                        f.write(chunk)
            tmp.replace(dest)
            return dest
        except httpx.HTTPError:
            if attempt == retries:
                raise
            time.sleep(5 * attempt)
    return dest


def fetch_arcgis_geojson(layer_url: str, *, where: str = "1=1", out_fields: str = "*", page_size: int | None = None) -> dict[str, Any]:
    """Page through an ArcGIS FeatureServer layer and return one WGS84 FeatureCollection."""
    meta = httpx.get(layer_url, params={"f": "json"}, timeout=60).json()
    page = page_size or int(meta.get("maxRecordCount") or 1000)
    features: list[dict[str, Any]] = []
    offset = 0
    while True:
        params = {
            "where": where,
            "outFields": out_fields,
            "outSR": 4326,
            "f": "geojson",
            "resultOffset": offset,
            "resultRecordCount": page,
            "orderByFields": meta.get("objectIdField") or "OBJECTID",
        }
        r = httpx.get(f"{layer_url}/query", params=params, timeout=120)
        r.raise_for_status()
        batch = r.json().get("features", [])
        features.extend(batch)
        if len(batch) < page:
            break
        offset += page
    return {"type": "FeatureCollection", "features": features}


def simplify_m(gdf: Any, tolerance_m: float) -> Any:
    """Simplify a WGS84 GeoDataFrame with a tolerance in meters (via California Albers)."""
    projected = gdf.to_crs(CA_ALBERS)
    projected["geometry"] = projected.geometry.simplify(tolerance_m, preserve_topology=True)
    return projected.to_crs(WGS84)


def _round_coords(obj: Any, ndigits: int) -> Any:
    if isinstance(obj, float):
        return round(obj, ndigits)
    if isinstance(obj, (list, tuple)):
        return [_round_coords(v, ndigits) for v in obj]
    return obj


def write_geojson(features: list[dict[str, Any]], path: Path, *, precision: int = 5) -> Path:
    """Write a compact FeatureCollection. precision=5 decimal degrees is ~1 m."""
    for f in features:
        geom = f.get("geometry")
        if geom and "coordinates" in geom:
            geom["coordinates"] = _round_coords(geom["coordinates"], precision)
    path.parent.mkdir(parents=True, exist_ok=True)
    fc = {"type": "FeatureCollection", "features": features}
    path.write_text(json.dumps(fc, separators=(",", ":"), ensure_ascii=False, allow_nan=False), encoding="utf-8")
    return path


def gdf_to_features(gdf: Any) -> list[dict[str, Any]]:
    """GeoDataFrame -> list of GeoJSON feature dicts (properties = all non-geometry columns)."""
    return json.loads(gdf.to_json(drop_id=True))["features"]
