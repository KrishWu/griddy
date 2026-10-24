"""Export demand artifacts for the site-location model (ml/site_location).  OWNER: workstream A.

    python -m ml.demand_forecast.export baseline                       # observed base year; no model needed
    python -m ml.demand_forecast.export forecast --run <runs/run_id>   # after train.py

Baseline: the base year's observed hourly load per region (EIA-930), downscaled to counties
by 2020 Census population. B can train on this the moment EIA-930 for the base year is
downloaded, without waiting for A's model.

Forecast: for every scenario and forecast year, the trained model predicts the hourly
shape of the target year's calendar under each historical weather year we have, scaled
to the scenario's level, plus flat new data-center load:
    demand_q(t) = shape_q(t) x base_mean_mw x growth_factor + data_center_mw x load_factor
Peak P50 = median over weather years of the annual P50 peak; peak P90 = 90th percentile over
weather years of the annual P90 peak. So P90 covers both model error and a hot year. The
hourly file keeps the weather year whose peak is closest to the median.

Artifacts go to ml/artifacts/demand_forecast/<artifact_id>/, and the LATEST_BASELINE /
LATEST_FORECAST pointer files there name the newest one (B reads those by default).
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
from collections.abc import Callable
from pathlib import Path

import numpy as np
import pandas as pd

from ml.contract.demand_artifact import BASE_SCENARIO, Manifest, write_artifact
from ml.contract.regions import REGIONS
from ml.demand_forecast.config import ARTIFACTS_DIR, BASE_YEAR, EIA930_PAGE, FIRST_YEAR, FORECAST_YEARS, OPEN_METEO_URL
from ml.demand_forecast.dataset import features_for_year, load_eia930, load_weather, year_hours_pst
from ml.demand_forecast.geo import RegionGeo, region_geo
from ml.demand_forecast.scenarios import DEFAULT_SCENARIOS, Scenario, load_scenarios

PredictFn = Callable[[pd.DataFrame], np.ndarray]  # features -> (n, 3) ratio quantiles

PROVENANCE_BASE = [
    {"kind": "observed", "source": "EIA-930 hourly demand (CAISO sub-regions PGAE/SCE/SDGE; LDWP, BANC, IID, TIDC)", "url": EIA930_PAGE, "note": None},
    {
        "kind": "inferred",
        "source": "Downscaled to counties by 2020 Census block-group population within each load region",
        "url": "https://www2.census.gov/geo/docs/reference/cenpop2020/blkgrp/",
        "note": "County demand is an estimate, not metered load. Regions from CEC balancing-authority and utility territories (data/explore).",
    },
]


def _hours(year: int) -> int:
    return len(year_hours_pst(year))


def observed_hourly(load: pd.DataFrame, year: int, min_coverage: float = 0.8) -> dict[str, np.ndarray]:
    """Observed hourly MW per region for a calendar year (PST), short gaps interpolated."""
    idx = year_hours_pst(year)
    out = {}
    for region in REGIONS:
        s = load[load["region"] == region].assign(ts_pst=lambda d: d["ts_utc"] - pd.Timedelta(hours=8)).set_index("ts_pst")["demand_mw"]
        s = s[~s.index.duplicated()].reindex(idx)
        coverage = s.notna().mean()
        if coverage < min_coverage:
            raise SystemExit(f"{region} {year}: only {coverage:.0%} of hours observed; fetch EIA-930 for {year}")
        out[region] = s.interpolate(limit_direction="both").to_numpy()
    return out


def data_center_split(scn: Scenario, geo: RegionGeo) -> dict[tuple[str, str], float]:
    """New data-center MW per (county, region): each county's load sits in the region holding most of its people."""
    home = geo.county_shares.sort_values("population", ascending=False).drop_duplicates("geoid").set_index("geoid")["region"]
    out = {}
    for geoid, mw in scn.data_center_mw.items():
        if geoid not in home.index:
            print(f"warning: scenario {scn.name}: county {geoid} is not in any forecast region; its {mw} MW is ignored")
            continue
        out[(geoid, str(home[geoid]))] = float(mw)
    return out


def county_rows(
    geo: RegionGeo,
    region_tot: dict[str, dict[str, float]],
    scenario: str,
    year: int,
    kind: str,
    dc: dict[tuple[str, str], float] | None = None,
    load_factor: float = 1.0,
) -> list[dict]:
    """Split region totals (without new data centers) to counties by population; add each county's data centers."""
    dc = dc or {}
    hours = _hours(year)
    rows = []
    for r in geo.county_shares.itertuples(index=False):
        tot = region_tot[r.region]
        add_mw = dc.get((r.geoid, r.region), 0.0)
        flat = add_mw * load_factor
        rows.append(
            {
                "geoid": r.geoid,
                "county": r.county,
                "region": r.region,
                "scenario": scenario,
                "year": year,
                "annual_energy_mwh": r.population_share * tot["energy_mwh"] + flat * hours,
                "avg_mw": r.population_share * tot["avg_mw"] + flat,
                "peak_mw_p50": r.population_share * tot["peak_p50"] + flat,
                "peak_mw_p90": r.population_share * tot["peak_p90"] + flat,
                "added_load_mw": add_mw,
                "population_share": r.population_share,
                "kind": kind,
            }
        )
    return rows


def baseline_tables(load: pd.DataFrame, geo: RegionGeo, base_year: int) -> tuple[pd.DataFrame, pd.DataFrame, dict]:
    obs = observed_hourly(load, base_year)
    n = _hours(base_year)
    region_tot, hourly = {}, []
    for region, mw in obs.items():
        region_tot[region] = {"energy_mwh": float(mw.sum()), "avg_mw": float(mw.mean()), "peak_p50": float(mw.max()), "peak_p90": float(mw.max())}
        hourly.append(pd.DataFrame({"region": region, "scenario": BASE_SCENARIO, "year": base_year, "hour": np.arange(n), "demand_mw_p10": mw, "demand_mw_p50": mw, "demand_mw_p90": mw}))
    county = pd.DataFrame(county_rows(geo, region_tot, BASE_SCENARIO, base_year, "observed_downscaled"))
    return county, pd.concat(hourly, ignore_index=True), region_tot


def forecast_tables(
    predict: PredictFn,
    trend_year_max: int,
    base: dict[str, dict],
    geo: RegionGeo,
    weather: pd.DataFrame,
    scenarios: dict[str, Scenario],
    years: list[int],
    weather_years: list[int],
    base_year: int,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    county, hourly = [], []
    dc_split = {name: data_center_split(s, geo) for name, s in scenarios.items()}
    for region in REGIONS:
        for year in years:
            shapes = {}
            for w in weather_years:
                r = predict(features_for_year(weather, region, year, w, trend_year_max))
                shapes[w] = r / r[:, 1].mean()  # the level comes from the scenario, not the model
            for name, scn in scenarios.items():
                level = base[region]["mean_mw"] * scn.growth_factor(region, base_year, year)
                dc_flat = sum(mw for (_, reg), mw in dc_split[name].items() if reg == region) * scn.data_center_load_factor
                peak50 = {w: float((s[:, 1] * level).max()) for w, s in shapes.items()}
                peak90 = {w: float((s[:, 2] * level).max()) for w, s in shapes.items()}
                p50 = float(np.median(list(peak50.values())))
                p90 = max(float(np.quantile(list(peak90.values()), 0.9)), p50)
                rep = min(peak50, key=lambda w: abs(peak50[w] - p50))
                q = shapes[rep] * level + dc_flat
                hourly.append(
                    pd.DataFrame(
                        {"region": region, "scenario": name, "year": year, "hour": np.arange(len(q)), "demand_mw_p10": q[:, 0], "demand_mw_p50": q[:, 1], "demand_mw_p90": q[:, 2]}
                    )
                )
                tot = {region: {"energy_mwh": level * len(q), "avg_mw": level, "peak_p50": p50, "peak_p90": p90}}
                shares = RegionGeo(geo.county_shares[geo.county_shares["region"] == region], geo.weather_points)
                county += county_rows(shares, tot, name, year, "forecast", dc_split[name], scn.data_center_load_factor)
    return pd.DataFrame(county), pd.concat(hourly, ignore_index=True)


def _write(kind: str, base_year: int, county: pd.DataFrame, hourly: pd.DataFrame, scenarios: dict, extra: dict, out: Path | None) -> Path:
    stamp = dt.datetime.now(dt.UTC)
    artifact_id = f"{kind}-{base_year}-{stamp:%Y%m%d-%H%M%S}"
    manifest = Manifest(
        artifact_id=artifact_id,
        kind=kind,
        base_year=base_year,
        years=sorted(int(y) for y in county["year"].unique()),
        scenarios=scenarios,
        created_utc=stamp.isoformat(timespec="seconds"),
        producer={"package": "ml.demand_forecast", **extra.get("producer", {})},
        data_vintage=extra.get("data_vintage", {}),
        metrics=extra.get("metrics", {}),
        provenance=extra.get("provenance", PROVENANCE_BASE),
    )
    path = write_artifact(out or ARTIFACTS_DIR / artifact_id, manifest, county, hourly)
    if out is None:
        (ARTIFACTS_DIR / f"LATEST_{kind.upper()}").write_text(artifact_id + "\n", encoding="utf-8")
    return path


def export_baseline(base_year: int, out: Path | None) -> Path:
    geo = region_geo()
    load = load_eia930([base_year - 1, base_year, base_year + 1])  # neighbours give the spike filter context
    county, hourly, tot = baseline_tables(load, geo, base_year)
    extra = {"data_vintage": {"eia930": f"{base_year} six-month files", "population": "Census 2020 block groups"}}
    path = _write("baseline", base_year, county, hourly, {BASE_SCENARIO: {"kind": "observed"}}, extra, out)
    for region, t in tot.items():
        print(f"{region:5s} {t['energy_mwh'] / 1e6:7.2f} TWh  peak {t['peak_p50']:9,.0f} MW")
    return path


def export_forecast(run: Path, scenarios_path: Path, years: list[int], weather_years: list[int] | None, out: Path | None) -> Path:
    import xgboost as xgb

    spec = json.loads((run / "feature_spec.json").read_text(encoding="utf-8"))
    base = json.loads((run / "region_base.json").read_text(encoding="utf-8"))
    geo = RegionGeo.from_json(json.loads((run / "region_geo.json").read_text(encoding="utf-8")))
    metrics = json.loads((run / "metrics.json").read_text(encoding="utf-8"))
    base_year = int(next(iter(base.values()))["base_year"])
    booster = xgb.Booster()
    booster.load_model(run / "model.ubj")
    booster.set_param({"device": "cpu"})  # inference is light; any machine can export
    best = int(spec["best_iteration"])

    def predict(feats: pd.DataFrame) -> np.ndarray:
        p = booster.predict(xgb.DMatrix(feats[spec["features"]], enable_categorical=True), iteration_range=(0, best + 1))
        return np.sort(np.clip(p, 1e-3, None), axis=1)

    weather = load_weather(geo)
    weather_years = weather_years or list(range(FIRST_YEAR, base_year + 1))
    scenarios = load_scenarios(scenarios_path)
    county, hourly = forecast_tables(predict, spec["trend_year_max"], base, geo, weather, scenarios, years, weather_years, base_year)

    load = load_eia930([base_year - 1, base_year, base_year + 1])
    base_county, base_hourly, _ = baseline_tables(load, geo, base_year)
    county = pd.concat([base_county, county], ignore_index=True)
    hourly = pd.concat([base_hourly, hourly], ignore_index=True)

    held_out = metrics.get("test") or metrics.get("valid", {})
    extra = {
        "producer": {"model_version": run.name, "git_sha": spec.get("git_sha"), "xgboost": spec.get("xgboost")},
        "data_vintage": {"eia930": f"{spec['train_years'][0]}-{spec['trend_year_max']}", "weather": f"Open-Meteo archive, replay years {weather_years}"},
        "metrics": {
            "split": "test" if metrics.get("test") else "valid (used for early stopping)",
            "mape_p50_pct": held_out.get("mape_p50_pct"),
            "mape_climatology_pct": held_out.get("mape_climatology_pct"),
            "monthly_peak_error_pct": held_out.get("monthly_peak_error_pct"),
            "p10_p90_coverage": held_out.get("p10_p90_coverage"),
            "note": "Hourly accuracy given the year's mean load; long-term level comes from scenario assumptions.",
        },
        "provenance": PROVENANCE_BASE
        + [
            {"kind": "observed", "source": "Open-Meteo historical weather (ERA5 reanalysis)", "url": OPEN_METEO_URL, "note": f"Replayed weather years {weather_years}"},
            {"kind": "simulated", "source": f"XGBoost quantile model {run.name}", "url": None, "note": "Hourly load shape per region from weather and calendar"},
            {"kind": "assumption", "source": "Scenario growth rates and data-center loads", "url": None, "note": f"From {scenarios_path.name}; see manifest scenarios"},
        ],
    }
    scenario_meta = {BASE_SCENARIO: {"kind": "observed"}, **{n: s.assumptions() for n, s in scenarios.items()}}
    return _write("forecast", base_year, county, hourly, scenario_meta, extra, out)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("baseline", help="observed base-year artifact (no model)")
    b.add_argument("--base-year", type=int, default=BASE_YEAR)
    b.add_argument("--out", type=Path, default=None)
    f = sub.add_parser("forecast", help="scenario forecast artifact from a trained run")
    f.add_argument("--run", type=Path, required=True, help="ml/demand_forecast/runs/<run_id>")
    f.add_argument("--scenarios", type=Path, default=DEFAULT_SCENARIOS)
    f.add_argument("--years", type=int, nargs="+", default=list(FORECAST_YEARS))
    f.add_argument("--weather-years", type=int, nargs="*", default=None)
    f.add_argument("--out", type=Path, default=None)
    args = ap.parse_args()
    path = export_baseline(args.base_year, args.out) if args.cmd == "baseline" else export_forecast(args.run, args.scenarios, args.years, args.weather_years, args.out)
    print(f"wrote {path}")


if __name__ == "__main__":
    main()
