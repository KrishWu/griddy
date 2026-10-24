"""Community demand shape from EIA-930 PG&E subregion demand, 2024.  OWNER: workstream B.

Offline prep (no API key): downloads the EIA-930 six-month bulk SUBREGION files once into
data/simulate/raw/eia930/, keeps CISO / PGAE, and writes

    data/simulate/eia930_pgae_2024.csv        hour, timestamp, demand_mw, shape
    data/simulate/eia930_pgae_2024_meta.json  sources, fill/outlier counts, mean/peak

Run from backend/:  .venv/bin/python -m app.simulate.prep.community

Time convention (contract): row i = the hour BEGINNING at 2024-01-01 00:00 PST + i hours,
fixed UTC-8 (Etc/GMT+8), no DST, 8784 rows. EIA documents its stamps as hour-ENDING, but
the CISO rows run one hour late against CAISO's own load (EIA_CISO_LABEL_LAG_H), so
hour-beginning = "UTC Time at End of Hour" - (1 + EIA_CISO_LABEL_LAG_H) h, in Etc/GMT+8.
The first raw row then falls in 2023 and the last canonical hour (Dec 31 23:00 PST) is an
edge gap filled like any other.

Cleaning: zero/negative values, values below LOW_FRAC x median and above HIGH_FRAC x median
are treated as missing. Gaps of <= MAX_LINEAR_GAP_H interior hours are linearly
interpolated; longer gaps (and edge hours) copy the same hour one week earlier/later
(nearest day as a fallback), level-shifted to join the neighbours, so a multi-day hole
keeps its daily cycle. More than MAX_REPLACED_FRAC replaced hours fails loudly.
"""

from __future__ import annotations

import hashlib
import json
import sys
import urllib.request
from pathlib import Path

import numpy as np
import pandas as pd

from app import DATA_DIR

YEAR = 2024
TZ = "Etc/GMT+8"  # fixed UTC-8 (POSIX sign is inverted)
BA, SUBREGION = "CISO", "PGAE"
BASE_URL = "https://www.eia.gov/electricity/gridmonitor/sixMonthFiles"
URLS = [
    f"{BASE_URL}/EIA930_SUBREGION_{YEAR}_Jan_Jun.csv",
    f"{BASE_URL}/EIA930_SUBREGION_{YEAR}_Jul_Dec.csv",
]
OUT_DIR = DATA_DIR / "simulate"
RAW_DIR = OUT_DIR / "raw" / "eia930"
OUT_CSV = OUT_DIR / "eia930_pgae_2024.csv"
OUT_META = OUT_DIR / "eia930_pgae_2024_meta.json"

LOW_FRAC = 0.2  # below 0.2 x median MW is a reporting glitch, not load
HIGH_FRAC = 3.0  # above 3 x median MW likewise
MAX_LINEAR_GAP_H = 3  # longer gaps get a diurnal (same hour, +/- 1 week) fill
MAX_REPLACED_FRAC = 0.02  # fail if more than 2% of hours are missing or outliers
WEEK_H, DAY_H = 168, 24
# EIA-930 CISO demand is stamped one hour late: the row EIA labels "ending H" is CAISO's
# hour ENDING H-1. Basis (2024): (a) CAISO Today's Outlook demand.csv (5-min "Current
# demand", via gridstatus CAISO().get_load) matches the CISO-subregion sum to ~0.1% in
# evening/night hours only after this shift, e.g. 2024-07-09 19:00 PST 38,908 MW vs 38,942,
# 2024-01-15 18:00 PST 26,976 vs 27,007; (b) hour-to-hour changes of PGAE correlate best with
# the CAISO fuel-mix net supply (= load, caiso_2024_hourly.csv) at +1 h (0.90 vs 0.72 at 0 h),
# in PST and DST months alike, so it is a label offset, not a DST slip.
EIA_CISO_LABEL_LAG_H = 1


def canonical_index() -> pd.DatetimeIndex:
    return pd.date_range(f"{YEAR}-01-01", periods=8784, freq="h", tz=TZ)


def download(raw_dir: Path = RAW_DIR) -> list[Path]:
    """Fetch each six-month file once; skip files already on disk."""
    raw_dir.mkdir(parents=True, exist_ok=True)
    paths: list[Path] = []
    for url in URLS:
        path = raw_dir / url.rsplit("/", 1)[1]
        if not (path.exists() and path.stat().st_size > 1_000_000):
            print(f"downloading {url}")
            tmp = path.with_suffix(".part")
            req = urllib.request.Request(url, headers={"User-Agent": "GridForge-prep/1.0"})
            with urllib.request.urlopen(req, timeout=300) as resp, tmp.open("wb") as fh:
                while chunk := resp.read(1 << 20):
                    fh.write(chunk)
            tmp.replace(path)
        paths.append(path)
    return paths


def load_raw(paths: list[Path]) -> tuple[pd.Series, int]:
    """PG&E demand (MW, float, NaN where blank) on its hour-beginning Etc/GMT+8 stamps.

    Returns (series, number of duplicate timestamps averaged).
    """
    cols = ["Balancing Authority", "Sub-Region", "Demand (MW)", "UTC Time at End of Hour"]
    frames = []
    for path in paths:
        df = pd.read_csv(path, usecols=cols, dtype=str)
        frames.append(df[(df["Balancing Authority"] == BA) & (df["Sub-Region"] == SUBREGION)])
    df = pd.concat(frames, ignore_index=True)
    if df.empty:
        raise RuntimeError(f"no {BA}/{SUBREGION} rows in {[p.name for p in paths]}")
    end_utc = pd.to_datetime(
        df["UTC Time at End of Hour"], format="%m/%d/%Y %I:%M:%S %p", utc=True
    )
    # Hour-ending -> hour-beginning, plus the CISO label correction (see EIA_CISO_LABEL_LAG_H).
    # Explicit unit: Timedelta(hours=1) on a Series trips a numpy 2.5 deprecation.
    shift = pd.Timedelta(1 + EIA_CISO_LABEL_LAG_H, unit="h")
    begin = pd.DatetimeIndex(end_utc).tz_convert(TZ) - shift
    mw = pd.to_numeric(df["Demand (MW)"].str.replace(",", "", regex=False).str.strip(),
                       errors="coerce")
    s = pd.Series(mw.to_numpy(dtype=float), index=begin, name="demand_mw")
    n_dup = int(s.index.duplicated().sum())
    if n_dup:
        s = s.groupby(level=0).mean()
    return s.sort_index(), n_dup


def _runs(mask: np.ndarray) -> list[tuple[int, int]]:
    """Inclusive (start, end) index pairs of consecutive True values."""
    padded = np.concatenate([[False], mask, [False]]).astype(int)
    d = np.diff(padded)
    starts, ends = np.flatnonzero(d == 1), np.flatnonzero(d == -1) - 1
    return [(int(a), int(b)) for a, b in zip(starts, ends)]


def _template(v: np.ndarray, i: int) -> float:
    """Same hour one week away (mean of both sides if present), else one day away."""
    n = len(v)
    for lag in (WEEK_H, DAY_H, 2 * WEEK_H):
        vals = [v[j] for j in (i - lag, i + lag) if 0 <= j < n and np.isfinite(v[j])]
        if vals:
            return float(np.mean(vals))
    return float("nan")


def fill_gaps(v: np.ndarray) -> tuple[np.ndarray, int, int]:
    """Fill NaNs (on a copy). Returns (filled, n_linear, n_diurnal)."""
    src = v.copy()  # templates read only original (unfilled) data
    out = v.copy()
    n = len(v)
    n_linear = n_diurnal = 0
    for a, b in _runs(~np.isfinite(v)):
        length = b - a + 1
        interior = a > 0 and b < n - 1
        if interior and length <= MAX_LINEAR_GAP_H:
            xs = np.arange(a, b + 1)
            out[a : b + 1] = np.interp(xs, [a - 1, b + 1], [src[a - 1], src[b + 1]])
            n_linear += length
            continue
        tmpl = np.array([_template(src, i) for i in range(a, b + 1)])
        # Level shift so the copied segment meets the real data at both ends.
        off_a = src[a - 1] - _template(src, a - 1) if a > 0 else np.nan
        off_b = src[b + 1] - _template(src, b + 1) if b < n - 1 else np.nan
        off_a = off_a if np.isfinite(off_a) else (off_b if np.isfinite(off_b) else 0.0)
        off_b = off_b if np.isfinite(off_b) else off_a
        w = (np.arange(length) + 1) / (length + 1)
        out[a : b + 1] = tmpl + (1 - w) * off_a + w * off_b
        n_diurnal += length
    if not np.all(np.isfinite(out)):
        raise RuntimeError("gap fill left NaN values; raw data too sparse")
    return out, n_linear, n_diurnal


def build(paths: list[Path]) -> tuple[pd.DataFrame, dict]:
    raw, n_dup = load_raw(paths)
    idx = canonical_index()
    n_outside = int((~raw.index.isin(idx)).sum())  # rows outside the 2024 PST year
    s = raw.reindex(idx)
    v = s.to_numpy(dtype=float)
    n_absent = int((~idx.isin(raw.index)).sum())  # canonical hours with no row at all
    n_missing = int((~np.isfinite(v)).sum())  # absent rows + blank/unparseable values
    med = float(np.nanmedian(v))
    bad = np.isfinite(v) & ((v <= 0) | (v < LOW_FRAC * med) | (v > HIGH_FRAC * med))
    n_outliers = int(bad.sum())
    v[bad] = np.nan
    replaced = n_missing + n_outliers
    if replaced > MAX_REPLACED_FRAC * len(idx):
        raise RuntimeError(
            f"{replaced} of {len(idx)} hours missing/outlier (> {MAX_REPLACED_FRAC:.0%}); "
            "check the EIA download"
        )
    gap_runs = _runs(~np.isfinite(v))
    demand, n_linear, n_diurnal = fill_gaps(v)

    demand_mw = np.round(demand, 1)
    shape = np.round(demand_mw / demand_mw.mean(), 4)
    out = pd.DataFrame({
        "hour": np.arange(len(idx)),
        "timestamp": [t.isoformat() for t in idx],
        "demand_mw": demand_mw,
        "shape": shape,
    })

    i_peak, i_min = int(np.argmax(demand_mw)), int(np.argmin(demand_mw))
    hod = out.groupby(out["hour"] % 24)["shape"].mean()
    daily_min_hour = (
        pd.Series(demand_mw).groupby(np.arange(len(idx)) // 24).idxmin() % 24
    ).value_counts()
    meta = {
        "source": "EIA-930 Hourly Electric Grid Monitor, six-month SUBREGION bulk files",
        "provenance": {
            "kind": "observed",
            "source": "EIA-930 2024, CAISO subregion PGAE",
            "url": "https://www.eia.gov/electricity/gridmonitor/",
            "note": ("Hourly PG&E-area demand; gaps/outliers filled (see counts); EIA CISO "
                     "stamps shifted 1 h earlier to match CAISO load (see time_correction)."),
        },
        "urls": URLS,
        "raw_files": [
            {"name": p.name, "bytes": p.stat().st_size,
             "sha256": hashlib.sha256(p.read_bytes()).hexdigest()}
            for p in paths
        ],
        "balancing_authority": BA,
        "sub_region": SUBREGION,
        "time_convention": (
            "row i = hour beginning 2024-01-01T00:00-08:00 + i h (Etc/GMT+8, no DST); "
            f"hour beginning = 'UTC Time at End of Hour' - {1 + EIA_CISO_LABEL_LAG_H} h "
            f"(1 h hour-ending convention + {EIA_CISO_LABEL_LAG_H} h CISO label correction)"
        ),
        "time_correction": {
            "eia_ciso_label_lag_h": EIA_CISO_LABEL_LAG_H,
            "reason": (
                "EIA-930 CISO rows run one hour late against CAISO's own load: the row EIA "
                "labels 'ending H' matches CAISO's hour ending H-1. Shifted 1 h earlier so the "
                "shape lines up with the CAISO prices and fuel mix in caiso_2024_hourly.csv."
            ),
            "evidence": [
                "CAISO Today's Outlook demand.csv (5-min 'Current demand', gridstatus "
                "CAISO().get_load, hourly mean) vs the sum of EIA CISO subregions: MAPE "
                "5.6% same-hour vs 3.9% shifted on 2024-07-09 and 5.3% vs 3.6% on "
                "2024-01-15; evening hours agree to ~0.1% only when shifted (07-09 19:00 PST "
                "38,908 vs 38,942 MW; 20:00 37,531 vs 37,529; 01-15 18:00 26,976 vs 27,007).",
                "Correlation of hour-to-hour changes, PGAE vs CAISO fuel-mix net supply "
                "(sum of the signed *_mw columns of caiso_2024_hourly.csv = CAISO load), "
                "before the shift: 0.72 at lag 0, 0.90 at EIA +1 h, 0.79 at +2 h; PST months "
                "0.66 vs 0.90, DST months 0.74 vs 0.90 (a label offset, not a DST slip).",
                "Daily peak hour, EIA CISO sum minus CAISO net supply, before the shift: "
                "+1 h on 270 days, 0 h on 47.",
                "Cross-check: CAISO fuel-mix solar centroid falls at 11.6-12.0 PST every "
                "month, so the CAISO side is not the shifted one.",
            ],
        },
        "rows": len(out),
        "raw_rows": int(len(raw) + n_dup),
        "raw_rows_outside_year": n_outside,
        "duplicate_timestamps_averaged": n_dup,
        "absent_hours": n_absent,
        "missing_hours_filled": n_missing,
        "outliers_replaced": n_outliers,
        "outlier_rule": (
            f"<= 0, < {LOW_FRAC} x median or > {HIGH_FRAC} x median (median {med:.0f} MW)"
        ),
        "gap_runs": [
            {"start": idx[a].isoformat(), "hours": int(b - a + 1)} for a, b in gap_runs
        ],
        "filled_linear_hours": n_linear,
        "filled_diurnal_hours": n_diurnal,
        "mean_mw": round(float(demand_mw.mean()), 1),
        "peak_mw": float(demand_mw[i_peak]),
        "peak_timestamp": idx[i_peak].isoformat(),
        "min_mw": float(demand_mw[i_min]),
        "min_timestamp": idx[i_min].isoformat(),
        "annual_energy_twh": round(float(demand_mw.sum()) / 1e6, 2),
        "shape_mean": round(float(shape.mean()), 6),
        "shape_min": float(shape.min()),
        "shape_max": float(shape.max()),
        "monthly_mean_mw": {
            str(int(m)): round(float(x), 1)
            for m, x in pd.Series(demand_mw, index=idx).groupby(idx.month).mean().items()
        },
        "hour_of_day_mean_shape": [round(float(x), 4) for x in hod],
        "daily_min_hour_counts": {int(h): int(c) for h, c in daily_min_hour.sort_index().items()},
    }
    return out, meta


def main() -> int:
    paths = download()
    out, meta = build(paths)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out.assign(demand_mw=out["demand_mw"].map(lambda x: f"{x:.1f}"),
               shape=out["shape"].map(lambda x: f"{x:.4f}")).to_csv(OUT_CSV, index=False)
    OUT_META.write_text(json.dumps(meta, indent=2) + "\n")
    print(f"wrote {OUT_CSV} ({len(out)} rows) and {OUT_META.name}")
    for k in ("missing_hours_filled", "outliers_replaced", "filled_linear_hours",
              "filled_diurnal_hours", "mean_mw", "peak_mw", "peak_timestamp", "min_mw",
              "min_timestamp", "annual_energy_twh", "shape_mean", "shape_min", "shape_max"):
        print(f"  {k}: {meta[k]}")
    print(f"  gap_runs: {meta['gap_runs']}")
    print(f"  monthly_mean_mw: {meta['monthly_mean_mw']}")
    hod = meta["hour_of_day_mean_shape"]
    print("  hour_of_day_mean_shape: " + " ".join(f"{h}:{x:.3f}" for h, x in enumerate(hod)))
    print(f"  daily_min_hour_counts: {meta['daily_min_hour_counts']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
