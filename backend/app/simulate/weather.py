"""Real site weather -> per-MW solar and wind capacity factors.  OWNER: workstream B.

Source: Open-Meteo historical archive (best_match = ECMWF IFS ~9 km analysis for
2017+, ERA5 before; no API key). The
contract time convention applies to every array this module returns: index i is
the hour BEGINNING at Jan 1 00:00 PST + i h, fixed UTC-8 ("Etc/GMT+8"), no DST.
Open-Meteo radiation values are the mean of the PRECEDING hour, labelled at the
hour's end, so hour-beginning index i takes label i+1. Instantaneous variables
(temperature, wind) for interval i are mean(label i, label i+1).

Runtime callers use load_or_fetch(): it reads the committed pre-baked file in
data/simulate/sites/ (written by ``python -m app.simulate.prep.sites``), then the
runtime cache in data/simulate/cache/, and only then goes to the network.
Nothing here touches the network at import time. Files are written atomically (temp +
replace), and an unreadable runtime-cache file counts as a miss and is refetched.
"""

from __future__ import annotations

import calendar
import json
import logging
import math
import os
import tempfile
import time
from collections.abc import Callable
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any

import httpx
import numpy as np
import pandas as pd

from app import DATA_DIR

log = logging.getLogger(__name__)

TZ = "Etc/GMT+8"  # fixed UTC-8 (POSIX sign is inverted), never America/Los_Angeles
OPEN_METEO_URL = "https://archive-api.open-meteo.com/v1/archive"
OPEN_METEO_HOURLY = (
    "shortwave_radiation",
    "direct_normal_irradiance",
    "diffuse_radiation",
    "temperature_2m",
    "wind_speed_10m",
    "wind_speed_100m",
)
SITES_DIR = DATA_DIR / "simulate" / "sites"  # committed, pre-baked
CACHE_DIR = DATA_DIR / "simulate" / "cache"  # git-ignored runtime cache
RADIATION_COLUMNS = ("ghi_w_m2", "dni_w_m2", "dhi_w_m2")
MAX_GAP_H = 3  # longest run of missing hours that fill_gaps() interpolates

# Single-axis tracker with backtracking, PVWatts-style inputs. The PVWatts v8 validation in
# prep/sites.py uses the same inputs, but its baseline (array_type 2) is a tracker WITHOUT
# backtracking (PVWatts models its row self-shading instead), so it's a near match, not identical.
AXIS_TILT_DEG = 0.0
AXIS_AZIMUTH_DEG = 180.0
MAX_ANGLE_DEG = 60.0
GCR = 0.35
ALBEDO = 0.2
GAMMA_PDC = -0.0037  # 1/C, PVWatts standard module
SYSTEM_LOSSES = 0.14  # PVWatts default (soiling, shading, mismatch, wiring, LID, availability, ...)
DC_AC_RATIO = 1.2
INV_EFF_NOM = 0.96
SAPM_OPEN_RACK = {"a": -3.56, "b": -0.075, "deltaT": 3.0}  # open_rack_glass_polymer; wind at 10 m

# Generic utility-scale turbine at ~100 m hub height.
CUT_IN_MS = 3.0
RATED_MS = 12.0
CUT_OUT_MS = 25.0
WIND_LOSSES = 0.12  # availability + wake + electrical

CSV_COLUMNS = ["hour", "temp_c", "ghi_w_m2", "wind10_ms", "wind100_ms", "solar_cf", "wind_cf"]


class WeatherUnavailable(RuntimeError):
    """No cached profile and no usable network result: the caller should fall back."""


def site_key(lat: float, lon: float) -> str:
    """Cache key from the location rounded to 0.01 deg (never a site id), e.g. "35.40_-119.47"."""
    la, lo = round(float(lat), 2) + 0.0, round(float(lon), 2) + 0.0  # + 0.0 turns -0.0 into 0.0
    return f"{la:.2f}_{lo:.2f}"


def hour_index(year: int) -> pd.DatetimeIndex:
    """Canonical contract index: hour-beginning, fixed UTC-8, 8760 or 8784 entries."""
    n = 8784 if calendar.isleap(year) else 8760
    return pd.date_range(f"{year}-01-01", periods=n, freq="h", tz=TZ)


def _open_meteo_params(lat: float, lon: float, year: int) -> dict[str, Any]:
    return {
        "latitude": round(float(lat), 4),
        "longitude": round(float(lon), 4),
        "start_date": f"{year}-01-01",
        "end_date": f"{year + 1}-01-01",  # one extra day: hour-beginning Dec 31 23:00 needs label Jan 1 00:00
        "hourly": ",".join(OPEN_METEO_HOURLY),
        "wind_speed_unit": "ms",
        "timezone": TZ,
    }


def _short_gap_mask(df: pd.DataFrame, max_gap_h: int) -> pd.DataFrame:
    """True where a value is missing inside a run of at most `max_gap_h` consecutive NaNs (per column)."""
    out = {}
    for c in df.columns:
        na = df[c].isna().to_numpy()
        run = np.cumsum(~na)  # each NaN run shares the id of the value before it
        out[c] = na & (np.bincount(run, weights=na)[run] <= max_gap_h)
    return pd.DataFrame(out, index=df.index)


def _sun_down_at_midpoint(index: pd.DatetimeIndex, lat: float, lon: float, elevation_m: float | None = None) -> np.ndarray:
    """True where the sun is below the horizon at the interval midpoint (the solar model's night test)."""
    import pvlib  # deferred: only needed when there are gaps

    elev = float(elevation_m) if elevation_m is not None and math.isfinite(float(elevation_m)) else 0.0
    sp = pvlib.solarposition.get_solarposition(
        index + pd.offsets.Minute(30), lat, lon, altitude=elev, pressure=pvlib.atmosphere.alt2pres(elev)
    )
    return sp["apparent_zenith"].to_numpy() >= 90.0


def fill_gaps(df: pd.DataFrame, lat: float, lon: float, elevation_m: float | None = None) -> pd.DataFrame:
    """Fill missing hourly weather, or raise WeatherUnavailable.

    Gaps of up to MAX_GAP_H consecutive hours are linearly interpolated (nearest value at the
    series ends). Longer radiation gaps are zero-filled only where the interval-midpoint sun is
    down; a longer daytime radiation gap or any longer temperature/wind gap raises, so an outage
    can never quietly lower the solar CF.
    """
    df = df.where(~_short_gap_mask(df, MAX_GAP_H), df.interpolate(limit_direction="both"))
    rad = [c for c in RADIATION_COLUMNS if c in df.columns]
    if df[rad].isna().to_numpy().any():
        dark = _sun_down_at_midpoint(df.index, lat, lon, elevation_m)
        df.loc[dark, rad] = df.loc[dark, rad].fillna(0.0)
    left = df.isna()
    if left.to_numpy().any():
        cols = [c for c in df.columns if left[c].any()]
        first = df.index[left.any(axis=1).to_numpy()][0]
        raise WeatherUnavailable(
            f"weather for {site_key(lat, lon)} has gaps longer than {MAX_GAP_H} h in {', '.join(cols)} "
            f"(first at {first:%Y-%m-%d %H:%M} PST)"
        )
    return df


def fetch_open_meteo(lat: float, lon: float, year: int, timeout: float = 20.0) -> pd.DataFrame:
    """Hourly weather on the canonical hour-beginning PST index for `year`.

    Columns: ghi_w_m2, dni_w_m2, dhi_w_m2, temp_c, wind10_ms, wind100_ms. Grid-cell
    metadata (lat/lon/elevation, source URL) is in ``df.attrs``.
    """
    params = _open_meteo_params(lat, lon, year)
    try:
        resp = httpx.get(OPEN_METEO_URL, params=params, timeout=timeout)
        resp.raise_for_status()
        raw = resp.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise WeatherUnavailable(f"Open-Meteo archive request failed for {site_key(lat, lon)} {year}: {exc}") from exc

    if raw.get("utc_offset_seconds") != -28800:
        raise WeatherUnavailable(f"Open-Meteo returned utc_offset_seconds={raw.get('utc_offset_seconds')}, expected -28800")
    hourly = raw.get("hourly") or {}
    labels = pd.DatetimeIndex(pd.to_datetime(hourly.get("time", []))).tz_localize(TZ)
    src = pd.DataFrame({v: pd.to_numeric(pd.Series(hourly.get(v)), errors="coerce").to_numpy() for v in OPEN_METEO_HOURLY}, index=labels)
    src = src[~src.index.duplicated()]

    idx = hour_index(year)
    one_h = pd.offsets.Hour(1)  # pd.Timedelta(hours=1) warns under numpy 2.5
    end = src.reindex(idx + one_h).to_numpy()  # label i+1 = end of interval i
    start = src.reindex(idx).to_numpy()  # label i = start of interval i
    cols = {c: k for k, c in enumerate(OPEN_METEO_HOURLY)}

    def backward_mean(name: str) -> np.ndarray:
        return end[:, cols[name]]

    def interval_mean(name: str) -> np.ndarray:
        return 0.5 * (start[:, cols[name]] + end[:, cols[name]])

    df = pd.DataFrame(
        {
            "ghi_w_m2": backward_mean("shortwave_radiation"),
            "dni_w_m2": backward_mean("direct_normal_irradiance"),
            "dhi_w_m2": backward_mean("diffuse_radiation"),
            "temp_c": interval_mean("temperature_2m"),
            "wind10_ms": interval_mean("wind_speed_10m"),
            "wind100_ms": interval_mean("wind_speed_100m"),
        },
        index=idx,
    )
    missing = int(df.isna().to_numpy().sum())
    if missing > 0.01 * df.size:
        raise WeatherUnavailable(f"Open-Meteo {year} data for {site_key(lat, lon)} is incomplete ({missing} missing values)")
    if missing:
        df = fill_gaps(df, lat, lon, raw.get("elevation"))
    for c in ("ghi_w_m2", "dni_w_m2", "dhi_w_m2", "wind10_ms", "wind100_ms"):
        df[c] = df[c].clip(lower=0.0)
    assert len(df) == len(idx), "weather frame length must match the canonical year"

    query = str(httpx.QueryParams(params))  # no key or secret in this URL
    df.attrs = {
        "grid_lat": raw.get("latitude"),
        "grid_lon": raw.get("longitude"),
        "elevation_m": raw.get("elevation"),
        "utc_offset_seconds": raw.get("utc_offset_seconds"),
        "timezone": raw.get("timezone"),
        "source_url": f"{OPEN_METEO_URL}?{query}",
        "filled_values": missing,
    }
    return df


def solar_tracker_model(
    weather: pd.DataFrame, lat: float, lon: float, elevation_m: float | None = None
) -> pd.DataFrame:
    """Hourly single-axis-tracker model per MW_ac. Columns: poa_w_m2, cell_temp_c, dc_mw, ac_mw.

    Interval means of irradiance are evaluated with solar geometry at the interval
    midpoint (index + 30 min). DC nameplate is DC_AC_RATIO MW per MW_ac.
    """
    import pvlib  # deferred: keeps app import fast

    if elevation_m is None:
        elevation_m = weather.attrs.get("elevation_m")
    elev = float(elevation_m) if elevation_m is not None and math.isfinite(float(elevation_m)) else 0.0
    mid = weather.index + pd.offsets.Minute(30)
    temp = weather["temp_c"].to_numpy(dtype=float)
    ghi = weather["ghi_w_m2"].to_numpy(dtype=float)
    dhi = np.minimum(weather["dhi_w_m2"].to_numpy(dtype=float), ghi)

    sp = pvlib.solarposition.get_solarposition(
        mid, lat, lon, altitude=elev, pressure=pvlib.atmosphere.alt2pres(elev), temperature=temp
    )
    zen = sp["apparent_zenith"].to_numpy()
    azi = sp["azimuth"].to_numpy()
    sun_up = zen < 90.0
    dni_extra = pvlib.irradiance.get_extra_radiation(mid).to_numpy()
    dni = np.clip(weather["dni_w_m2"].to_numpy(dtype=float), 0.0, dni_extra)
    dni = np.where(sun_up, dni, 0.0)

    trk = pvlib.tracking.singleaxis(
        zen, azi, axis_tilt=AXIS_TILT_DEG, axis_azimuth=AXIS_AZIMUTH_DEG,
        max_angle=MAX_ANGLE_DEG, backtrack=True, gcr=GCR,
    )
    tilt = np.nan_to_num(np.asarray(trk["surface_tilt"], dtype=float), nan=0.0)
    surf_az = np.nan_to_num(np.asarray(trk["surface_azimuth"], dtype=float), nan=AXIS_AZIMUTH_DEG)

    poa = pvlib.irradiance.get_total_irradiance(
        tilt, surf_az, zen, azi, dni, ghi, dhi, dni_extra=dni_extra, albedo=ALBEDO, model="haydavies"
    )
    aoi = pvlib.irradiance.aoi(tilt, surf_az, zen, azi)
    beam = np.nan_to_num(np.asarray(poa["poa_direct"], dtype=float), nan=0.0) * np.nan_to_num(pvlib.iam.physical(aoi), nan=0.0)
    diffuse = np.nan_to_num(np.asarray(poa["poa_diffuse"], dtype=float), nan=0.0)
    poa_eff = np.where(sun_up, np.clip(beam + diffuse, 0.0, None), 0.0)

    cell = pvlib.temperature.sapm_cell(poa_eff, temp, weather["wind10_ms"].to_numpy(dtype=float), **SAPM_OPEN_RACK)
    pdc0 = DC_AC_RATIO  # MW_dc per MW_ac
    dc = pvlib.pvsystem.pvwatts_dc(poa_eff, cell, pdc0, GAMMA_PDC) * (1.0 - SYSTEM_LOSSES)
    dc = np.clip(np.nan_to_num(np.asarray(dc, dtype=float), nan=0.0), 0.0, None)
    ac = pvlib.inverter.pvwatts(dc, 1.0 / INV_EFF_NOM, eta_inv_nom=INV_EFF_NOM)  # clips at 1 MW_ac
    ac = np.clip(np.nan_to_num(np.asarray(ac, dtype=float), nan=0.0), 0.0, 1.0)
    ac = np.where(sun_up & (dc > 0), ac, 0.0)
    return pd.DataFrame(
        {"poa_w_m2": poa_eff, "cell_temp_c": np.nan_to_num(np.asarray(cell, dtype=float), nan=0.0), "dc_mw": dc, "ac_mw": ac},
        index=weather.index,
    )


def solar_cf_tracker(weather: pd.DataFrame, lat: float, lon: float, elevation_m: float | None = None) -> np.ndarray:
    """AC output per MW_ac of a single-axis tracker, in [0, 1], 0 at night."""
    return solar_tracker_model(weather, lat, lon, elevation_m)["ac_mw"].to_numpy()


def dc_basis_cf(ac_cf: np.ndarray | float) -> float:
    """Annual CF on the DC basis (AC energy / DC capacity), the PVWatts convention."""
    return float(np.mean(ac_cf)) / DC_AC_RATIO


def wind_cf(wind100_ms: np.ndarray | pd.Series | float) -> np.ndarray:
    """Generic power curve per MW: cubic from cut-in to rated, flat to cut-out, net of WIND_LOSSES."""
    v = np.nan_to_num(np.asarray(wind100_ms, dtype=float), nan=0.0)
    ramp = (v**3 - CUT_IN_MS**3) / (RATED_MS**3 - CUT_IN_MS**3)
    raw = np.where((v >= CUT_IN_MS) & (v < RATED_MS), ramp, 0.0)
    raw = np.where((v >= RATED_MS) & (v <= CUT_OUT_MS), 1.0, raw)
    return np.clip(raw, 0.0, 1.0) * (1.0 - WIND_LOSSES)


def _model_meta() -> dict[str, Any]:
    return {
        "solar_model": (
            f"pvlib single-axis tracker (axis tilt {AXIS_TILT_DEG:g}, azimuth {AXIS_AZIMUTH_DEG:g}, "
            f"+/-{MAX_ANGLE_DEG:g} deg, backtracking, GCR {GCR}), Hay-Davies, albedo {ALBEDO}, physical IAM, "
            f"SAPM open-rack cell temp, PVWatts DC gamma {GAMMA_PDC}, losses {SYSTEM_LOSSES:.0%}, "
            f"DC/AC {DC_AC_RATIO}, inverter eff {INV_EFF_NOM}; CF per MW_ac"
        ),
        "wind_model": (
            f"generic power curve at 100 m: cut-in {CUT_IN_MS:g}, rated {RATED_MS:g}, cut-out {CUT_OUT_MS:g} m/s, "
            f"cubic ramp, losses {WIND_LOSSES:.0%}"
        ),
        "wind_caveat": (
            "Estimate. ~9 km reanalysis winds smooth ridge and pass speed-ups, so wind CF is likely biased low in "
            "complex terrain (Tehachapi, Altamont) versus operating plants; validate against WIND Toolkit or EIA-923."
        ),
    }


def build_site_frame(lat: float, lon: float, year: int, timeout: float = 20.0) -> pd.DataFrame:
    """Fetch weather and compute CFs. Columns CSV_COLUMNS, index 0..n-1; metadata in ``df.attrs["meta"]``."""
    w = fetch_open_meteo(lat, lon, year, timeout=timeout)
    solar = solar_cf_tracker(w, lat, lon, w.attrs.get("elevation_m"))
    wind = wind_cf(w["wind100_ms"])
    n = len(w)
    df = pd.DataFrame(
        {
            "hour": np.arange(n),
            "temp_c": w["temp_c"].round(2).to_numpy(),
            "ghi_w_m2": w["ghi_w_m2"].round(2).to_numpy(),
            "wind10_ms": w["wind10_ms"].round(2).to_numpy(),
            "wind100_ms": w["wind100_ms"].round(2).to_numpy(),
            "solar_cf": np.round(solar, 4),
            "wind_cf": np.round(wind, 4),
        }
    )
    if not np.isfinite(df.to_numpy(dtype=float)).all():
        raise WeatherUnavailable(f"non-finite values in the site frame for {site_key(lat, lon)} {year}")
    meta: dict[str, Any] = {
        "site_key": site_key(lat, lon),
        "year": year,
        "n_hours": n,
        "start": f"{year}-01-01T00:00:00-08:00",
        "time_convention": (
            "index i = hour beginning Jan 1 00:00 PST + i h (fixed UTC-8, no DST); radiation uses Open-Meteo "
            "label i+1 (preceding-hour mean); temperature/wind = mean(label i, label i+1)"
        ),
        "requested_lat": float(lat),
        "requested_lon": float(lon),
        "grid_lat": w.attrs.get("grid_lat"),
        "grid_lon": w.attrs.get("grid_lon"),
        "elevation_m": w.attrs.get("elevation_m"),
        "source": (
            "Open-Meteo historical weather archive, best_match model (ECMWF IFS ~9 km analysis for 2017+, "
            "ERA5 before)"
        ),
        "source_url": w.attrs.get("source_url"),
        "fetched_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "filled_values": w.attrs.get("filled_values", 0),
        "solar_cf": round(float(solar.mean()), 4),
        "solar_cf_dc": round(dc_basis_cf(solar), 4),
        "wind_cf": round(float(wind.mean()), 4),
        "mean_temp_c": round(float(w["temp_c"].mean()), 2),
        "mean_wind100_ms": round(float(w["wind100_ms"].mean()), 2),
        **_model_meta(),
    }
    df.attrs["meta"] = meta
    return df


def site_paths(lat: float, lon: float, year: int, directory: Path) -> tuple[Path, Path]:
    """(csv, json sidecar) paths for a site-year inside `directory`."""
    stem = f"{site_key(lat, lon)}_{year}"
    return directory / f"{stem}.csv", directory / f"{stem}.json"


def _replace_atomic(path: Path, write: Callable[[Path], object]) -> None:
    """write(tmp_path) into a unique sibling temp file, then rename it onto `path` (atomic on
    one filesystem), so a crash, reload or concurrent writer never leaves a half-written file."""
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    os.close(fd)
    try:
        write(Path(tmp))
        Path(tmp).replace(path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def write_site_frame(df: pd.DataFrame, meta: dict[str, Any], csv_path: Path, json_path: Path) -> None:
    """JSON sidecar first, CSV last: a CSV on disk implies its metadata is complete."""
    csv_path.parent.mkdir(parents=True, exist_ok=True)
    _replace_atomic(json_path, lambda tmp: tmp.write_text(json.dumps(meta, indent=2) + "\n"))
    _replace_atomic(csv_path, lambda tmp: df[CSV_COLUMNS].to_csv(tmp, index=False))


def _data_path(path: Path) -> str:
    """Path relative to data/ for metadata (absolute if it lives elsewhere, e.g. a test dir)."""
    return str(path.relative_to(DATA_DIR)) if path.is_relative_to(DATA_DIR) else str(path)


@lru_cache(maxsize=16)
def _read_site(csv_path: str, json_path: str, mtime_ns: int) -> tuple[pd.DataFrame, dict[str, Any]]:
    df = pd.read_csv(csv_path)
    meta: dict[str, Any] = {}
    if Path(json_path).exists():
        meta = json.loads(Path(json_path).read_text())
    return df, meta


def load_or_fetch(lat: float, lon: float, year: int, allow_network: bool = True) -> tuple[pd.DataFrame, dict]:
    """Site frame (CSV_COLUMNS, index 0..n-1) and its metadata.

    Order: committed data/simulate/sites/ -> runtime data/simulate/cache/ -> Open-Meteo
    (only if allow_network; written to the cache). Raises WeatherUnavailable otherwise.
    A bad pre-baked file raises (fix the bake); a bad runtime-cache file (e.g. a write cut
    short before writes were atomic) is a miss, and the refetch overwrites it.
    """
    n = len(hour_index(year))
    for directory, origin in ((SITES_DIR, "pre-baked"), (CACHE_DIR, "runtime cache")):
        csv_path, json_path = site_paths(lat, lon, year, directory)
        if not csv_path.exists():
            continue
        try:
            df, meta = _read_site(str(csv_path), str(json_path), csv_path.stat().st_mtime_ns)
            if len(df) != n or not set(CSV_COLUMNS) <= set(df.columns):
                raise ValueError(f"{len(df)} rows or wrong columns; expected {n} rows of {', '.join(CSV_COLUMNS)}")
            if not np.isfinite(df[CSV_COLUMNS].to_numpy(dtype=float)).all():
                raise ValueError("missing or non-numeric values")
        except (OSError, ValueError) as exc:
            if directory == SITES_DIR:
                raise WeatherUnavailable(f"pre-baked {csv_path.name} is unusable: {exc}") from exc
            log.warning("ignoring unusable cache file %s (%s); refetching", csv_path.name, exc)
            continue
        return df.copy(), {**meta, "origin": origin, "path": _data_path(csv_path)}

    if not allow_network:
        raise WeatherUnavailable(f"no cached weather for {site_key(lat, lon)} {year} and network disabled")
    t0 = time.perf_counter()
    df = build_site_frame(lat, lon, year, timeout=10.0)
    meta = dict(df.attrs.get("meta", {}))
    csv_path, json_path = site_paths(lat, lon, year, CACHE_DIR)
    try:
        write_site_frame(df, meta, csv_path, json_path)
    except OSError:
        pass  # read-only deploy: still return the fetched frame
    df.attrs = {}
    return df, {**meta, "origin": "network", "fetch_s": round(time.perf_counter() - t0, 2)}
