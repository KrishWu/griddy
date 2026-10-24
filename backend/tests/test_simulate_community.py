"""Community demand shape (EIA-930 PG&E 2024).  OWNER: workstream B.

Checks data/simulate/eia930_pgae_2024.csv written by app.simulate.prep.community
(skipped if it has not been generated) plus the gap-fill logic on synthetic data.
Ranges and invariants only, never exact MW.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from app import DATA_DIR
from app.simulate.prep.community import canonical_index, fill_gaps

CSV = DATA_DIR / "simulate" / "eia930_pgae_2024.csv"


@pytest.fixture(scope="module")
def df() -> pd.DataFrame:
    if not CSV.exists():
        pytest.skip(f"{CSV.name} missing; run `python -m app.simulate.prep.community`")
    return pd.read_csv(CSV)


def test_rows_and_time_index(df: pd.DataFrame) -> None:
    assert len(df) == 8784
    assert list(df.columns) == ["hour", "timestamp", "demand_mw", "shape"]
    assert (df["hour"].to_numpy() == np.arange(8784)).all()
    ts = pd.DatetimeIndex(pd.to_datetime(df["timestamp"])).tz_convert("Etc/GMT+8")
    assert ts.equals(canonical_index())


def test_no_nan_and_plausible_mw(df: pd.DataFrame) -> None:
    assert np.isfinite(df[["demand_mw", "shape"]].to_numpy()).all()
    assert (df["demand_mw"] > 0).all()
    assert 8_000 < df["demand_mw"].mean() < 15_000  # PG&E area ~10-13 GW average


def test_shape_normalized(df: pd.DataFrame) -> None:
    shape = df["shape"]
    assert abs(shape.mean() - 1.0) < 0.01
    assert shape.min() > 0.3
    assert shape.max() < 2.5
    ratio = df["demand_mw"] / df["demand_mw"].mean()
    assert np.allclose(shape, ratio, atol=1e-3)


def test_summer_peak(df: pd.DataFrame) -> None:
    month = pd.to_datetime(df["timestamp"]).dt.month
    assert month.iloc[int(df["demand_mw"].idxmax())] in (6, 7, 8, 9)


def test_evening_above_night(df: pd.DataFrame) -> None:
    hod = df["shape"].groupby(df["hour"] % 24).mean()
    assert hod.loc[16:19].mean() > hod.loc[2:5].mean()


def test_fill_gaps_keeps_daily_cycle() -> None:
    n = 24 * 28
    h = np.arange(n)
    truth = 10_000 + 2_000 * np.sin(2 * np.pi * (h % 24 - 10) / 24)
    v = truth.copy()
    v[300:348] = np.nan  # 48 h hole: diurnal fill
    v[100:102] = np.nan  # 2 h hole: linear
    v[:3] = np.nan  # edge hours
    out, n_linear, n_diurnal = fill_gaps(v)
    assert np.isfinite(out).all()
    assert n_linear == 2 and n_diurnal == 51
    assert np.allclose(out[300:348], truth[300:348], rtol=1e-6)  # periodic -> exact copy
    assert np.allclose(out[:3], truth[:3], rtol=1e-6)
    assert np.isnan(v).sum() == 53  # input not mutated
    assert np.array_equal(out[~np.isnan(v)], v[~np.isnan(v)])  # real hours kept as-is
