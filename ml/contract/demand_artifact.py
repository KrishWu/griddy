"""The demand artifact: what the demand forecast (A) hands to the site-location model (B).  SHARED.

An artifact is a directory, so it can be copied between training machines, committed
under ml/artifacts/demand_forecast/<artifact_id>/, or attached to a PR:

    manifest.json          Manifest (below): what, when, which data, which model, metrics
    county_demand.csv      one row per (geoid, region, scenario, year): annual energy and peaks
    region_hourly.csv.gz   optional: hourly demand per (region, scenario, year), P10/P50/P90

Two kinds exist:
  - "baseline": observed demand for the base year only (scenario "base"), downscaled from
    EIA-930 region load to counties. Needs no trained model, so B can train against it
    while A is still training.
  - "forecast": the base-year rows plus forecast years per scenario, from A's trained model.

B trains on the base year (where plants were actually built vs. demand at the time) and
ranks sites with a forecast year. Units are in column names. Hourly series follow the
backend contract: hour-beginning, fixed UTC-8 (PST) all year, 8760 or 8784 hours.
"""

from __future__ import annotations

import json
import shutil
import tempfile
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Literal

import numpy as np
import pandas as pd

from ml.contract.regions import REGIONS

SCHEMA_VERSION = "1.0"  # bump the major version on any breaking change to the columns below
BASE_SCENARIO = "base"

MANIFEST_FILE = "manifest.json"
COUNTY_FILE = "county_demand.csv"
HOURLY_FILE = "region_hourly.csv.gz"

ArtifactKind = Literal["baseline", "forecast"]
RowKind = Literal["observed_downscaled", "forecast"]

COUNTY_COLUMNS: dict[str, str] = {
    "geoid": "string",  # 5-digit county FIPS, matches data/explore/counties_ca.geojson "geoid"
    "county": "string",  # county name, e.g. "Kern"
    "region": "string",  # a key of ml.contract.regions.REGIONS
    "scenario": "string",  # "base" for observed base-year rows
    "year": "int64",
    "annual_energy_mwh": "float64",
    "avg_mw": "float64",
    "peak_mw_p50": "float64",  # county share of the region's P50 annual peak (coincident with the region peak)
    "peak_mw_p90": "float64",
    "added_load_mw": "float64",  # explicit new load in this county (e.g. data centers) included in the numbers above
    "population_share": "float64",  # share of the region's population in this county (the downscaling weight)
    "kind": "string",  # "observed_downscaled" or "forecast"
}
COUNTY_KEY = ["geoid", "region", "scenario", "year"]

HOURLY_COLUMNS: dict[str, str] = {
    "region": "string",
    "scenario": "string",
    "year": "int64",
    "hour": "int64",  # 0..8759 (8783 in leap years), hour-beginning PST
    "demand_mw_p10": "float64",
    "demand_mw_p50": "float64",
    "demand_mw_p90": "float64",
}
HOURLY_KEY = ["region", "scenario", "year", "hour"]


class ArtifactError(ValueError):
    """The artifact is missing files or breaks the contract."""


@dataclass
class Manifest:
    artifact_id: str  # e.g. "demand-forecast-2026-10-24-a1b2c3"
    kind: ArtifactKind
    base_year: int
    years: list[int]  # every year present in county_demand.csv, base year included
    scenarios: dict[str, dict[str, Any]]  # scenario name -> the assumptions that produced it ("base" -> {})
    created_utc: str
    producer: dict[str, Any]  # {"package": "ml.demand_forecast", "model_version": ..., "git_sha": ...}
    data_vintage: dict[str, Any] = field(default_factory=dict)  # dataset -> version/date
    metrics: dict[str, Any] = field(default_factory=dict)  # held-out accuracy of the model, when kind == "forecast"
    provenance: list[dict[str, Any]] = field(default_factory=list)  # [{kind, source, url, note}] as in the backend contract
    schema_version: str = SCHEMA_VERSION

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> Manifest:
        known = {f for f in cls.__dataclass_fields__}
        missing = {"artifact_id", "kind", "base_year", "years", "scenarios", "created_utc", "producer"} - set(d)
        if missing:
            raise ArtifactError(f"manifest is missing {sorted(missing)}")
        return cls(**{k: v for k, v in d.items() if k in known})


@dataclass
class DemandArtifact:
    manifest: Manifest
    county: pd.DataFrame
    hourly: pd.DataFrame | None = None

    def county_year(self, scenario: str, year: int) -> pd.DataFrame:
        """County rows for one scenario/year, summed over regions (a county can span two)."""
        rows = self.county[(self.county["scenario"] == scenario) & (self.county["year"] == year)]
        if rows.empty:
            raise KeyError(f"no county rows for scenario={scenario!r} year={year}")
        sums = ["annual_energy_mwh", "avg_mw", "peak_mw_p50", "peak_mw_p90", "added_load_mw"]
        return rows.groupby(["geoid", "county"], as_index=False)[sums].sum()

    def growth(self, scenario: str, year: int) -> pd.DataFrame:
        """County demand in `year` minus the base year: the new load that needs new supply."""
        future = self.county_year(scenario, year).set_index(["geoid", "county"])
        base = self.county_year(BASE_SCENARIO, self.manifest.base_year).set_index(["geoid", "county"])
        delta = future.sub(base.reindex(future.index).fillna(0.0)).add_suffix("_growth")
        return future.join(delta).reset_index()


def _coerce(df: pd.DataFrame, columns: dict[str, str], name: str) -> pd.DataFrame:
    missing = [c for c in columns if c not in df.columns]
    if missing:
        raise ArtifactError(f"{name}: missing columns {missing}")
    out = df[list(columns)].copy()
    for col, dtype in columns.items():
        try:
            out[col] = out[col].astype(dtype)
        except (TypeError, ValueError) as exc:
            raise ArtifactError(f"{name}: column {col!r} is not {dtype}: {exc}") from exc
    if out.isna().any().any():
        bad = out.columns[out.isna().any()].tolist()
        raise ArtifactError(f"{name}: null values in {bad}")
    return out


def _validate(manifest: Manifest, county: pd.DataFrame, hourly: pd.DataFrame | None) -> tuple[pd.DataFrame, pd.DataFrame | None]:
    if manifest.schema_version.split(".")[0] != SCHEMA_VERSION.split(".")[0]:
        raise ArtifactError(f"schema {manifest.schema_version} is incompatible with this reader ({SCHEMA_VERSION})")
    if manifest.kind not in ("baseline", "forecast"):
        raise ArtifactError(f"unknown artifact kind {manifest.kind!r}")
    county = _coerce(county, COUNTY_COLUMNS, COUNTY_FILE)

    unknown = set(county["region"]) - set(REGIONS)
    if unknown:
        raise ArtifactError(f"{COUNTY_FILE}: unknown regions {sorted(unknown)}")
    if county.duplicated(COUNTY_KEY).any():
        raise ArtifactError(f"{COUNTY_FILE}: duplicate rows for key {COUNTY_KEY}")
    if not county["geoid"].str.fullmatch(r"\d{5}").all():
        raise ArtifactError(f"{COUNTY_FILE}: geoid must be a 5-digit FIPS string")
    numeric = ["annual_energy_mwh", "avg_mw", "peak_mw_p50", "peak_mw_p90", "added_load_mw", "population_share"]
    vals = county[numeric].to_numpy()
    if not np.isfinite(vals).all() or (vals < 0).any():
        raise ArtifactError(f"{COUNTY_FILE}: numbers must be finite and >= 0")
    if (county["peak_mw_p90"] < county["peak_mw_p50"] - 1e-6).any():
        raise ArtifactError(f"{COUNTY_FILE}: peak_mw_p90 below peak_mw_p50")
    if not set(county["kind"]) <= {"observed_downscaled", "forecast"}:
        raise ArtifactError(f"{COUNTY_FILE}: kind must be observed_downscaled or forecast")

    if set(county["year"]) != set(manifest.years):
        raise ArtifactError(f"{COUNTY_FILE}: years {sorted(set(county['year']))} != manifest years {sorted(manifest.years)}")
    if set(county["scenario"]) != set(manifest.scenarios):
        raise ArtifactError(f"{COUNTY_FILE}: scenarios {sorted(set(county['scenario']))} != manifest {sorted(manifest.scenarios)}")
    base = county[(county["scenario"] == BASE_SCENARIO) & (county["year"] == manifest.base_year)]
    if base.empty:
        raise ArtifactError(f"{COUNTY_FILE}: needs base-year rows (scenario {BASE_SCENARIO!r}, year {manifest.base_year})")
    if manifest.kind == "baseline" and len(manifest.years) != 1:
        raise ArtifactError("a baseline artifact holds the base year only")

    if hourly is not None:
        hourly = _coerce(hourly, HOURLY_COLUMNS, HOURLY_FILE)
        if hourly.duplicated(HOURLY_KEY).any():
            raise ArtifactError(f"{HOURLY_FILE}: duplicate rows for key {HOURLY_KEY}")
        q = hourly[["demand_mw_p10", "demand_mw_p50", "demand_mw_p90"]].to_numpy()
        if not np.isfinite(q).all() or (q < 0).any():
            raise ArtifactError(f"{HOURLY_FILE}: demand must be finite and >= 0")
        if ((q[:, 0] > q[:, 1] + 1e-6) | (q[:, 1] > q[:, 2] + 1e-6)).any():
            raise ArtifactError(f"{HOURLY_FILE}: quantiles must satisfy p10 <= p50 <= p90")
        for (region, scenario, year), g in hourly.groupby(["region", "scenario", "year"]):
            n = 8784 if pd.Timestamp(year=int(year), month=12, day=31).dayofyear == 366 else 8760
            if len(g) != n or g["hour"].min() != 0 or g["hour"].max() != n - 1:
                raise ArtifactError(f"{HOURLY_FILE}: {region}/{scenario}/{year} must have hours 0..{n - 1}")
    return county, hourly


def write_artifact(out_dir: str | Path, manifest: Manifest, county: pd.DataFrame, hourly: pd.DataFrame | None = None) -> Path:
    """Validate and write an artifact directory atomically (a failed write leaves no partial artifact)."""
    county, hourly = _validate(manifest, county, hourly)
    out = Path(out_dir)
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = Path(tempfile.mkdtemp(prefix=f".{out.name}-", dir=out.parent))
    try:
        (tmp / MANIFEST_FILE).write_text(json.dumps(manifest.to_dict(), indent=2, allow_nan=False), encoding="utf-8")
        county.sort_values(COUNTY_KEY).to_csv(tmp / COUNTY_FILE, index=False, float_format="%.3f")
        if hourly is not None:
            hourly.sort_values(HOURLY_KEY).to_csv(tmp / HOURLY_FILE, index=False, float_format="%.2f", compression="gzip")
        if out.exists():
            shutil.rmtree(out)
        tmp.replace(out)
    except BaseException:
        shutil.rmtree(tmp, ignore_errors=True)
        raise
    return out


def read_artifact(path: str | Path, *, load_hourly: bool = True) -> DemandArtifact:
    """Read and validate an artifact directory. Raises ArtifactError with a specific message."""
    p = Path(path)
    if not (p / MANIFEST_FILE).is_file() or not (p / COUNTY_FILE).is_file():
        raise ArtifactError(f"{p} is not a demand artifact (needs {MANIFEST_FILE} and {COUNTY_FILE})")
    manifest = Manifest.from_dict(json.loads((p / MANIFEST_FILE).read_text(encoding="utf-8")))
    county = pd.read_csv(p / COUNTY_FILE, dtype={"geoid": "string"})
    hourly = pd.read_csv(p / HOURLY_FILE) if load_hourly and (p / HOURLY_FILE).is_file() else None
    county, hourly = _validate(manifest, county, hourly)
    return DemandArtifact(manifest=manifest, county=county, hourly=hourly)
