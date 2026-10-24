"""Solar and wind resource for site features: ERA5 reanalysis via the Open-Meteo archive.  OWNER: workstream B.

    python -m ml.site_location.fetch_resource            # ~200 points, a few minutes; writes data/resource_grid.csv

Samples a 0.5 degree grid over California (points within ~40 km of the state), takes one year of hourly
shortwave radiation and 100 m wind speed, and keeps the annual means: GHI in kWh/m²/day and wind speed
in m/s. The small CSV is committed so training machines and the website don't need the API; features
interpolate it to each 5 km cell (inverse-distance weighting in California Albers).
"""

from __future__ import annotations

import argparse
import time

import httpx
import numpy as np
import pandas as pd
from scipy.spatial import cKDTree
from shapely import distance, points

from ml.site_location.config import PKG_DIR
from ml.site_location.geodata import load_geodata, to_xy

RESOURCE_FILE = PKG_DIR / "data" / "resource_grid.csv"
OPEN_METEO_URL = "https://archive-api.open-meteo.com/v1/archive"
STEP_DEG = 0.5
BATCH = 25  # locations per request (Open-Meteo accepts comma-separated lists)


def grid_points(year_land_buffer_km: float = 40.0) -> pd.DataFrame:
    geo = load_geodata()
    lons = np.arange(-124.5, -113.9, STEP_DEG)
    lats = np.arange(32.5, 42.1, STEP_DEG)
    lon, lat = (a.ravel() for a in np.meshgrid(lons, lats))
    x, y = to_xy(lon, lat)
    near = distance(points(x, y), geo.land) <= year_land_buffer_km * 1000.0
    return pd.DataFrame({"lon": lon[near], "lat": lat[near]}).reset_index(drop=True)


def fetch(pts: pd.DataFrame, year: int) -> pd.DataFrame:
    rows = []
    with httpx.Client(timeout=180) as client:
        for start in range(0, len(pts), BATCH):
            chunk = pts.iloc[start : start + BATCH]
            params = {
                "latitude": ",".join(f"{v:.3f}" for v in chunk["lat"]),
                "longitude": ",".join(f"{v:.3f}" for v in chunk["lon"]),
                "start_date": f"{year}-01-01",
                "end_date": f"{year}-12-31",
                "hourly": "shortwave_radiation,wind_speed_100m",
                "wind_speed_unit": "ms",
                "timezone": "UTC",
            }
            for attempt in range(1, 4):
                r = client.get(OPEN_METEO_URL, params=params)
                if r.status_code == 429 and attempt < 3:
                    time.sleep(30 * attempt)  # free-tier rate limit
                    continue
                r.raise_for_status()
                break
            data = r.json()
            data = data if isinstance(data, list) else [data]
            for (_, p), d in zip(chunk.iterrows(), data):
                ghi = np.array(d["hourly"]["shortwave_radiation"], dtype=float)
                wind = np.array(d["hourly"]["wind_speed_100m"], dtype=float)
                rows.append(
                    {
                        "lon": p["lon"],
                        "lat": p["lat"],
                        "ghi_kwh_m2_day": round(float(np.nanmean(ghi)) * 24 / 1000, 3),  # mean W/m² -> kWh/m²/day
                        "wind100_ms": round(float(np.nanmean(wind)), 3),
                    }
                )
            print(f"{min(start + BATCH, len(pts))}/{len(pts)} points")
            time.sleep(2.0)
    return pd.DataFrame(rows)


def interpolate(resource: pd.DataFrame, x: np.ndarray, y: np.ndarray, k: int = 4) -> pd.DataFrame:
    """Inverse-distance-weighted GHI and wind at projected points (metres)."""
    rx, ry = to_xy(resource["lon"], resource["lat"])
    dist, idx = cKDTree(np.column_stack([rx, ry])).query(np.column_stack([x, y]), k=k)
    w = 1.0 / np.maximum(dist, 1.0) ** 2
    w = w / w.sum(axis=1, keepdims=True)
    return pd.DataFrame(
        {
            "ghi_kwh_m2_day": (resource["ghi_kwh_m2_day"].to_numpy()[idx] * w).sum(axis=1),
            "wind100_ms": (resource["wind100_ms"].to_numpy()[idx] * w).sum(axis=1),
        }
    )


def load_resource() -> pd.DataFrame:
    if not RESOURCE_FILE.is_file():
        raise FileNotFoundError(f"{RESOURCE_FILE} missing: run python -m ml.site_location.fetch_resource")
    return pd.read_csv(RESOURCE_FILE)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--year", type=int, default=2024)
    args = ap.parse_args()
    pts = grid_points()
    print(f"{len(pts)} resource points at {STEP_DEG} degree spacing")
    out = fetch(pts, args.year)
    RESOURCE_FILE.parent.mkdir(parents=True, exist_ok=True)
    out.to_csv(RESOURCE_FILE, index=False)
    print(out.describe().round(2).to_string())
    print(f"wrote {RESOURCE_FILE}")


if __name__ == "__main__":
    main()
