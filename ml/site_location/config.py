"""Paths and defaults for the site-location model.  OWNER: workstream B."""

from __future__ import annotations

from pathlib import Path

PKG_DIR = Path(__file__).resolve().parent
REPO_DIR = PKG_DIR.parents[1]
RUNS_DIR = PKG_DIR / "runs"  # git-ignored: trained models + metrics
CACHE_DIR = PKG_DIR / "cache"  # git-ignored: feature grids
EXPLORE_DIR = REPO_DIR / "data" / "explore"  # grid, plants, population, counties, queue (workstream A's layers)
SITE_INTEL_DIR = REPO_DIR / "data" / "site_intel"  # EPA nonattainment areas (workstream E)
DEMAND_ARTIFACTS_DIR = REPO_DIR / "ml" / "artifacts" / "demand_forecast"  # written by ml/demand_forecast
ARTIFACTS_DIR = REPO_DIR / "ml" / "artifacts" / "site_location"  # our outputs (committed)

CA_ALBERS = "EPSG:3310"
GRID_SPACING_KM = 5.0  # candidate cells; ~17k over California
HV_KV = 220.0  # "220 kV+" = the 230 kV class incl. SCE's 220 kV system (same rule as the Explore summary)

# Technologies we learn siting for: EIA-860 fuel category -> label. Positives are plants of that fuel
# (>= MIN_PLANT_MW, online since MIN_FIRST_YEAR so they reflect today's siting logic).
TECHS = ("solar", "wind", "battery", "gas")
TECH_TO_KIND = {"solar": "solar_pv", "wind": "onshore_wind", "battery": "battery", "gas": "gas_cc"}  # backend AssetKind
SITE_ARTIFACTS_DIR = REPO_DIR / "ml" / "artifacts" / "site_location"
MIN_PLANT_MW = 5.0
MIN_FIRST_YEAR = 2000
NEGATIVES_PER_POSITIVE = 10
NEGATIVE_EXCLUSION_KM = 3.0  # cells this close to a same-tech plant are not used as negatives
SPATIAL_BLOCK_KM = 50.0  # cross-validation groups: neighbours never split across train/test
CV_FOLDS = 5
DEMAND_RADII_KM = (50.0, 150.0)  # "nearby demand" features
