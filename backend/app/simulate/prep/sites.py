"""Pre-bake 2024 site weather + solar/wind CFs for the demo candidates.  OWNER: workstream B.

Run from backend/:
    .venv/bin/python -m app.simulate.prep.sites                      # all demo sites
    .venv/bin/python -m app.simulate.prep.sites --lat 36.1 --lon -120.1 --name "My site"

Writes data/simulate/sites/<key>_<year>.csv + <key>_<year>.json (sidecar metadata,
including a PVWatts v8 validation of the solar model) and data/simulate/sites/index.json
(a list of every baked site). Network: Open-Meteo archive (no key) and PVWatts v8 at
developer.nlr.gov (NLR_API_KEY from backend/.env, DEMO_KEY otherwise; DEMO_KEY is rate
limited to ~10 calls/hour). PVWatts uses an NSRDB TMY year, not 2024, so expect agreement
within a few CF points, not an exact match. Its baseline is array_type 2, a single-axis
tracker WITHOUT backtracking (PVWatts applies row self-shading), while our model backtracks;
pass --pvwatts-array-type 3 for the backtracking variant. If PVWatts can't be reached, a
previous result in the sidecar with the identical request is kept.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx

from app.simulate import weather as W

YEAR = 2024
PVWATTS_URL = "https://developer.nlr.gov/api/pvwatts/v8.json"  # developer.nrel.gov no longer resolves
INDEX_PATH = W.SITES_DIR / "index.json"
# PVWatts v8 array_type: 0 fixed open rack, 1 fixed roof, 2 1-axis, 3 1-axis backtracking, 4 2-axis.
PVWATTS_ARRAY_TYPE = 2  # as specified; 3 would match weather.py's backtrack=True exactly
PVWATTS_ARRAY_LABEL = {2: "single-axis tracker without backtracking", 3: "single-axis tracker with backtracking"}

DEMO_SITES: list[dict[str, Any]] = [
    {"name": "Kern County placeholder", "lat": 35.40, "lon": -119.47},
    {"name": "Tracy / Tesla 500 kV substation area", "lat": 37.71, "lon": -121.55},
    {"name": "Westside San Joaquin Valley near Los Banos", "lat": 37.00, "lon": -120.80},
    {"name": "Tehachapi wind area", "lat": 35.05, "lon": -118.30},
    {"name": "Stanford (default start site)", "lat": 37.43, "lon": -122.17},
]


def pvwatts_params(lat: float, lon: float, array_type: int = PVWATTS_ARRAY_TYPE) -> dict[str, Any]:
    """PVWatts v8 inputs with weather.solar_tracker_model's parameters (1.2 kW_dc -> 1 kW_ac nameplate).

    Same tracker geometry, losses, DC/AC ratio and inverter efficiency; with the default
    array_type 2 PVWatts does not backtrack (our model does), see PVWATTS_ARRAY_TYPE.
    """
    return {
        "lat": lat,
        "lon": lon,
        "system_capacity": W.DC_AC_RATIO,  # kW DC
        "module_type": 0,  # standard
        "losses": round(W.SYSTEM_LOSSES * 100, 2),
        "array_type": array_type,
        "tilt": W.AXIS_TILT_DEG,
        "azimuth": W.AXIS_AZIMUTH_DEG,
        "dc_ac_ratio": W.DC_AC_RATIO,
        "gcr": W.GCR,
        "inv_eff": round(W.INV_EFF_NOM * 100, 2),
    }


def pvwatts_request_url(lat: float, lon: float, array_type: int = PVWATTS_ARRAY_TYPE) -> str:
    """The PVWatts request as recorded in the sidecar (api_key deliberately omitted)."""
    return f"{PVWATTS_URL}?{httpx.QueryParams(pvwatts_params(lat, lon, array_type))}"


def fetch_pvwatts(
    lat: float, lon: float, array_type: int = PVWATTS_ARRAY_TYPE, timeout: float = 30.0
) -> dict[str, Any] | None:
    """Annual/monthly PVWatts v8 result, or None if unreachable. The API key never leaves this function."""
    params = pvwatts_params(lat, lon, array_type)
    api_key = os.environ.get("NLR_API_KEY") or "DEMO_KEY"
    try:
        resp = httpx.get(PVWATTS_URL, params={"api_key": api_key, **params}, timeout=timeout)
        resp.raise_for_status()
        body = resp.json()
    except (httpx.HTTPError, ValueError) as exc:
        msg = str(exc).splitlines()[0].replace(api_key, "***")  # httpx errors embed the full URL, key included
        print(f"  PVWatts unavailable for {lat}, {lon}: {type(exc).__name__}: {msg}", file=sys.stderr)
        return None
    out = body.get("outputs") or {}
    if body.get("errors") or "ac_annual" not in out:
        print(f"  PVWatts error for {lat}, {lon}: {body.get('errors')}", file=sys.stderr)
        return None
    st = body.get("station_info") or {}
    return {
        "ac_annual_kwh": round(float(out["ac_annual"]), 2),
        "capacity_factor_pct": round(float(out["capacity_factor"]), 3),  # PVWatts: AC kWh / (kW_dc * 8760)
        "solrad_annual_kwh_m2_day": round(float(out.get("solrad_annual", 0.0)), 3),
        "ac_monthly_kwh": [round(float(x), 2) for x in out.get("ac_monthly", [])],
        "array_type": array_type,
        "version": body.get("version"),
        "weather_data_source": st.get("weather_data_source"),
        "station": {k: st.get(k) for k in ("lat", "lon", "elev", "distance", "solar_resource_file")},
        "request_url": pvwatts_request_url(lat, lon, array_type),
    }


def compare(ours_cf_ac: float, pvw: dict[str, Any] | None) -> dict[str, Any] | None:
    """PVWatts vs our model on both CF bases (DC basis is PVWatts' own convention)."""
    if pvw is None:
        return None
    array_type = pvw.get("array_type")
    baseline = PVWATTS_ARRAY_LABEL.get(array_type, f"array_type {array_type}")
    pvw_dc = pvw["capacity_factor_pct"] / 100.0
    pvw_ac = pvw["ac_annual_kwh"] / (1.0 * 8760.0)  # 1 kW_ac nameplate, TMY = 8760 h
    ours_dc = ours_cf_ac / W.DC_AC_RATIO
    return {
        **pvw,
        "pvwatts_cf_dc": round(pvw_dc, 4),
        "pvwatts_cf_ac": round(pvw_ac, 4),
        "ours_cf_dc": round(ours_dc, 4),
        "ours_cf_ac": round(ours_cf_ac, 4),
        "diff_cf_points_dc": round((ours_dc - pvw_dc) * 100.0, 2),  # ours - PVWatts, percentage points
        "ratio_ours_to_pvwatts": round(ours_dc / pvw_dc, 4) if pvw_dc > 0 else None,
        "note": (
            f"PVWatts baseline: {baseline}; ours backtracks (no row shading). PVWatts uses an NSRDB TMY "
            "year; ours is Open-Meteo 2024 actuals. Expect a few CF points of spread."
        ),
    }


def _previous_pvwatts(json_path: Path, lat: float, lon: float, array_type: int) -> dict[str, Any] | None:
    """The PVWatts record already in this site's sidecar, if it came from the identical request."""
    try:
        old = json.loads(json_path.read_text()).get("pvwatts")
    except (OSError, ValueError):
        return None
    if not isinstance(old, dict) or old.get("request_url") != pvwatts_request_url(lat, lon, array_type):
        return None
    return {**old, "array_type": array_type, "reused_from_previous_bake": True}


def bake_site(
    name: str, lat: float, lon: float, year: int = YEAR, pvwatts: bool = True, array_type: int = PVWATTS_ARRAY_TYPE
) -> dict[str, Any]:
    """Fetch, model, validate and write one site. Returns its index entry.

    pvwatts=False skips the API call; either way a matching earlier PVWatts result is kept.
    """
    key = W.site_key(lat, lon)
    print(f"{key}  {name}")
    df = None
    for attempt in range(3):
        try:
            df = W.build_site_frame(lat, lon, year, timeout=30.0)
            break
        except W.WeatherUnavailable as exc:
            print(f"  Open-Meteo attempt {attempt + 1} failed: {exc}", file=sys.stderr)
            time.sleep(3 * (attempt + 1))
    if df is None:
        raise W.WeatherUnavailable(f"could not fetch {name} ({key}) {year}")
    meta: dict[str, Any] = {"name": name, **df.attrs["meta"]}
    csv_path, json_path = W.site_paths(lat, lon, year, W.SITES_DIR)
    pvw = fetch_pvwatts(lat, lon, array_type) if pvwatts else None
    if pvw is None and (pvw := _previous_pvwatts(json_path, lat, lon, array_type)) is not None:
        print("  keeping the previous PVWatts result for this exact request", file=sys.stderr)
    meta["pvwatts"] = compare(meta["solar_cf"], pvw)
    W.write_site_frame(df, meta, csv_path, json_path)
    p = meta["pvwatts"]
    pv_txt = (
        f"PVWatts CF_dc {p['pvwatts_cf_dc']:.4f} vs ours {p['ours_cf_dc']:.4f} ({p['diff_cf_points_dc']:+.2f} pts)"
        if p else "PVWatts n/a"
    )
    print(f"  solar CF_ac {meta['solar_cf']:.4f} (CF_dc {meta['solar_cf_dc']:.4f}), wind CF {meta['wind_cf']:.4f}; {pv_txt}")
    print(f"  -> {csv_path.relative_to(W.DATA_DIR)} ({csv_path.stat().st_size / 1e3:.0f} kB)")
    return {
        "key": key,
        "name": name,
        "lat": lat,
        "lon": lon,
        "year": year,
        "file": csv_path.name,
        "solar_cf": meta["solar_cf"],
        "solar_cf_dc": meta["solar_cf_dc"],
        "wind_cf": meta["wind_cf"],
        "mean_wind100_ms": meta["mean_wind100_ms"],
        "grid_lat": meta["grid_lat"],
        "grid_lon": meta["grid_lon"],
        "elevation_m": meta["elevation_m"],
        "pvwatts": None if p is None else {
            k: p.get(k) for k in (
                "pvwatts_cf_dc", "pvwatts_cf_ac", "ours_cf_dc", "ours_cf_ac", "diff_cf_points_dc", "ac_annual_kwh",
                "array_type", "weather_data_source",
            )
        },
    }


def _write_index(entries: list[dict[str, Any]]) -> None:
    existing: list[dict[str, Any]] = []
    if INDEX_PATH.exists():
        try:
            existing = json.loads(INDEX_PATH.read_text())
        except ValueError:
            existing = []
    merged = {(e["key"], e.get("year", YEAR)): e for e in existing}
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    for e in entries:
        merged[(e["key"], e["year"])] = {**e, "baked_utc": stamp}
    INDEX_PATH.parent.mkdir(parents=True, exist_ok=True)
    INDEX_PATH.write_text(json.dumps(sorted(merged.values(), key=lambda e: (e["year"], e["key"])), indent=2) + "\n")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--lat", type=float, help="bake one extra site instead of the demo list")
    ap.add_argument("--lon", type=float)
    ap.add_argument("--name", default="Custom site")
    ap.add_argument("--year", type=int, default=YEAR)
    ap.add_argument("--no-pvwatts", action="store_true", help="skip the PVWatts call (keeps a matching earlier result)")
    ap.add_argument(
        "--pvwatts-array-type", type=int, choices=sorted(PVWATTS_ARRAY_LABEL), default=PVWATTS_ARRAY_TYPE,
        help="PVWatts baseline: 2 = 1-axis (no backtracking, default), 3 = 1-axis backtracking",
    )
    args = ap.parse_args(argv)
    if (args.lat is None) != (args.lon is None):
        ap.error("--lat and --lon go together")
    sites = DEMO_SITES if args.lat is None else [{"name": args.name, "lat": args.lat, "lon": args.lon}]

    entries = []
    for s in sites:
        entries.append(
            bake_site(s["name"], s["lat"], s["lon"], args.year, pvwatts=not args.no_pvwatts, array_type=args.pvwatts_array_type)
        )
        time.sleep(1.0)  # be polite to the free APIs (PVWatts DEMO_KEY: 30 requests/hour)
    _write_index(entries)
    print(f"index: {INDEX_PATH.relative_to(W.DATA_DIR)} ({len(entries)} site(s) updated)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
