"""Demand forecast for the website: interactive what-ifs on the trained model's output.  OWNER: workstream A.

Reads the newest demand artifact (ml/artifacts/demand_forecast, LATEST_FORECAST, else LATEST_BASELINE)
and recomputes any scenario with the same formulas as ml/demand_forecast/export.py:

    county energy(y) = base energy x DOF population factor (or flat rate) x (1 + electrification - efficiency)^n
    region peak(y)   = region mean(y) x peak/mean ratio(region, y) + firm new data-center load

mode "ml": peak/mean ratios come from the weather-adjusted demand model (median and 90th percentile over
replayed weather years). mode "scenario_on_observed": only the observed base year exists yet, so its
peak/mean ratio is used for every year. No model runs here and nothing is fetched: what-ifs take
milliseconds. Keep the signature: app/sites calls forecast() for the demand growth it must cover.
"""

from __future__ import annotations

import calendar
import json
import logging
from functools import lru_cache
from pathlib import Path

import numpy as np

from app.contract import CountyForecast, DemandForecast, ForecastRequest, Provenance, RegionForecast
from app.ml_bridge import REPO_DIR, latest

log = logging.getLogger(__name__)
PRESETS_FILE = REPO_DIR / "ml" / "demand_forecast" / "scenarios.json"  # used when the artifact has no presets (baseline)
TRAJECTORY_STEP = 1  # years between trajectory points

NOTES = [
    "County demand is estimated: EIA-930 regional load split by 2020 Census population, so industrial counties read low.",
    "Long-term growth follows the stated assumptions (CA DOF population projections, electrification, efficiency, new data centers); it is a scenario, not a prediction.",
    "Flexible data-center load is assumed to move out of the peak hour: it adds energy but not peak.",
]


def _hours(year: int) -> int:
    return 8784 if calendar.isleap(year) else 8760


@lru_cache(maxsize=4)
def _load(path: str, mtime: float):
    from ml.contract import read_artifact

    return read_artifact(path, load_hourly=False)


def _artifact():
    """(artifact, mode) for the newest forecast, else baseline; (None, "unavailable") when neither exists."""
    for pointer, mode in (("LATEST_FORECAST", "ml"), ("LATEST_BASELINE", "scenario_on_observed")):
        path = latest("demand_forecast", pointer)
        if path is None:
            continue
        try:
            art = _load(str(path), (path / "manifest.json").stat().st_mtime)
        except Exception:  # noqa: BLE001 - a broken artifact must not take the page down
            log.exception("demand artifact %s is unreadable", path)
            continue
        if mode == "ml" and art.shape is None:
            mode = "scenario_on_observed"
        return art, mode
    return None, "unavailable"


def presets(art) -> dict[str, dict]:
    """Scenario presets: the forecast artifact's (exactly what its model rows used), else scenarios.json."""
    found = {k: v for k, v in (art.manifest.scenarios if art else {}).items() if k != "base"}
    if found:
        return found
    try:
        raw = json.loads(Path(PRESETS_FILE).read_text(encoding="utf-8"))
        return {k: v for k, v in raw.items() if not k.startswith("_")}
    except (OSError, json.JSONDecodeError):
        return {}


def effective_params(req: ForecastRequest, preset: dict) -> dict:
    p = {
        "population_growth": float(preset.get("population_growth", 0.0)),
        "use_dof_population": bool(preset.get("use_dof_population", True)),
        "electrification_growth": float(preset.get("electrification_growth", 0.0)),
        "efficiency_offset": float(preset.get("efficiency_offset", 0.0)),
        "data_center_mw": {str(k): float(v) for k, v in (preset.get("data_center_mw") or {}).items()},
        "data_center_load_factor": float(preset.get("data_center_load_factor", 0.9)),
        "data_center_flexible_share": float(preset.get("data_center_flexible_share", 0.0)),
    }
    for key in p:
        v = getattr(req, key)
        if v is not None:
            p[key] = {str(k): float(x) for k, x in v.items()} if key == "data_center_mw" else v
    return p


class _Engine:
    """Base-year tables of one artifact as numpy arrays, so a what-if is a few vector operations."""

    def __init__(self, art) -> None:
        self.art = art
        self.base_year = art.manifest.base_year
        c = art.county
        base = c[(c["scenario"] == "base") & (c["year"] == self.base_year)].sort_values(["region", "geoid"]).reset_index(drop=True)
        self.regions = sorted(base["region"].unique().tolist())
        self.ridx = base["region"].map({r: i for i, r in enumerate(self.regions)}).to_numpy()
        self.geoid = base["geoid"].astype(str).to_numpy()
        self.share = base["population_share"].to_numpy(dtype=float)
        hours = _hours(self.base_year)
        self.region_mean = np.bincount(self.ridx, weights=base["annual_energy_mwh"].to_numpy(), minlength=len(self.regions)) / hours
        observed_peak = np.bincount(self.ridx, weights=base["peak_mw_p90"].to_numpy(), minlength=len(self.regions))
        # Each county's main region: where most of its base-year energy is (its data centers go there).
        top = base.sort_values("annual_energy_mwh", ascending=False).drop_duplicates("geoid")
        self.main_region = dict(zip(top["geoid"].astype(str), top["region"]))
        self.is_main = np.array([self.main_region[g] == self.regions[i] for g, i in zip(self.geoid, self.ridx)])
        self.county_name = dict(zip(base["geoid"].astype(str), base["county"]))
        self.counties, self.cidx = np.unique(self.geoid, return_inverse=True)

        self.ratio_table: dict[int, tuple[np.ndarray, np.ndarray, np.ndarray]] = {}
        for i, r in enumerate(self.regions):
            if art.shape is not None and (art.shape["region"] == r).any():
                sh = art.shape[art.shape["region"] == r].sort_values("year")
                self.ratio_table[i] = (sh["year"].to_numpy(float), sh["peak_ratio_p50"].to_numpy(float), sh["peak_ratio_p90"].to_numpy(float))
            else:
                ratio = observed_peak[i] / self.region_mean[i] if self.region_mean[i] > 0 else 1.0
                self.ratio_table[i] = (np.array([float(self.base_year)]), np.array([ratio]), np.array([ratio]))

        self.dof = None
        if art.population is not None:
            piv = art.population.pivot(index="geoid", columns="year", values="population")
            self.dof_years = piv.columns.to_numpy(int)
            self.dof = piv.reindex(self.geoid).to_numpy(float)  # rows aligned with the base rows

    def ratios(self, year: int) -> tuple[np.ndarray, np.ndarray]:
        """Peak/mean ratios (P50, P90) per region for a year, interpolated between stored years."""
        r50 = np.array([np.interp(year, t[0], t[1]) for t in (self.ratio_table[i] for i in range(len(self.regions)))])
        r90 = np.array([np.interp(year, t[0], t[2]) for t in (self.ratio_table[i] for i in range(len(self.regions)))])
        return r50, np.maximum(r90, r50)

    def _dof_col(self, year: int) -> int:
        y = min(max(year, int(self.dof_years[0])), int(self.dof_years[-1]))
        return int(np.searchsorted(self.dof_years, y))

    def factors(self, year: int, p: dict) -> np.ndarray:
        n = year - self.base_year
        per_capita = (1.0 + p["electrification_growth"] - p["efficiency_offset"]) ** n
        flat = (1.0 + p["population_growth"]) ** n
        if p["use_dof_population"] and self.dof is not None:
            pop = self.dof[:, self._dof_col(year)] / self.dof[:, self._dof_col(self.base_year)]
            pop = np.where(np.isfinite(pop), pop, flat)
        else:
            pop = np.full(len(self.geoid), flat)
        return pop * per_capita

    def added(self, p: dict) -> np.ndarray:
        """New data-center MW per base row (only on the county's main-region row)."""
        dc = p["data_center_mw"]
        return np.array([dc.get(g, 0.0) for g in self.geoid]) * self.is_main

    def year(self, year: int, p: dict, add: np.ndarray) -> dict[str, dict[str, np.ndarray]]:
        """Row-level (county x region) and region-level arrays for one year."""
        weighted = self.share * self.factors(year, p)
        reg_sum = np.bincount(self.ridx, weights=weighted, minlength=len(self.regions))
        level = self.region_mean * reg_sum
        lvl = weighted / reg_sum[self.ridx] * level[self.ridx]
        r50, r90 = self.ratios(year)
        lf, firm, hours = p["data_center_load_factor"], 1.0 - p["data_center_flexible_share"], _hours(year)
        rows = {
            "energy_mwh": lvl * hours + add * lf * hours,
            "peak_mw_p50": lvl * r50[self.ridx] + add * lf * firm,
            "peak_mw_p90": lvl * r90[self.ridx] + add * lf * firm,
        }
        add_r = np.bincount(self.ridx, weights=add, minlength=len(self.regions))
        regions = {
            "energy_mwh": level * hours + add_r * lf * hours,
            "peak_mw_p50": level * r50 + add_r * lf * firm,
            "peak_mw_p90": level * r90 + add_r * lf * firm,
        }
        return {"rows": rows, "regions": regions}


_ENGINES: dict[str, _Engine] = {}


def _engine(art) -> _Engine:
    eng = _ENGINES.get(art.manifest.artifact_id)
    if eng is None:
        eng = _ENGINES[art.manifest.artifact_id] = _Engine(art)
    return eng


def forecast(req: ForecastRequest) -> DemandForecast:
    art, mode = _artifact()
    if art is None:
        return DemandForecast(
            available=False,
            mode="unavailable",
            scenario=req.scenario,
            year=req.year,
            notes=["The demand forecast isn't available right now."],
        )
    from ml.contract.regions import REGIONS

    eng = _engine(art)
    all_presets = presets(art)
    preset = all_presets.get(req.scenario) or all_presets.get("mid") or {}
    p = effective_params(req, preset)
    year = max(req.year, eng.base_year)

    add = eng.added(p)
    base = eng.year(eng.base_year, p, np.zeros_like(add))
    fut = eng.year(year, p, add)

    years = list(range(eng.base_year, year + 1, TRAJECTORY_STEP))
    if years[-1] != year:
        years.append(year)
    traj = [base["regions"] if y == eng.base_year else eng.year(y, p, add)["regions"] for y in years]

    regions = []
    fr, br = fut["regions"], base["regions"]
    for i, r in enumerate(eng.regions):
        regions.append(
            RegionForecast(
                region=r,
                name=REGIONS[r].name if r in REGIONS else r,
                base_peak_mw=round(float(br["peak_mw_p90"][i]), 1),
                base_energy_mwh=round(float(br["energy_mwh"][i]), 0),
                peak_mw_p50=round(float(fr["peak_mw_p50"][i]), 1),
                peak_mw_p90=round(float(fr["peak_mw_p90"][i]), 1),
                energy_mwh=round(float(fr["energy_mwh"][i]), 0),
                growth_peak_mw_p90=round(float(fr["peak_mw_p90"][i] - br["peak_mw_p90"][i]), 1),
                trajectory=[
                    {
                        "year": float(y),
                        "peak_mw_p50": round(float(t["peak_mw_p50"][i]), 1),
                        "peak_mw_p90": round(float(t["peak_mw_p90"][i]), 1),
                        "energy_mwh": round(float(t["energy_mwh"][i]), 0),
                    }
                    for y, t in zip(years, traj)
                ],
            )
        )

    # Counties: summed over regions (a county can span two), labelled with their main region.
    def per_county(rows: dict[str, np.ndarray]) -> dict[str, np.ndarray]:
        return {k: np.bincount(eng.cidx, weights=v, minlength=len(eng.counties)) for k, v in rows.items()}

    bc, fc = per_county(base["rows"]), per_county(fut["rows"])
    add_c = np.bincount(eng.cidx, weights=add, minlength=len(eng.counties))
    counties = []
    for k in np.argsort(-fc["peak_mw_p90"]):
        g = str(eng.counties[k])
        counties.append(
            CountyForecast(
                geoid=g,
                county=eng.county_name.get(g, g),
                region=eng.main_region.get(g, ""),
                base_peak_mw=round(float(bc["peak_mw_p90"][k]), 1),
                peak_mw_p50=round(float(fc["peak_mw_p50"][k]), 1),
                peak_mw_p90=round(float(fc["peak_mw_p90"][k]), 1),
                energy_mwh=round(float(fc["energy_mwh"][k]), 0),
                growth_peak_mw_p90=round(float(fc["peak_mw_p90"][k] - bc["peak_mw_p90"][k]), 1),
                added_load_mw=round(float(add_c[k]), 1),
            )
        )

    provenance = []
    for item in art.manifest.provenance:
        try:
            provenance.append(Provenance.model_validate(item))
        except Exception:  # noqa: BLE001 - skip anything that doesn't fit the contract
            continue
    provenance.append(Provenance(kind="assumption", source=f"Scenario '{req.scenario}' with your adjustments", note=_describe(p)))

    return DemandForecast(
        available=True,
        mode=mode,
        artifact_id=art.manifest.artifact_id,
        base_year=eng.base_year,
        scenario=req.scenario,
        year=year,
        params=p,
        scenarios=all_presets,
        years=sorted(int(y) for y in art.manifest.years),
        regions=regions,
        counties=counties,
        total_growth_peak_mw_p90=round(sum(r.growth_peak_mw_p90 for r in regions), 1),
        metrics=art.manifest.metrics or {},
        provenance=provenance,
        notes=NOTES,
    )


def _describe(p: dict) -> str:
    pop = "CA DOF county projections" if p["use_dof_population"] else f"{p['population_growth']:.1%}/yr"
    dc = sum(p["data_center_mw"].values())
    return (
        f"Population {pop}; electrification +{p['electrification_growth']:.1%}/yr; efficiency -{p['efficiency_offset']:.1%}/yr; "
        f"new data centers {dc:,.0f} MW at {p['data_center_load_factor']:.0%} load factor, {p['data_center_flexible_share']:.0%} flexible."
    )


def clear_caches() -> None:
    _load.cache_clear()
    _ENGINES.clear()
