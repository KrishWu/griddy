"""Build the committed demo-area screening grids in data/site_intel/areas/.  OWNER: workstream E.

For each demo site, screens an 11 x 11 grid of 0.01 deg cells (~12 km square) with
the same Earth Engine computation the server runs live (land.ee_dictionary), so a click
anywhere near the demo site answers instantly and offline.

From backend/:  .venv/bin/python -m app.site_intel.prep.land --site all [--half-cells 5]
Needs EE_PROJECT in backend/.env (see app/site_intel/README.md).
"""

from __future__ import annotations

import argparse
import json
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from typing import Any

from app.contract import LngLat
from app.site_intel import earthengine
from app.site_intel.config import AREAS, BUFFER_KM, DEMO_SITES, GRID_STEP_DEG, key_center, site_key
from app.site_intel.land import SOURCES, ee_dictionary, stats_from_raw
from app.site_intel.screening import LandStats


def stats_with_retry(ee: Any, loc: LngLat, tries: int = 4) -> LandStats:
    """One cell, straight to Earth Engine (no circuit breaker: a batch job should wait, not give up)."""
    for attempt in range(tries):
        try:
            return stats_from_raw(ee_dictionary(ee, loc, BUFFER_KM).getInfo(), BUFFER_KM)
        except Exception:  # noqa: BLE001 - EE 429s / transient 5xx
            if attempt == tries - 1:
                raise
            time.sleep(2 * 2**attempt)
    raise AssertionError("unreachable")


def grid(center: LngLat, half_cells: int) -> list[LngLat]:
    c = key_center(site_key(center))
    return [
        LngLat(lon=round(c.lon + j * GRID_STEP_DEG, 2), lat=round(c.lat + i * GRID_STEP_DEG, 2))
        for i in range(-half_cells, half_cells + 1)
        for j in range(-half_cells, half_cells + 1)
    ]


def build_area(ee: Any, name: str, half_cells: int, workers: int = 8) -> dict[str, Any]:
    site = DEMO_SITES[name]
    cells = grid(site["location"], half_cells)
    with ThreadPoolExecutor(workers) as pool:
        stats = list(pool.map(lambda loc: stats_with_retry(ee, loc), cells))
    center = key_center(site_key(site["location"]))
    return {
        "site": name,
        "label": site["label"],
        "center": center.model_dump(),
        "buffer_km": BUFFER_KM,
        "grid_step_deg": GRID_STEP_DEG,
        "half_cells": half_cells,
        "method": "earth_engine",
        "computed_at": date.today().isoformat(),
        "sources": [p.model_dump(exclude_none=True) for p in SOURCES],
        "cells": {site_key(loc): s.model_dump(exclude={"sources"}) for loc, s in zip(cells, stats)},  # sources: once, above
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--site", default="all", choices=["all", *DEMO_SITES])
    ap.add_argument("--half-cells", type=int, default=5)
    args = ap.parse_args()
    ee = earthengine.get_ee()
    if ee is None:
        raise SystemExit("Earth Engine unavailable: set EE_PROJECT and run `python -m app.site_intel.earthengine`")
    AREAS.mkdir(parents=True, exist_ok=True)
    for name in DEMO_SITES if args.site == "all" else [args.site]:
        t0 = time.monotonic()
        area = build_area(ee, name, args.half_cells)
        path = AREAS / f"{name}.json"
        path.write_text(json.dumps(area, separators=(",", ":")), encoding="utf-8")
        mid = area["cells"][site_key(DEMO_SITES[name]["location"])]
        print(
            f"{name}: {len(area['cells'])} cells in {time.monotonic() - t0:.0f} s -> {path.name} ({path.stat().st_size / 1024:.0f} KB); "
            f"center slope {mid['mean_slope_deg']} deg, GHI {mid['solar_ghi_kwh_m2_day']}, fallow {mid['fallow_share']}, "
            f"crop {mid['active_crop_share']}, protected {mid['protected_share']}, water {mid['water_share']}"
        )


if __name__ == "__main__":
    main()
