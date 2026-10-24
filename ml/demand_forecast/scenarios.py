"""Long-term demand scenarios: explicit assumptions, not learned.  OWNER: workstream A.

Annual energy in year y (per region, before new data centers):
    E_y = E_base x growth_factor(region, y)
    growth_factor = (1 + population_growth + electrification_growth - efficiency_offset) ** (y - base_year)
or, with a calibration CSV (columns region, year, annual_energy_gwh, e.g. transcribed from the
CEC 2025 IEPR forecast), E_cal(y) / E_cal(base_year) interpolated linearly between its years.
New data-center load is added on top, per county, flat at peak x load factor.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import pandas as pd

from ml.contract.regions import REGIONS
from ml.demand_forecast.config import PKG_DIR

DEFAULT_SCENARIOS = PKG_DIR / "scenarios.json"


@dataclass
class Scenario:
    name: str
    population_growth: float = 0.0
    electrification_growth: float = 0.0
    efficiency_offset: float = 0.0
    data_center_mw: dict[str, float] = field(default_factory=dict)  # county geoid -> MW of new peak load
    data_center_load_factor: float = 0.9
    calibration_csv: str | None = None
    note: str = ""
    _calibration: pd.DataFrame | None = field(default=None, repr=False)

    def __post_init__(self) -> None:
        rate = self.population_growth + self.electrification_growth - self.efficiency_offset
        if not -0.2 < rate < 0.2:
            raise ValueError(f"scenario {self.name}: net growth {rate:.1%}/yr is implausible")
        if not 0 < self.data_center_load_factor <= 1:
            raise ValueError(f"scenario {self.name}: data_center_load_factor must be in (0, 1]")
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
    def net_rate(self) -> float:
        return self.population_growth + self.electrification_growth - self.efficiency_offset

    def growth_factor(self, region: str, base_year: int, year: int) -> float:
        if self._calibration is not None:
            c = self._calibration[self._calibration["region"] == region].sort_values("year")
            if len(c) >= 2:
                e = np.interp([base_year, year], c["year"], c["annual_energy_gwh"])
                return float(e[1] / e[0])
        return float((1.0 + self.net_rate) ** (year - base_year))

    def assumptions(self) -> dict:
        """What goes into the artifact manifest, so B and the UI can show the assumptions."""
        return {
            "population_growth": self.population_growth,
            "electrification_growth": self.electrification_growth,
            "efficiency_offset": self.efficiency_offset,
            "net_annual_growth": round(self.net_rate, 6),
            "data_center_mw": self.data_center_mw,
            "data_center_load_factor": self.data_center_load_factor,
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
