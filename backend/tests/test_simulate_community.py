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
from app.simulate.prep.community import (
    EIA_CISO_LABEL_LAG_H,
    canonical_index,
    fill_gaps,
    load_raw,
)

CSV = DATA_DIR / "simulate" / "eia930_pgae_2024.csv"
CAISO_CSV = DATA_DIR / "simulate" / "caiso_2024_hourly.csv"


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


def _diff_corr(a: np.ndarray, b: np.ndarray, lag: int) -> float:
    """corr(diff a[t + lag], diff b[t]); a positive best lag means `a` runs late of `b`."""
    da, db = np.diff(a), np.diff(b)
    if lag > 0:
        da, db = da[lag:], db[:-lag]
    elif lag < 0:
        da, db = da[:lag], db[-lag:]
    return float(np.corrcoef(da, db)[0, 1])


def test_aligned_with_caiso_load(df: pd.DataFrame) -> None:
    """EIA's CISO stamps run 1 h late; after the prep correction the shape must line up
    with CAISO's own load (net of the signed fuel-mix columns = supply = load) at lag 0."""
    if not CAISO_CSV.exists():
        pytest.skip(f"{CAISO_CSV.name} missing; run `python -m app.simulate.prep.caiso`")
    caiso = pd.read_csv(CAISO_CSV)
    assert len(caiso) == len(df)
    net = caiso[[c for c in caiso.columns if c.endswith("_mw")]].sum(axis=1).to_numpy(float)
    eia = df["demand_mw"].to_numpy(float)
    corr = {lag: _diff_corr(eia, net, lag) for lag in range(-3, 4)}
    assert max(corr, key=corr.__getitem__) == 0, corr
    assert corr[0] > 0.8  # PG&E is ~45% of CAISO load; same-hour changes track closely
    assert corr[0] - max(corr[-1], corr[1]) > 0.05, corr  # a clear peak, not a tie


def test_load_raw_applies_ciso_label_lag(tmp_path) -> None:
    """A row EIA stamps 'UTC end 10:00' (02:00 PST) is the hour beginning 00:00 PST."""
    path = tmp_path / "sub.csv"
    path.write_text(
        '"Balancing Authority","Data Date","Hour Number","Sub-Region","Demand (MW)",'
        '"Local Time at End of Hour","UTC Time at End of Hour"\n'
        'CISO,01/01/2024,2,PGAE,"9,905",01/01/2024 2:00:00 AM,01/01/2024 10:00:00 AM\n'
        "CISO,01/01/2024,2,SCE,9800,01/01/2024 2:00:00 AM,01/01/2024 10:00:00 AM\n"
    )
    s, n_dup = load_raw([path])
    assert EIA_CISO_LABEL_LAG_H == 1
    assert n_dup == 0 and len(s) == 1  # other subregions dropped
    assert s.index[0] == pd.Timestamp("2024-01-01 00:00", tz="Etc/GMT+8")
    assert s.iloc[0] == 9905.0  # thousands separator parsed


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
