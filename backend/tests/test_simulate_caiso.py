"""Invariants of the committed CAISO 2024 hourly profile.  OWNER: workstream B (Simulate).

The CSV is produced offline by ``python -m app.simulate.prep.caiso``. These tests assert
ranges and invariants, never exact values, so a regenerated file keeps passing.
"""

from __future__ import annotations

import json

import numpy as np
import pandas as pd
import pytest

from app import DATA_DIR

CSV = DATA_DIR / "simulate" / "caiso_2024_hourly.csv"
META = DATA_DIR / "simulate" / "caiso_2024_meta.json"
LMP_COLS = ("lmp_dlap_pgae", "lmp_dlap_sce", "lmp_dlap_sdge")


@pytest.fixture(scope="module")
def df() -> pd.DataFrame:
    if not CSV.exists():
        pytest.skip(f"{CSV.name} missing; run: .venv/bin/python -m app.simulate.prep.caiso")
    return pd.read_csv(CSV)


def test_shape_and_hour_column(df: pd.DataFrame) -> None:
    assert len(df) == 8784
    assert (df["hour"].to_numpy() == np.arange(8784)).all()


def test_timestamps_match_canonical_index(df: pd.DataFrame) -> None:
    canonical = pd.date_range("2024-01-01", periods=8784, freq="h", tz="Etc/GMT+8")
    ts = pd.DatetimeIndex(pd.to_datetime(df["timestamp"], utc=True)).tz_convert("Etc/GMT+8")
    assert ts.equals(canonical)
    assert df["timestamp"].str.endswith("-08:00").all()


def test_no_nan_or_inf(df: pd.DataFrame) -> None:
    numeric = df.drop(columns="timestamp")
    assert not numeric.isna().any().any()
    assert np.isfinite(numeric.to_numpy(dtype=float)).all()


def test_required_columns(df: pd.DataFrame) -> None:
    for col in (*LMP_COLS, "grid_co2_kg_per_mwh", "grid_cfe_share", "solar_mw", "natural_gas_mw"):
        assert col in df.columns


def test_co2_and_cfe_ranges(df: pd.DataFrame) -> None:
    assert df["grid_co2_kg_per_mwh"].between(0, 700).all()
    assert df["grid_cfe_share"].between(0, 1).all()


def test_midday_cleaner_than_night(df: pd.DataFrame) -> None:
    """Duck curve: midday solar pushes average grid CO2 down.

    Only catches a gross offset (e.g. timestamps left in UTC). A 1-hour DST leak still
    passes here; test_solar_centroid_each_month catches that.
    """
    hod = df["hour"] % 24
    co2 = df["grid_co2_kg_per_mwh"]
    assert co2[hod.between(11, 13)].mean() < co2[hod.between(0, 4)].mean()
    cfe = df["grid_cfe_share"]
    assert cfe[hod.between(11, 13)].mean() > cfe[hod.between(0, 4)].mean()


def test_solar_peaks_at_noon_pst(df: pd.DataFrame) -> None:
    """Coarse, year-wide check; a 1-hour shift stays inside 11..13."""
    peak_hour = int(df.groupby(df["hour"] % 24)["solar_mw"].mean().idxmax())
    assert 11 <= peak_hour <= 13


def test_solar_centroid_each_month(df: pd.DataFrame) -> None:
    """Catches a 1-hour DST leak (local wall clock treated as PST in Mar-Nov).

    The solar-weighted mean hour (interval midpoint, PST) must sit near solar noon,
    which for California's fleet is ~11:40-12:15 PST across the year (longitude plus
    equation of time). Real 2024 data: 11.6-12.0 every month. A DST leak moves the
    summer months to ~13.0 (or ~11.0 if shifted the other way).
    """
    ts = pd.to_datetime(df["timestamp"], utc=True).dt.tz_convert("Etc/GMT+8")
    solar = df["solar_mw"].clip(lower=0)
    midpoint = df["hour"] % 24 + 0.5
    month = ts.dt.month
    centroid = (solar * midpoint).groupby(month).sum() / solar.groupby(month).sum()
    assert len(centroid) == 12
    bad = centroid[~centroid.between(11.3, 12.6)].round(2).to_dict()
    assert not bad, f"solar centroid (PST hour) out of range by month: {bad}"


def test_dlap_prices_plausible(df: pd.DataFrame) -> None:
    assert 20 <= df["lmp_dlap_pgae"].mean() <= 100
    for col in LMP_COLS:
        assert 10 <= df[col].mean() <= 120
        assert df[col].between(-500, 2500).all()  # within CAISO DA bid floor/cap


def test_annual_means_plausible(df: pd.DataFrame) -> None:
    assert 100 <= df["grid_co2_kg_per_mwh"].mean() <= 350
    assert 0.35 <= df["grid_cfe_share"].mean() <= 0.8


def test_meta_matches_csv(df: pd.DataFrame) -> None:
    if not META.exists():
        pytest.skip(f"{META.name} missing")
    meta = json.loads(META.read_text())
    assert meta["emission_factors_kg_per_mwh"]["Imports"] == pytest.approx(428.0)
    mean = meta["annual_stats"]["lmp"]["lmp_dlap_pgae"]["mean"]
    assert mean == pytest.approx(df["lmp_dlap_pgae"].mean(), abs=0.05)
    assert all(v <= 0.02 * len(df) for v in meta["filled_hours"].values())
