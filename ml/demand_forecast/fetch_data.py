"""Download training data: EIA-930 hourly load and Open-Meteo hourly weather.  OWNER: workstream A.

Run on the training machine, from the repo root:
    python -m ml.demand_forecast.fetch_data                 # 2019 .. current, both sources
    python -m ml.demand_forecast.fetch_data --only eia --years 2024   # just what the baseline artifact needs
    python -m ml.demand_forecast.fetch_data --only dof                # CA DOF county population projections

EIA-930 six-month files (about 25-60 MB each) land in ml/demand_forecast/data/raw/;
weather per region point lands in ml/demand_forecast/cache/. Both are git-ignored and
reused on later runs. Files that EIA hasn't published yet (future half-years) are skipped.
"""

from __future__ import annotations

import argparse
import datetime as dt
import time
from pathlib import Path

import httpx

from ml.demand_forecast.config import (
    BROWSER_UA,
    CACHE_DIR,
    DOF_P2A_FILE,
    DOF_P2A_URL,
    EIA930_URL,
    FIRST_YEAR,
    OPEN_METEO_URL,
    RAW_DIR,
    WEATHER_VARS,
)
from ml.demand_forecast.geo import region_geo

EIA_KINDS = ("SUBREGION", "BALANCE")  # sub-regions: CAISO's PGAE/SCE/SDGE; balance: LDWP/BANC/IID/TIDC
HALVES = ("Jan_Jun", "Jul_Dec")


def eia_path(kind: str, year: int, half: str) -> Path:
    return RAW_DIR / f"EIA930_{kind}_{year}_{half}.csv"


def weather_path(region: str, i: int) -> Path:
    return CACHE_DIR / f"weather_{region}_{i}.csv"


def _download(url: str, dest: Path) -> bool:
    """Stream url to dest; False if the file doesn't exist (yet)."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    for attempt in range(1, 4):
        try:
            with httpx.stream("GET", url, headers={"User-Agent": BROWSER_UA}, timeout=300, follow_redirects=True) as r:
                if r.status_code == 404:
                    return False
                r.raise_for_status()
                with tmp.open("wb") as f:
                    for chunk in r.iter_bytes():
                        f.write(chunk)
            tmp.replace(dest)
            return True
        except httpx.HTTPError as exc:
            if attempt == 3:
                raise
            print(f"  retry {attempt} after {exc!r}")
            time.sleep(5 * attempt)
    return False


def fetch_eia930(years: list[int]) -> None:
    for year in years:
        for half in HALVES:
            for kind in EIA_KINDS:
                dest = eia_path(kind, year, half)
                if dest.is_file() and dest.stat().st_size > 0:
                    continue
                ok = _download(EIA930_URL.format(kind=kind, year=year, half=half), dest)
                print(f"EIA-930 {kind} {year} {half}: {'ok' if ok else 'not published, skipped'}")


def fetch_weather(start: dt.date, end: dt.date, refresh: bool = False) -> None:
    """Hourly weather (UTC) for each region's population-weighted points; one request per point."""
    geo = region_geo()
    with httpx.Client(timeout=120) as client:
        for region, pts in geo.weather_points.items():
            for i, p in enumerate(pts):
                dest = weather_path(region, i)
                if dest.is_file() and not refresh:
                    continue
                params = {
                    "latitude": p["lat"],
                    "longitude": p["lon"],
                    "start_date": start.isoformat(),
                    "end_date": end.isoformat(),
                    "hourly": ",".join(WEATHER_VARS),
                    "timezone": "UTC",
                }
                r = client.get(OPEN_METEO_URL, params=params)
                r.raise_for_status()
                hourly = r.json()["hourly"]
                dest.parent.mkdir(parents=True, exist_ok=True)
                cols = ["time", *WEATHER_VARS]
                lines = [",".join(cols)] + [",".join("" if hourly[c][k] is None else str(hourly[c][k]) for c in cols) for k in range(len(hourly["time"]))]
                dest.write_text("\n".join(lines) + "\n", encoding="utf-8")
                print(f"weather {region}[{i}] ({p['lat']}, {p['lon']}): {len(hourly['time'])} hours")
                time.sleep(1.0)  # be polite to the free API


def fetch_dof() -> None:
    if DOF_P2A_FILE.is_file():
        return
    _download(DOF_P2A_URL, DOF_P2A_FILE)
    print(f"DOF P-2A county projections: {DOF_P2A_FILE.name}")


def main() -> None:
    today = dt.date.today()
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--years", type=int, nargs="*", default=list(range(FIRST_YEAR, today.year + 1)))
    ap.add_argument("--only", choices=("eia", "weather", "dof"), default=None)
    ap.add_argument("--refresh-weather", action="store_true")
    args = ap.parse_args()
    if args.only in (None, "dof"):
        fetch_dof()
    if args.only in (None, "eia"):
        fetch_eia930(args.years)
    if args.only in (None, "weather"):
        # The archive lags real time by ~5 days; stop a week back.
        end = min(dt.date(max(args.years), 12, 31), today - dt.timedelta(days=7))
        fetch_weather(dt.date(min(args.years), 1, 1), end, refresh=args.refresh_weather)


if __name__ == "__main__":
    main()
