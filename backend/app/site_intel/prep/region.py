"""Griddy's service region: California plus a 2 km coastal margin, for the placement guard.  OWNER: E.

Unions A's county polygons (Census cartographic boundaries, clipped to the shoreline) and adds a
2 km margin on the Pacific side only, so a click on the beach still counts but one just across
the Oregon, Nevada, Arizona or Mexico line does not. Simplified to ~150 m, the outer rings go to
frontend/components/site_intel/caOutline.json (regionGuard.ts reads it). Inland lakes count as
California (holes are dropped).

    python -m app.site_intel.prep.region       (from backend/)
"""

from __future__ import annotations

import json
from datetime import date
from pathlib import Path

import numpy as np
import shapely
from pyproj import Transformer
from shapely.geometry import MultiPolygon, Polygon, shape
from shapely.ops import unary_union

from app import DATA_DIR

COUNTIES = DATA_DIR / "explore" / "counties_ca.geojson"
OUT = DATA_DIR.parent / "frontend" / "components" / "site_intel" / "caOutline.json"
BUFFER_M = 2_000
SIMPLIFY_M = 150
MIN_ISLAND_KM2 = 1.0  # rocks and islets below this are dropped

# Where the coastal margin may go: the Pacific, bounded by edges that run inside California just
# short of the land borders (42 N with Oregon, the Nevada line and the Colorado River, and the
# Mexico line, which meets the coast at Imperial Beach, 32.534 N). [lon, lat]
PACIFIC_SIDE = [
    (-140.0, 43.0),
    (-124.23, 43.0),  # Oregon coast at the state line
    (-124.23, 42.0),
    (-120.1, 42.0),
    (-120.1, 39.0),  # the Nevada line turns south-east at Lake Tahoe
    (-114.8, 35.0),
    (-114.9, 34.0),
    (-114.9, 32.85),
    (-117.05, 32.65),
    (-117.13, 32.534),
    (-140.0, 32.534),
]


def _projector(src: str, dst: str):
    t = Transformer.from_crs(src, dst, always_xy=True)
    return lambda xy: np.column_stack(t.transform(xy[:, 0], xy[:, 1]))


def build(counties: Path = COUNTIES) -> dict:
    fc = json.loads(counties.read_text(encoding="utf-8"))
    to_m = _projector("EPSG:4326", "EPSG:3310")  # California Albers, meters
    to_ll = _projector("EPSG:3310", "EPSG:4326")
    state = unary_union([shapely.transform(shape(f["geometry"]), to_m) for f in fc["features"]])
    pacific = shapely.transform(Polygon(PACIFIC_SIDE).segmentize(0.05), to_m)
    region = state.union(state.buffer(BUFFER_M).intersection(pacific)).simplify(SIMPLIFY_M, preserve_topology=True)
    parts = list(region.geoms) if isinstance(region, MultiPolygon) else [region]
    rings = []
    for p in sorted(parts, key=lambda g: -g.area):
        if p.area < MIN_ISLAND_KM2 * 1e6:
            continue
        outer = shapely.transform(Polygon(p.exterior), to_ll)
        rings.append([[round(x, 4), round(y, 4)] for x, y in outer.exterior.coords])
    return {
        "source": "US Census Bureau cartographic boundaries 2024 (1:500k), via data/explore/counties_ca.geojson",
        "buffer_km": BUFFER_M / 1000,
        "simplify_m": SIMPLIFY_M,
        "generated": date.today().isoformat(),
        "rings": rings,
    }


def main() -> None:
    out = build()
    OUT.write_text(json.dumps(out, separators=(",", ":")) + "\n", encoding="utf-8")
    n = sum(len(r) for r in out["rings"])
    print(f"{OUT.name}: {len(out['rings'])} rings, {n} vertices, {OUT.stat().st_size / 1024:.0f} KB")


if __name__ == "__main__":
    main()
