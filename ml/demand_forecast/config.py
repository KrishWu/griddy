"""Paths, sources and defaults for the demand forecast.  OWNER: workstream A."""

from __future__ import annotations

from pathlib import Path

PKG_DIR = Path(__file__).resolve().parent
REPO_DIR = PKG_DIR.parents[1]
RAW_DIR = PKG_DIR / "data" / "raw"  # git-ignored: EIA-930 files
CACHE_DIR = PKG_DIR / "cache"  # git-ignored: weather, region geography
RUNS_DIR = PKG_DIR / "runs"  # git-ignored: trained models + metrics
EXPLORE_DIR = REPO_DIR / "data" / "explore"  # workstream A's committed GIS layers
ARTIFACTS_DIR = REPO_DIR / "ml" / "artifacts" / "demand_forecast"  # committed, read by ml/site_location

FIRST_YEAR = 2019  # EIA-930 sub-region data starts in 2019 (CAISO sub-regions from 2018-07)
BASE_YEAR = 2024  # last full year: the level that scenario growth starts from
VALID_YEAR = 2024  # early stopping
TEST_FROM_YEAR = 2025  # held out entirely: the honest accuracy number
FORECAST_YEARS = (2030, 2035, 2040)
QUANTILES = (0.1, 0.5, 0.9)

EIA930_URL = "https://www.eia.gov/electricity/gridmonitor/sixMonthFiles/EIA930_{kind}_{year}_{half}.csv"
EIA930_PAGE = "https://www.eia.gov/electricity/gridmonitor/"
OPEN_METEO_URL = "https://archive-api.open-meteo.com/v1/archive"  # ERA5-based reanalysis, no key needed
WEATHER_VARS = ("temperature_2m", "relative_humidity_2m", "dew_point_2m", "shortwave_radiation", "wind_speed_10m")
BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"

CA_ALBERS = "EPSG:3310"
WEATHER_POINTS_PER_REGION = 6  # population-weighted centres of the region's most populous counties (>= 4% share each)

# California Department of Finance county population projections (P-2A, 2024 baseline, 2020-2070)
DOF_P2A_URL = "https://dof.ca.gov/media/docs/forecasting/Demographics/projections/P2A_County_Total.xlsx"
DOF_P2A_PAGE = "https://dof.ca.gov/forecasting/demographics/projections/"
DOF_P2A_FILE = RAW_DIR / "P2A_County_Total.xlsx"
