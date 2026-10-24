"""Training frame: hourly regional load + weather + calendar features.  OWNER: workstream A.

Target. The model learns the *shape* of load, not its level: y = load / mean load of that
region and calendar year. The level comes from the base year's observed load times the
scenario growth (scenarios.py). That split keeps the ML part testable on held-out years
and keeps long-term growth an explicit, labelled assumption instead of a tree model
extrapolating a trend it can't see.

Time. Rows are hour-beginning. ts_utc is UTC; ts_pst is fixed UTC-8 (no DST), matching the
backend contract. Calendar features use local clock time (PST) because that's what
people live by; DST shifts are close enough for a load-shape model.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from ml.contract.regions import REGIONS
from ml.demand_forecast.config import FIRST_YEAR, RAW_DIR, WEATHER_VARS
from ml.demand_forecast.fetch_data import EIA_KINDS, HALVES, eia_path, weather_path
from ml.demand_forecast.geo import RegionGeo

REGION_IDS = list(REGIONS)  # fixed category order: training and prediction must agree
_SUBREGION_TO_REGION = {r.eia_subregion: r.id for r in REGIONS.values() if r.eia_subregion}
_BA_TO_REGION = {r.eia_ba: r.id for r in REGIONS.values() if r.eia_subregion is None}

FEATURES = [
    "region",
    "hour",
    "dow",
    "is_weekend",
    "is_holiday",
    "month",
    "doy_sin",
    "doy_cos",
    "trend_year",
    "temp_c",
    "rh_pct",
    "dew_c",
    "ghi_wm2",
    "wind_ms",
    "temp_lag1",
    "temp_lag3",
    "temp_mean24",
    "temp_max24",
    "temp_mean72",
    "cdd",
    "hdd",
    "cdd_mean24",
    "ghi_mean3",
]
TARGET = "ratio"
_WEATHER_RENAME = {
    "temperature_2m": "temp_c",
    "relative_humidity_2m": "rh_pct",
    "dew_point_2m": "dew_c",
    "shortwave_radiation": "ghi_wm2",
    "wind_speed_10m": "wind_ms",
}


# ---------------------------------------------------------------- EIA-930 load


def parse_eia930(path, kind: str) -> pd.DataFrame:
    """One EIA-930 six-month file -> [region, ts_utc, demand_mw] for our regions."""
    df = pd.read_csv(path, thousands=",", low_memory=False)
    if kind == "SUBREGION":
        df = df[(df["Balancing Authority"] == "CISO") & df["Sub-Region"].isin(_SUBREGION_TO_REGION)]
        region = df["Sub-Region"].map(_SUBREGION_TO_REGION)
        demand = pd.to_numeric(df["Demand (MW)"], errors="coerce")
    else:
        df = df[df["Balancing Authority"].isin(_BA_TO_REGION)]
        region = df["Balancing Authority"].map(_BA_TO_REGION)
        # EIA's adjusted series (outliers and gaps repaired) when the file has it, raw otherwise.
        demand = pd.to_numeric(df["Demand (MW)"], errors="coerce")
        if "Demand (MW) (Adjusted)" in df:
            demand = pd.to_numeric(df["Demand (MW) (Adjusted)"], errors="coerce").fillna(demand)
    end_utc = pd.to_datetime(df["UTC Time at End of Hour"], format="%m/%d/%Y %I:%M:%S %p")
    return pd.DataFrame({"region": region.to_numpy(), "ts_utc": (end_utc - pd.Timedelta(hours=1)).to_numpy(), "demand_mw": demand.to_numpy()})


def clean_load(df: pd.DataFrame) -> pd.DataFrame:
    """Drop impossible values and spikes (> 2x or < 0.4x the region's trailing-week median)."""
    df = df.drop_duplicates(["region", "ts_utc"]).sort_values(["region", "ts_utc"]).copy()
    df.loc[df["demand_mw"] <= 0, "demand_mw"] = np.nan
    med = df.groupby("region")["demand_mw"].transform(lambda s: s.rolling(168, min_periods=24, center=True).median())
    ratio = df["demand_mw"] / med
    df.loc[(ratio > 2.0) | (ratio < 0.4), "demand_mw"] = np.nan
    return df


def load_eia930(years: list[int] | None = None) -> pd.DataFrame:
    frames = []
    for path in sorted(RAW_DIR.glob("EIA930_*.csv")):
        kind, year = path.stem.split("_")[1], int(path.stem.split("_")[2])
        if kind in EIA_KINDS and (years is None or year in years):
            frames.append(parse_eia930(path, kind))
    if not frames:
        raise FileNotFoundError(f"no EIA-930 files in {RAW_DIR}: run python -m ml.demand_forecast.fetch_data first")
    return clean_load(pd.concat(frames, ignore_index=True))


def expected_files(years: list[int]) -> list[str]:
    return [eia_path(k, y, h).name for y in years for h in HALVES for k in EIA_KINDS]


# ---------------------------------------------------------------- weather


def load_weather(geo: RegionGeo) -> pd.DataFrame:
    """Population-weighted hourly weather per region: [region, ts_utc, temp_c, ...]."""
    frames = []
    for region, pts in geo.weather_points.items():
        acc = None
        for i, p in enumerate(pts):
            path = weather_path(region, i)
            if not path.is_file():
                raise FileNotFoundError(f"{path} missing: run python -m ml.demand_forecast.fetch_data --only weather")
            w = pd.read_csv(path, parse_dates=["time"]).set_index("time")[list(WEATHER_VARS)].astype(float)
            acc = w * p["weight"] if acc is None else acc.add(w * p["weight"], fill_value=np.nan)
        acc = acc.rename(columns=_WEATHER_RENAME).reset_index().rename(columns={"time": "ts_utc"})
        acc["region"] = region
        frames.append(acc)
    return pd.concat(frames, ignore_index=True)


# ---------------------------------------------------------------- features


def _holidays(years) -> set:
    import holidays

    return set(holidays.country_holidays("US", subdiv="CA", years=sorted(set(int(y) for y in years))))


def add_features(df: pd.DataFrame, trend_year_max: int | None = None) -> pd.DataFrame:
    """Calendar + weather features. df: one row per (region, hour) with ts_utc and weather columns,
    contiguous in time per region (lags assume consecutive hours)."""
    df = df.sort_values(["region", "ts_utc"]).reset_index(drop=True)
    ts_pst = df["ts_utc"] - pd.Timedelta(hours=8)
    df["ts_pst"] = ts_pst
    df["hour"] = ts_pst.dt.hour
    df["dow"] = ts_pst.dt.day_of_week
    df["is_weekend"] = (df["dow"] >= 5).astype(int)
    hol = _holidays(ts_pst.dt.year.unique())
    df["is_holiday"] = ts_pst.dt.date.isin(hol).astype(int)
    df["month"] = ts_pst.dt.month
    doy = ts_pst.dt.day_of_year.to_numpy()
    df["doy_sin"] = np.sin(2 * np.pi * doy / 366.0)
    df["doy_cos"] = np.cos(2 * np.pi * doy / 366.0)
    year = ts_pst.dt.year
    # Behind-the-meter solar keeps reshaping midday load year by year. Trees can't extrapolate
    # a year they haven't seen, so forecasts clamp this to the last training year.
    df["trend_year"] = year.clip(upper=trend_year_max) if trend_year_max else year

    g = df.groupby("region", sort=False)["temp_c"]
    df["temp_lag1"] = g.shift(1)
    df["temp_lag3"] = g.shift(3)
    df["temp_mean24"] = g.transform(lambda s: s.rolling(24, min_periods=12).mean())
    df["temp_max24"] = g.transform(lambda s: s.rolling(24, min_periods=12).max())
    df["temp_mean72"] = g.transform(lambda s: s.rolling(72, min_periods=36).mean())
    df["cdd"] = (df["temp_c"] - 18.0).clip(lower=0)
    df["hdd"] = (18.0 - df["temp_c"]).clip(lower=0)
    df["cdd_mean24"] = df.groupby("region", sort=False)["cdd"].transform(lambda s: s.rolling(24, min_periods=12).mean())
    df["ghi_mean3"] = df.groupby("region", sort=False)["ghi_wm2"].transform(lambda s: s.rolling(3, min_periods=1).mean())
    df["region"] = pd.Categorical(df["region"], categories=REGION_IDS)
    return df


def build_training_frame(load: pd.DataFrame, weather: pd.DataFrame, min_coverage: float = 0.8) -> pd.DataFrame:
    """Join load and weather, add features and the normalized target. Region-years with less than
    `min_coverage` of their hours observed are dropped (their annual mean would be biased)."""
    full = weather.merge(load, on=["region", "ts_utc"], how="left")
    full = full[(full["ts_utc"] - pd.Timedelta(hours=8)).dt.year >= FIRST_YEAR]
    full = add_features(full)
    full["year"] = full["ts_pst"].dt.year
    stats = full.groupby(["region", "year"], observed=True)["demand_mw"].agg(["mean", "count", "size"])
    stats["coverage"] = stats["count"] / stats["size"]
    good = stats[stats["coverage"] >= min_coverage]
    full = full.merge(good["mean"].rename("year_mean_mw").reset_index(), on=["region", "year"], how="inner")
    full[TARGET] = full["demand_mw"] / full["year_mean_mw"]
    return full.dropna(subset=[TARGET, "temp_lag3", "temp_mean72"]).reset_index(drop=True)


def year_hours_pst(year: int) -> pd.DatetimeIndex:
    """Hour-beginning PST timestamps of a calendar year: 8760 or 8784."""
    return pd.date_range(f"{year}-01-01", f"{year + 1}-01-01", freq="h", inclusive="left")


def features_for_year(weather: pd.DataFrame, region: str, target_year: int, weather_year: int, trend_year_max: int) -> pd.DataFrame:
    """Features for every hour of `target_year` in `region`, replaying the weather of `weather_year`
    on the target year's calendar (weekdays and holidays come from the target year)."""
    w = weather[weather["region"] == region].copy()
    w["ts_pst"] = w["ts_utc"] - pd.Timedelta(hours=8)
    w = w.set_index("ts_pst")
    target = year_hours_pst(target_year)
    src = pd.DatetimeIndex(
        [t.replace(year=weather_year, day=28) if (t.month == 2 and t.day == 29) else t.replace(year=weather_year) for t in target]
    )
    # Three days of lead-in so the 72 h rolling features are defined from the first hour.
    lead = pd.date_range(src[0] - pd.Timedelta(hours=72), src[0], freq="h", inclusive="left")
    cols = list(_WEATHER_RENAME.values())
    replay = w.reindex(lead.append(src))[cols].interpolate(limit_direction="both")
    if replay[cols].isna().any().any():
        raise ValueError(f"weather for {region} {weather_year} is missing: refetch it")
    frame = replay.reset_index(drop=True)
    frame["region"] = region
    # Timestamps follow the target calendar (lead-in = the 72 h before Jan 1); values are the replayed weather.
    lead_target = pd.date_range(target[0] - pd.Timedelta(hours=72), target[0], freq="h", inclusive="left")
    frame["ts_utc"] = lead_target.append(target) + pd.Timedelta(hours=8)
    out = add_features(frame, trend_year_max=trend_year_max).iloc[len(lead) :].reset_index(drop=True)
    assert len(out) == len(target)
    return out
