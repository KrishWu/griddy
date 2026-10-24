"""Hourly input profiles for the simulator.  OWNER: workstream B (Simulate + Stress Test).

Everything is read from processed files in data/simulate/ (built offline by app/simulate/prep/)
and cached per process, so simulate() never waits on the network for a pre-baked site. A site
that isn't pre-baked costs one Open-Meteo fetch (cached in data/simulate/cache/); if that fails,
the nearest pre-baked site stands in and the provenance says so.

Time: index i = the hour beginning Jan 1 00:00 PST + i (fixed UTC-8, no DST). Profiles are 2024;
other weather years reuse them (Feb 29 dropped in non-leap years) and say so in provenance.
"""

from __future__ import annotations

import calendar
import json
import logging
import math
from dataclasses import dataclass, field
from functools import lru_cache

import numpy as np
import pandas as pd

from app import DATA_DIR
from app.contract import Provenance, Site

log = logging.getLogger(__name__)

SIM_DIR = DATA_DIR / "simulate"
PROFILE_YEAR = 2024
DLAP = {"pgae": "DLAP_PGAE-APND", "sce": "DLAP_SCE-APND", "sdge": "DLAP_SDGE-APND"}


def n_hours(year: int) -> int:
    return 8784 if calendar.isleap(year) else 8760


def fit_year(x: np.ndarray, year: int) -> np.ndarray:
    """Map a 2024 (leap-year) hourly array onto `year`: drop Feb 29 when the year has 8760 h."""
    if len(x) == n_hours(year):
        return x
    if len(x) == 8784 and n_hours(year) == 8760:
        feb29 = 59 * 24
        return np.concatenate([x[:feb29], x[feb29 + 24 :]])
    raise ValueError(f"cannot fit a {len(x)}-hour profile to {year}")


def _year_note(year: int) -> str | None:
    return None if year == PROFILE_YEAR else f"{PROFILE_YEAR} profiles reused for weather_year {year}"


# ---------------------------------------------------------------------------
# Site weather -> per-MW solar / wind output
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class SiteWeather:
    key: str
    temp_c: np.ndarray
    solar_cf: np.ndarray
    wind_cf: np.ndarray
    provenance: tuple[Provenance, ...]
    note: str | None = None  # set when a stand-in site or synthetic data was used


def _baked_sites() -> list[dict]:
    path = SIM_DIR / "sites" / "index.json"
    if not path.exists():
        return []
    data = json.loads(path.read_text())
    return data if isinstance(data, list) else data.get("sites", [])


def _km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
    return 6371 * 2 * math.asin(math.sqrt(a))


def _weather_provenance(meta: dict, key: str) -> tuple[Provenance, ...]:
    grid = f"grid point {meta['grid_lat']:.3f}, {meta['grid_lon']:.3f}" if meta.get("grid_lat") is not None else key
    pv = meta.get("pvwatts") or {}
    pv_note = (
        f"Solar CF {100 * meta['solar_cf']:.1f}% (AC basis). PVWatts v8 check on a TMY year, DC basis: "
        f"{100 * pv['pvwatts_cf_dc']:.1f}% vs ours {100 * pv['ours_cf_dc']:.1f}%"
        if pv.get("pvwatts_cf_dc") is not None and pv.get("ours_cf_dc") is not None and meta.get("solar_cf") is not None
        else None
    )
    return (
        Provenance(
            kind="observed",
            source=f"Open-Meteo historical weather, {PROFILE_YEAR} hourly ({grid})",
            url="https://open-meteo.com/en/docs/historical-weather-api",
            note="Irradiance, 100 m wind, 2 m temperature; ERA5-based reanalysis",
        ),
        Provenance(
            kind="simulated",
            source="pvlib single-axis tracker (backtracking, GCR 0.35, DC/AC 1.2, 14% losses); CF per MW AC",
            url="https://pvlib-python.readthedocs.io",
            note=pv_note,
        ),
        Provenance(
            kind="simulated",
            source="Generic wind power curve on 100 m wind (cut-in 3, rated 12, cut-out 25 m/s, 12% losses)",
            note=meta.get("wind_caveat"),
        ),
    )


def _synthetic_weather(n: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Last-resort shapes when no real data can be loaded (never expected in the demo)."""
    h = np.arange(n)
    hod, day = h % 24, h // 24
    season = 0.75 + 0.25 * np.sin(2 * np.pi * (day - 80) / 365)
    solar = np.clip(np.sin(np.pi * (hod + 0.5 - 6) / 12), 0, None) * season
    solar = np.clip(solar / max(solar.mean(), 1e-9) * 0.27, 0, 1)
    wind = np.clip(0.30 + 0.10 * np.cos(2 * np.pi * (hod - 2) / 24), 0.02, 0.95)
    temp = 17 + 9 * np.sin(2 * np.pi * (day - 105) / 365) + 6 * np.sin(2 * np.pi * (hod - 9) / 24)
    return temp, solar, wind


@lru_cache(maxsize=64)
def _site_weather_2024(key: str, lat: float, lon: float) -> SiteWeather:
    from app.simulate import weather  # pvlib/httpx only load when a profile is first needed

    try:
        df, meta = weather.load_or_fetch(lat, lon, PROFILE_YEAR, allow_network=True)
        return SiteWeather(
            key=key,
            temp_c=df["temp_c"].to_numpy(float),
            solar_cf=df["solar_cf"].to_numpy(float),
            wind_cf=df["wind_cf"].to_numpy(float),
            provenance=_weather_provenance(meta, key),
        )
    except Exception as exc:  # noqa: BLE001 - any failure falls back to a stand-in site
        log.warning("weather for %s unavailable (%s); falling back", key, exc)

    sites = sorted(_baked_sites(), key=lambda s: _km(lat, lon, s["lat"], s["lon"]))
    for s in sites:
        try:
            df, meta = weather.load_or_fetch(s["lat"], s["lon"], PROFILE_YEAR, allow_network=False)
        except Exception:  # noqa: BLE001
            continue
        km = _km(lat, lon, s["lat"], s["lon"])
        note = f"Weather for {key} unavailable; using nearest pre-baked site {s.get('name', s['key'])} ({km:.0f} km away)"
        return SiteWeather(
            key=key,
            temp_c=df["temp_c"].to_numpy(float),
            solar_cf=df["solar_cf"].to_numpy(float),
            wind_cf=df["wind_cf"].to_numpy(float),
            provenance=_weather_provenance(meta, s["key"]),
            note=note,
        )

    temp, solar, wind = _synthetic_weather(n_hours(PROFILE_YEAR))
    return SiteWeather(
        key=key,
        temp_c=temp,
        solar_cf=solar,
        wind_cf=wind,
        provenance=(Provenance(kind="assumption", source="Synthetic solar/wind/temperature shapes (no weather data available)"),),
        note="No weather data available; synthetic shapes used",
    )


def site_key(lat: float, lon: float) -> str:
    """Cache key: location rounded to 0.01 deg (never the site id). Same as weather.site_key."""
    return f"{lat:.2f}_{lon:.2f}"


def site_weather(lat: float, lon: float, year: int) -> SiteWeather:
    key = site_key(lat, lon)
    w = _site_weather_2024(key, round(lat, 2), round(lon, 2))
    if year == PROFILE_YEAR:
        return w
    return SiteWeather(
        key=w.key,
        temp_c=fit_year(w.temp_c, year),
        solar_cf=fit_year(w.solar_cf, year),
        wind_cf=fit_year(w.wind_cf, year),
        provenance=w.provenance,
        note="; ".join(x for x in (w.note, _year_note(year)) if x),
    )


# ---------------------------------------------------------------------------
# CAISO prices + grid carbon
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class GridProfile:
    price_usd_per_mwh: np.ndarray
    grid_co2_kg_per_mwh: np.ndarray
    cfe_share: np.ndarray
    node: str
    provenance: tuple[Provenance, ...] = field(default_factory=tuple)


@lru_cache(maxsize=1)
def _caiso_frame() -> pd.DataFrame | None:
    path = SIM_DIR / f"caiso_{PROFILE_YEAR}_hourly.csv"
    if not path.exists():
        log.warning("%s missing; using synthetic grid profiles", path)
        return None
    df = pd.read_csv(path)
    assert len(df) == n_hours(PROFILE_YEAR), f"{path} has {len(df)} rows"
    return df


def dlap_for(site: Site) -> str:
    """The load aggregation point a campus in this utility territory buys at (PG&E by default)."""
    t = (site.utility_territory or "").upper().replace("&", "").replace(" ", "")
    if t.startswith("SCE") or "EDISON" in t:
        return "sce"
    if t.startswith("SDGE") or "SANDIEGO" in t:
        return "sdge"
    return "pgae"


def _synthetic_grid(n: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    hod = np.arange(n) % 24
    solar_hours = (hod >= 8) & (hod <= 16)
    price = np.where(solar_hours, 25.0, 70.0) + 25 * np.clip(np.sin(np.pi * (hod - 16) / 6), 0, None)
    co2 = np.where(solar_hours, 150.0, 330.0)
    cfe = np.where(solar_hours, 0.7, 0.4)
    return price, co2, cfe


def grid_profile(site: Site, year: int, price_source: str = "caiso_historical", flat_price: float = 60.0) -> GridProfile:
    n = n_hours(year)
    df = _caiso_frame()
    region = dlap_for(site)
    year_note = _year_note(year)
    if df is None:
        price, co2, cfe = _synthetic_grid(n)
        prov: tuple[Provenance, ...] = (Provenance(kind="assumption", source="Synthetic price/carbon shapes (CAISO file missing)"),)
        node = "synthetic"
    else:
        price = fit_year(df[f"lmp_dlap_{region}"].to_numpy(float), year)
        co2 = fit_year(df["grid_co2_kg_per_mwh"].to_numpy(float), year)
        cfe = fit_year(df["grid_cfe_share"].to_numpy(float), year)
        node = DLAP[region]
        prov = (
            Provenance(
                kind="observed",
                source=f"CAISO {PROFILE_YEAR} day-ahead hourly LMP, {node} (OASIS via gridstatus)",
                url="http://oasis.caiso.com",
                note=year_note,
            ),
            Provenance(
                kind="inferred",
                source=f"CAISO {PROFILE_YEAR} hourly fuel mix x emission factors (gas 0.40 t/MWh, unspecified imports 0.428 t/MWh)",
                url="https://www.caiso.com/todays-outlook/supply",
                note="Average (not marginal) intensity of CAISO supply incl. imports; biomass treated as biogenic (0)",
            ),
        )
    if price_source == "flat":
        price = np.full(n, float(flat_price))
        node = "flat"
        prov = (Provenance(kind="assumption", source=f"Flat energy price ${flat_price:,.0f}/MWh (scenario assumption)"),) + prov[1:]
    return GridProfile(price_usd_per_mwh=price, grid_co2_kg_per_mwh=co2, cfe_share=cfe, node=node, provenance=prov)


# ---------------------------------------------------------------------------
# Community demand shape (EIA-930 PG&E)
# ---------------------------------------------------------------------------


@lru_cache(maxsize=1)
def _community_2024() -> np.ndarray | None:
    path = SIM_DIR / f"eia930_pgae_{PROFILE_YEAR}.csv"
    if not path.exists():
        return None
    return pd.read_csv(path)["shape"].to_numpy(float)


def community_shape(year: int) -> np.ndarray | None:
    s = _community_2024()
    return None if s is None else fit_year(s, year)


COMMUNITY_PROVENANCE = Provenance(
    kind="observed",
    source=f"EIA-930 hourly demand, PG&E sub-region of CAISO, {PROFILE_YEAR} (shape only, scaled to the scenario peak)",
    url="https://www.eia.gov/electricity/gridmonitor/",
)
