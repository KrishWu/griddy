"""Long-term demand scenarios: explicit assumptions, not learned.  OWNER: workstream A.

Annual energy of county c in year y, before new data centers:
    E_c(y) = E_c(base) x population_factor_c(y) x (1 + electrification_growth - efficiency_offset) ** (y - base)
population_factor_c is CA DOF's projected population ratio for that county (use_dof_population, the
default) or (1 + population_growth) ** (y - base). With a calibration CSV (columns region, year,
annual_energy_gwh, e.g. from the CEC 2025 IEPR forecast) the region's total follows E_cal(y) / E_cal(base)
instead. New data-center load is added per county, flat at peak x load factor; the flexible share of it
(carbon-aware scheduling) is assumed to move out of the peak hour, so it adds energy but not peak.

The website's what-if (backend/app/forecast) implements the same formulas from the artifact files.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import pandas as pd

from ml.contract.regions import REGIONS
from ml.demand_forecast.config import PKG_DIR
from ml.demand_forecast.population import population_factor

DEFAULT_SCENARIOS = PKG_DIR / "scenarios.json"


@dataclass
class Scenario:
    name: str
    population_growth: float = 0.0
    use_dof_population: bool = True
    electrification_growth: float = 0.0
    efficiency_offset: float = 0.0
    data_center_mw: dict[str, float] = field(default_factory=dict)  # county geoid -> MW of new peak load
    data_center_load_factor: float = 0.9
    data_center_flexible_share: float = 0.0
    calibration_csv: str | None = None
    note: str = ""
    _calibration: pd.DataFrame | None = field(default=None, repr=False)

    def __post_init__(self) -> None:
        if not -0.2 < self.per_capita_rate < 0.2 or not -0.2 < self.population_growth < 0.2:
            raise ValueError(f"scenario {self.name}: growth rates must be within +/-20%/yr")
        if not 0 < self.data_center_load_factor <= 1 or not 0 <= self.data_center_flexible_share <= 1:
            raise ValueError(f"scenario {self.name}: data_center_load_factor in (0, 1], flexible share in [0, 1]")
        for geoid, mw in self.data_center_mw.items():
            if len(geoid) != 5 or not geoid.isdigit() or mw < 0:
                raise ValueError(f"scenario {self.name}: data_center_mw needs 5-digit county FIPS -> MW >= 0, got {geoid}: {mw}")
        if self.calibration_csv:
            cal = pd.read_csv(self.calibration_csv)
            missing = {"region", "year", "annual_energy_gwh"} - set(cal.columns)
            if missing:
                raise ValueError(f"{self.calibration_csv} is missing columns {sorted(missing)}")
            unknown = set(cal["region"]) - set(REGIONS)
            if unknown:
                raise ValueError(f"{self.calibration_csv}: unknown regions {sorted(unknown)}")
            self._calibration = cal

    @property
    def per_capita_rate(self) -> float:
        return self.electrification_growth - self.efficiency_offset

    def calibrated_factor(self, region: str, base_year: int, year: int) -> float | None:
        if self._calibration is None:
            return None
        c = self._calibration[self._calibration["region"] == region].sort_values("year")
        if len(c) < 2:
            return None
        e = np.interp([base_year, year], c["year"], c["annual_energy_gwh"])
        return float(e[1] / e[0])

    def county_factors(self, geoids: pd.Series, base_year: int, year: int, dof: pd.DataFrame | None) -> pd.Series:
        """Energy growth factor per county (same index as geoids), before new data centers."""
        n = year - base_year
        per_capita = (1.0 + self.per_capita_rate) ** n
        if self.use_dof_population and dof is not None:
            pop = geoids.map(population_factor(dof, base_year, year)).fillna((1.0 + self.population_growth) ** n)
        else:
            pop = pd.Series((1.0 + self.population_growth) ** n, index=geoids.index)
        return (pop * per_capita).astype(float)

    def assumptions(self) -> dict:
        """What goes into the artifact manifest, so the website can show and reuse the assumptions."""
        return {
            "population_growth": self.population_growth,
            "use_dof_population": self.use_dof_population,
            "electrification_growth": self.electrification_growth,
            "efficiency_offset": self.efficiency_offset,
            "data_center_mw": self.data_center_mw,
            "data_center_load_factor": self.data_center_load_factor,
            "data_center_flexible_share": self.data_center_flexible_share,
            "calibration_csv": Path(self.calibration_csv).name if self.calibration_csv else None,
            "note": self.note,
            "kind": "assumption",
        }


def load_scenarios(path: str | Path = DEFAULT_SCENARIOS) -> dict[str, Scenario]:
    raw = json.loads(Path(path).read_text(encoding="utf-8"))
    out = {name: Scenario(name=name, **spec) for name, spec in raw.items() if not name.startswith("_")}
    if "base" in out:
        raise ValueError('"base" is reserved for the observed base year')
    return out
