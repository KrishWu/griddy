"""Unit tests for the demand forecast pipeline. No model is trained: the forecast path runs with a
stub predictor in place of the XGBoost booster.  Run from the repo root:  python -m pytest ml"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from ml.contract.demand_artifact import Manifest, read_artifact, write_artifact
from ml.contract.regions import REGIONS
from ml.demand_forecast.dataset import FEATURES, add_features, clean_load, features_for_year, parse_eia930
from ml.demand_forecast.export import county_rows, forecast_tables
from ml.demand_forecast.geo import RegionGeo, region_geo
from ml.demand_forecast.scenarios import Scenario

SUBREGION_CSV = """"Balancing Authority","Data Date","Hour Number","Sub-Region","Demand (MW)","Local Time at End of Hour","UTC Time at End of Hour"
CISO,01/01/2024,1,PGAE,"10,196",01/01/2024 1:00:00 AM,01/01/2024 9:00:00 AM
CISO,01/01/2024,1,SCE,10035,01/01/2024 1:00:00 AM,01/01/2024 9:00:00 AM
CISO,01/01/2024,1,VEA,70,01/01/2024 1:00:00 AM,01/01/2024 9:00:00 AM
"""
BALANCE_CSV = """"Balancing Authority","Data Date","Hour Number","Local Time at End of Hour","UTC Time at End of Hour","Demand (MW)","Demand (MW) (Adjusted)"
LDWP,01/01/2024,1,01/01/2024 1:00:00 AM,01/01/2024 9:00:00 AM,2500,2510
IID,01/01/2024,1,01/01/2024 1:00:00 AM,01/01/2024 9:00:00 AM,400,
PACW,01/01/2024,1,01/01/2024 1:00:00 AM,01/01/2024 9:00:00 AM,3000,3000
"""


def _weather(regions, start="2022-12-25", end="2025-01-05") -> pd.DataFrame:
    ts = pd.date_range(start, end, freq="h", inclusive="left")
    h = ts.hour.to_numpy()
    frames = []
    for i, r in enumerate(regions):
        frames.append(
            pd.DataFrame(
                {
                    "region": r,
                    "ts_utc": ts,
                    "temp_c": 15 + 10 * np.sin((h - 14) / 24 * 2 * np.pi) + i,
                    "rh_pct": 50.0,
                    "dew_c": 5.0,
                    "ghi_wm2": np.clip(800 * np.sin((h - 14) / 24 * 2 * np.pi + np.pi / 2), 0, None),
                    "wind_ms": 3.0,
                }
            )
        )
    return pd.concat(frames, ignore_index=True)


def test_parse_eia930(tmp_path):
    (tmp_path / "s.csv").write_text(SUBREGION_CSV)
    (tmp_path / "b.csv").write_text(BALANCE_CSV)
    sub = parse_eia930(tmp_path / "s.csv", "SUBREGION")
    assert sorted(sub["region"]) == ["PGAE", "SCE"]  # VEA (Nevada) dropped
    assert sub.loc[sub["region"] == "PGAE", "demand_mw"].item() == 10196  # thousands separator
    assert sub["ts_utc"].iloc[0] == pd.Timestamp("2024-01-01 08:00")  # hour-beginning = end - 1 h
    bal = parse_eia930(tmp_path / "b.csv", "BALANCE").set_index("region")["demand_mw"]
    assert bal["LDWP"] == 2510 and bal["IID"] == 400 and "PACW" not in bal  # adjusted, falling back to raw


def test_clean_load_drops_spikes_and_zeros():
    ts = pd.date_range("2024-01-01", periods=400, freq="h")
    df = pd.DataFrame({"region": "SCE", "ts_utc": ts, "demand_mw": 10_000.0})
    df.loc[100, "demand_mw"] = 60_000.0
    df.loc[200, "demand_mw"] = 0.0
    out = clean_load(df)
    assert out["demand_mw"].isna().sum() == 2 and out["demand_mw"].dropna().eq(10_000).all()


def test_add_features_calendar_and_lags():
    f = add_features(_weather(["PGAE", "SCE"]))
    assert list(f["region"].cat.categories) == list(REGIONS)
    jan1 = f[(f["ts_pst"] == pd.Timestamp("2024-01-01 12:00")) & (f["region"] == "PGAE")].iloc[0]
    assert jan1["is_holiday"] == 1 and jan1["hour"] == 12 and jan1["dow"] == 0
    pg = f[f["region"] == "PGAE"].reset_index(drop=True)
    assert pg.loc[10, "temp_lag1"] == pytest.approx(pg.loc[9, "temp_c"])  # lags never cross regions
    assert set(FEATURES) <= set(f.columns)


def test_features_for_year_replays_weather_on_target_calendar():
    w = _weather(["PGAE"])
    f = features_for_year(w, "PGAE", target_year=2024, weather_year=2023, trend_year_max=2024)
    assert len(f) == 8784  # leap target year from a non-leap weather year (Feb 29 repeats Feb 28)
    assert f["ts_pst"].iloc[0] == pd.Timestamp("2024-01-01 00:00")
    assert f[FEATURES].drop(columns="region").notna().all().all()  # rolling features defined from hour 0
    f2 = features_for_year(w, "PGAE", target_year=2035, weather_year=2024, trend_year_max=2024)
    assert len(f2) == 8760 and f2["trend_year"].max() == 2024  # clamped for years the model never saw


def test_scenario_county_factors_and_validation(tmp_path):
    s = Scenario("mid", population_growth=0.004, use_dof_population=False, electrification_growth=0.015, efficiency_offset=0.007)
    geoids = pd.Series(["06029", "06037"])
    assert s.county_factors(geoids, 2024, 2035, None).tolist() == pytest.approx([(1.004 * 1.008) ** 11] * 2)  # population x per capita
    dof = pd.DataFrame({"geoid": ["06029", "06029", "06037", "06037"], "year": [2024, 2035, 2024, 2035], "population": [100.0, 110.0, 100.0, 95.0]})
    d = Scenario("dof", electrification_growth=0.01)
    assert d.county_factors(geoids, 2024, 2035, dof).tolist() == pytest.approx([1.10 * 1.01**11, 0.95 * 1.01**11])
    assert d.county_factors(geoids, 2024, 2080, dof).tolist() == pytest.approx([1.10 * 1.01**56, 0.95 * 1.01**56])  # past the table: last year
    cal = tmp_path / "cec.csv"
    pd.DataFrame({"region": ["SCE", "SCE"], "year": [2024, 2034], "annual_energy_gwh": [100.0, 120.0]}).to_csv(cal, index=False)
    assert Scenario("cec", calibration_csv=str(cal)).calibrated_factor("SCE", 2024, 2029) == pytest.approx(1.10)
    with pytest.raises(ValueError):
        Scenario("bad", data_center_mw={"6029": 100})
    with pytest.raises(ValueError):
        Scenario("bad", electrification_growth=0.5)
    with pytest.raises(ValueError):
        Scenario("bad", data_center_flexible_share=1.5)


def _toy_geo() -> RegionGeo:
    rows = []
    for region in REGIONS:
        rows.append({"region": region, "geoid": "06001", "county": "Alameda", "population": 600, "population_share": 0.6})
        rows.append({"region": region, "geoid": "06029", "county": "Kern", "population": 400, "population_share": 0.4})
    shares = pd.DataFrame(rows).astype({"geoid": "string", "county": "string", "region": "string"})
    return RegionGeo(county_shares=shares, weather_points={r: [] for r in REGIONS})


def test_county_rows_split_region_totals():
    geo = _toy_geo()
    tot = {r: {"energy_mwh": 8760e3, "avg_mw": 1000.0, "peak_p50": 1500.0, "peak_p90": 1600.0} for r in REGIONS}
    rows = pd.DataFrame(county_rows(geo, tot, "mid", 2035, "forecast", {("06029", "SCE"): 100.0}, load_factor=0.9))
    sce = rows[rows["region"] == "SCE"].set_index("county")
    assert sce["avg_mw"].sum() == pytest.approx(1000 + 90)
    assert sce.loc["Kern", "added_load_mw"] == 100 and sce.loc["Alameda", "added_load_mw"] == 0


def test_forecast_tables_with_stub_model_write_a_valid_artifact(tmp_path):
    geo = _toy_geo()
    weather = _weather(list(REGIONS))
    base = {r: {"base_year": 2024, "mean_mw": 1000.0} for r in REGIONS}

    def stub(feats: pd.DataFrame) -> np.ndarray:  # stands in for the booster: a daily cycle with spread
        p50 = 1 + 0.3 * np.sin(2 * np.pi * feats["hour"].to_numpy() / 24) + 0.01 * feats["cdd"].to_numpy()
        return np.column_stack([p50 * 0.92, p50, p50 * 1.08])

    scn = {"mid": Scenario("mid", use_dof_population=False, electrification_growth=0.01, data_center_mw={"06029": 200}, data_center_flexible_share=0.5)}
    county, hourly, shape = forecast_tables(stub, 2024, base, geo, weather, scn, [2030], [2023, 2024], 2024)
    assert set(shape["year"]) == {2024, 2030} and (shape["peak_ratio_p90"] >= shape["peak_ratio_p50"]).all() and (shape["peak_ratio_p50"] >= 1).all()
    assert hourly.groupby("region").size().eq(8760).all()
    # Each region's P50 averages to the scenario level (shape normalized to mean 1) plus flat data-center load.
    level = 1000 * 1.01**6
    assert hourly.groupby("region")["demand_mw_p50"].mean().sum() == pytest.approx(7 * level + 200 * 0.9, rel=1e-9)
    assert (county["peak_mw_p90"] >= county["peak_mw_p50"]).all()
    assert county.loc[county["county"] == "Kern", "added_load_mw"].sum() == 200  # data center counted once, in one region
    # The flexible half of the data center adds energy (flat 180 MW) but only 90 MW to the peak.
    kern = county[(county["county"] == "Kern") & (county["added_load_mw"] > 0)].iloc[0]
    alameda = county[(county["county"] == "Alameda") & (county["region"] == kern["region"])].iloc[0]
    ratio = shape.set_index(["region", "year"]).loc[(kern["region"], 2030), "peak_ratio_p50"]
    level_k = (kern["avg_mw"] - 180) / 1.0
    assert kern["peak_mw_p50"] == pytest.approx(level_k * ratio + 90, rel=1e-6)
    assert alameda["peak_mw_p50"] == pytest.approx(alameda["avg_mw"] * ratio, rel=1e-6)

    base_rows = pd.DataFrame(county_rows(geo, {r: {"energy_mwh": 8784e3, "avg_mw": 1000.0, "peak_p50": 1400.0, "peak_p90": 1400.0} for r in REGIONS}, "base", 2024, "observed_downscaled"))
    manifest = Manifest("t", "forecast", 2024, [2024, 2030], {"base": {}, "mid": {}}, "2026-10-24T00:00:00Z", {"package": "test"})
    art = read_artifact(write_artifact(tmp_path / "a", manifest, pd.concat([base_rows, county]), hourly, shape=shape))
    growth = art.growth("mid", 2030).set_index("county")
    assert growth.loc["Kern", "added_load_mw"] == 200 and growth.loc["Kern", "annual_energy_mwh_growth"] > 0


def test_region_geo_from_explore_layers():
    geo = region_geo(refresh=True)
    pop = geo.county_shares.groupby("region")["population"].sum()
    assert set(pop.index) == set(REGIONS)
    assert 38e6 < pop.sum() < 39.6e6  # all of CA except PacifiCorp / NV Energy / WAPA areas
    assert pop["LDWP"] > 3.5e6 and pop["SCE"] > pop["SDGE"]
    shares = geo.county_shares.groupby("region")["population_share"].sum()
    assert np.allclose(shares, 1.0)
    for region, pts in geo.weather_points.items():
        assert 1 <= len(pts) <= 6 and sum(p["weight"] for p in pts) == pytest.approx(1.0, abs=1e-4)
