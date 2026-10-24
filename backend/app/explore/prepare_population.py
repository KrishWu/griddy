"""Block-group population points for "population within 10 km" lookups.  OWNER: workstream A.

Source: US Census Bureau, 2020 Census population-weighted block-group centroids for California
(CenPop2020_Mean_BG06.txt). Writes data/explore/population_bg_ca.csv with header lon,lat,population
(WGS84, 5-decimal coordinates, integer 2020 population), zero-population block groups dropped.
Summing `population` over points within a radius (distances in EPSG:3310) approximates the people
living nearby; block groups straddling the radius count fully or not at all.

Run from backend/:  .venv/Scripts/python -m app.explore.prepare_population
Idempotent: reuses the cached raw download in data/explore/raw/.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
from pyproj import Transformer

from app.explore._prep_utils import CA_ALBERS, OUT_DIR, RAW_DIR, WGS84, download

SOURCE_URL = "https://www2.census.gov/geo/docs/reference/cenpop2020/blkgrp/CenPop2020_Mean_BG06.txt"
SOURCE = "US Census Bureau 2020 Census population-weighted block-group centroids"
OUT_PATH = OUT_DIR / "population_bg_ca.csv"
BUDGET_BYTES = 1e6
RADIUS_KM = 10.0

DEMO_SITES: dict[str, tuple[float, float]] = {
    "Kern placeholder": (-119.47, 35.40),
    "Tracy/Tesla substation": (-121.55, 37.71),
    "Los Banos": (-120.85, 37.06),
}


def population_within(points: pd.DataFrame, lon: float, lat: float, radius_km: float = RADIUS_KM) -> int:
    """Sum of block-group population whose centroid lies within radius_km (EPSG:3310 distance)."""
    to_albers = Transformer.from_crs(WGS84, CA_ALBERS, always_xy=True)
    px, py = to_albers.transform(points["lon"].to_numpy(), points["lat"].to_numpy())
    sx, sy = to_albers.transform(lon, lat)
    within = np.hypot(px - sx, py - sy) <= radius_km * 1000
    return int(points.loc[within, "population"].sum())


def main() -> None:
    raw_path = download(SOURCE_URL, RAW_DIR / "CenPop2020_Mean_BG06.txt")
    raw = pd.read_csv(raw_path, encoding="utf-8-sig", dtype={"STATEFP": str, "COUNTYFP": str, "TRACTCE": str, "BLKGRPCE": str})
    expected = {"STATEFP", "POPULATION", "LATITUDE", "LONGITUDE"}
    if not expected <= set(raw.columns):
        raise SystemExit(f"Unexpected columns in {raw_path.name}: {list(raw.columns)}")
    assert (raw["STATEFP"] == "06").all(), "file should contain California (STATEFP 06) only"

    df = pd.DataFrame(
        {
            "lon": raw["LONGITUDE"].astype(float).round(5),
            "lat": raw["LATITUDE"].astype(float).round(5),
            "population": pd.to_numeric(raw["POPULATION"], errors="coerce"),
        }
    )
    n_raw = len(df)
    df = df.dropna()
    df = df[df["population"] > 0].astype({"population": int})
    assert df["lon"].between(-124.5, -114.0).all() and df["lat"].between(32.4, 42.1).all(), "points outside California bbox"

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    df.to_csv(OUT_PATH, index=False, float_format="%.5f", lineterminator="\n")

    size = OUT_PATH.stat().st_size
    status = "OK" if size <= BUDGET_BYTES else "OVER BUDGET"
    print(f"Source: {SOURCE} ({SOURCE_URL})")
    print(f"  {n_raw} block groups read, {n_raw - len(df)} dropped (zero/missing population), {len(df)} written")
    print(f"  total population {df['population'].sum():,} (2020 Census CA: 39,538,223)")
    print(f"  wrote {OUT_PATH.relative_to(OUT_DIR.parent.parent)}  {size / 1e6:.2f} MB  [{status}]")

    check = pd.read_csv(OUT_PATH)
    assert list(check.columns) == ["lon", "lat", "population"], list(check.columns)
    assert check.notna().all().all() and (check["population"] > 0).all()
    for site, (lon, lat) in DEMO_SITES.items():
        print(f"  {site} ({lon}, {lat}): population within {RADIUS_KM:g} km = {population_within(check, lon, lat):,}")


if __name__ == "__main__":
    main()
