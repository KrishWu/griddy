"""County population projections (CA Department of Finance, Report P-2A).  OWNER: workstream A.

Scenario growth uses each county's projected population instead of one statewide rate, so
counties that DOF expects to grow (Inland Empire, Central Valley) gain demand faster than
shrinking ones. The table also ships in the demand artifact (county_population.csv) so the
website's what-if recomputes the same way.
"""

from __future__ import annotations

import pandas as pd

from ml.demand_forecast.config import DOF_P2A_FILE


def load_dof_projections(path=DOF_P2A_FILE) -> pd.DataFrame:
    """[geoid ("06029"), year, population] for the 58 counties, one row per county-year."""
    if not path.is_file():
        raise FileNotFoundError(f"{path} missing: run python -m ml.demand_forecast.fetch_data --only dof")
    raw = pd.read_excel(path, sheet_name="Data", header=1)
    raw = raw[pd.to_numeric(raw["FIPS"], errors="coerce").notna()]
    raw = raw[(raw["FIPS"].astype(int) != 6000) & (raw["Age"] == "ALL AGES") & (raw["Sex"] == "ALL SEXES")]
    years = [c for c in raw.columns if str(c).replace(".0", "").isdigit() and 2000 < float(c) < 2100]  # "2020" or 2020
    long = raw.melt(id_vars=["FIPS"], value_vars=years, var_name="year", value_name="population")
    long["geoid"] = long["FIPS"].astype(int).map(lambda f: f"{f:05d}")
    long["year"] = long["year"].astype(float).astype(int)
    out = long[["geoid", "year", "population"]].astype({"population": float}).sort_values(["geoid", "year"]).reset_index(drop=True)
    if out["geoid"].nunique() != 58:
        raise ValueError(f"expected 58 counties in {path.name}, found {out['geoid'].nunique()}")
    return out


def population_factor(pop: pd.DataFrame, base_year: int, year: int) -> pd.Series:
    """geoid -> population(year) / population(base_year); years past the table use its last year."""
    last = int(pop["year"].max())
    p = pop.set_index(["geoid", "year"])["population"]
    return (p.xs(min(year, last), level="year") / p.xs(min(base_year, last), level="year")).rename("population_factor")
