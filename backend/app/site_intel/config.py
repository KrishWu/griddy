"""Paths, keys and constants shared by the site-intelligence modules.  OWNER: workstream E."""

from __future__ import annotations

import os

from app import DATA_DIR
from app.contract import LngLat

DATA = DATA_DIR / "site_intel"
CACHE = DATA / "cache"  # git-ignored: runtime results (Earth Engine, AirNow)
RAW = DATA / "raw"  # git-ignored: prep-script downloads
AREAS = DATA / "areas"  # committed: precomputed screening grids around demo sites
TILES = DATA / "tiles"  # committed: offline imagery tiles {z}/{x}/{y}.png + meta.json

BUFFER_KM = 2.0  # screening radius around the site
GRID_STEP_DEG = 0.01  # cache key resolution (~1.1 km); never key on site.id

# Candidate demo sites from docs/WORKSTREAMS.md ("Open decisions"). The prep scripts
# precompute offline screening around each so the demo never depends on a live API.
# Tracy / Los Banos: the best-screening open cell near PG&E's 500 kV substation
# (OpenStreetMap: Tesla 37.712,-121.565; Los Banos 37.053,-121.021).
DEMO_SITES: dict[str, dict] = {
    "kern": {"label": "Kern County (placeholder demo site)", "location": LngLat(lon=-119.47, lat=35.40)},
    "tracy": {"label": "Tracy, 4 km from the 500 kV Tesla substation", "location": LngLat(lon=-121.53, lat=37.74)},
    "los_banos": {"label": "Westside San Joaquin Valley, 3 km from the 500 kV Los Banos substation", "location": LngLat(lon=-120.99, lat=37.06)},
}


def site_key(loc: LngLat) -> str:
    """Cache key: lat/lon rounded to 0.01 deg, e.g. "35.40,-119.47". Prep and runtime must both use this."""
    lat, lon = round(loc.lat, 2) + 0.0, round(loc.lon, 2) + 0.0  # + 0.0 turns -0.0 into 0.0
    return f"{lat:.2f},{lon:.2f}"


def key_center(key: str) -> LngLat:
    lat, lon = (float(v) for v in key.split(","))
    return LngLat(lon=lon, lat=lat)


def env(name: str) -> str | None:
    """A configured secret/setting from backend/.env, or None when blank."""
    v = os.environ.get(name, "").strip()
    return v or None
