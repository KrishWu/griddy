"""CAISO 2024 hourly price + grid-carbon profile.  OWNER: workstream B (Simulate + Stress Test).

Offline prep script (B brief P0 #2). Run from backend/:

    .venv/bin/python -m app.simulate.prep.caiso

Fetches, via gridstatus:
  * OASIS PRC_LMP, market DAM: day-ahead hourly LMP at the three load aggregation
    points DLAP_PGAE-APND / DLAP_SCE-APND / DLAP_SDGE-APND (a load buys at its DLAP,
    not at a TH_*_GEN trading hub);
  * CAISO Today's Outlook fuel mix (5-minute, outlook/history/<yyyymmdd>/fuelsource.csv).

Raw month files go to data/simulate/raw/caiso/ (git-ignored). A month whose file is
already there is skipped, so an interrupted run resumes where it stopped.

Writes data/simulate/caiso_2024_hourly.csv (8784 rows) and caiso_2024_meta.json.
TIME CONVENTION (contract): row i = the hour beginning 2024-01-01 00:00 PST + i hours,
fixed UTC-8 ("Etc/GMT+8"), no DST.

Grid CO2 (kg/MWh) = sum(MW_fuel * EF_fuel) / sum(positive supply);
grid CFE share = (solar + wind + geothermal + nuclear + hydro) / sum(positive supply).
Both use hourly-mean MW with negatives (battery charging, solar night parasitics,
net exports) clipped to 0; the denominator includes Imports and Batteries.
"""

from __future__ import annotations

import json
import logging
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from pathlib import Path
from typing import TypeVar

import gridstatus
import numpy as np
import pandas as pd

from app import DATA_DIR

YEAR = 2024
TZ_CONTRACT = "Etc/GMT+8"  # fixed UTC-8 (POSIX sign is inverted)
TZ_CAISO = "US/Pacific"  # what gridstatus returns (with DST)

OUT_DIR = DATA_DIR / "simulate"
RAW_DIR = OUT_DIR / "raw" / "caiso"
OUT_CSV = OUT_DIR / f"caiso_{YEAR}_hourly.csv"
OUT_META = OUT_DIR / f"caiso_{YEAR}_meta.json"

# Output column -> OASIS node.
DLAPS: dict[str, str] = {
    "lmp_dlap_pgae": "DLAP_PGAE-APND",
    "lmp_dlap_sce": "DLAP_SCE-APND",
    "lmp_dlap_sdge": "DLAP_SDGE-APND",
}

# CAISO fuel-mix column -> output column (hourly mean MW).
FUELS: dict[str, str] = {
    "Solar": "solar_mw",
    "Wind": "wind_mw",
    "Geothermal": "geothermal_mw",
    "Biomass": "biomass_mw",
    "Biogas": "biogas_mw",
    "Small Hydro": "small_hydro_mw",
    "Coal": "coal_mw",
    "Nuclear": "nuclear_mw",
    "Natural Gas": "natural_gas_mw",
    "Large Hydro": "large_hydro_mw",
    "Batteries": "batteries_mw",
    "Imports": "imports_mw",
    "Other": "other_mw",
}

# Average emission factors, kg CO2 per MWh generated.
EMISSION_FACTORS_KG_PER_MWH: dict[str, float] = {
    "Natural Gas": 400.0,
    "Imports": 428.0,
    "Coal": 1000.0,
    "Other": 400.0,
    "Biomass": 0.0,
    "Biogas": 0.0,
    "Solar": 0.0,
    "Wind": 0.0,
    "Geothermal": 0.0,
    "Nuclear": 0.0,
    "Large Hydro": 0.0,
    "Small Hydro": 0.0,
    "Batteries": 0.0,
}
EMISSION_FACTOR_SOURCES: dict[str, str] = {
    "Natural Gas": (
        "Assumption: California gas fleet average ~0.40 t CO2/MWh (mix of CCGT and "
        "peakers; ~7,500 Btu/kWh x EPA natural-gas factor 53.06 kg CO2/MMBtu). "
        "Cross-check against EPA eGRID CAMX gas plants."
    ),
    "Imports": (
        "CARB Mandatory Reporting Regulation default emission factor for unspecified "
        "electricity imports, 0.428 t CO2e/MWh (17 CCR 95111(b)(1))."
    ),
    "Coal": "Assumption: typical coal unit ~1.0 t CO2/MWh (CAISO in-state coal is ~0 MW in 2024).",
    "Other": "Assumption: treated as gas-like (0.40 t/MWh); CAISO 'Other' is near zero most hours.",
    "Biomass": "Biogenic CO2 counted as 0, following the CARB convention for biomass combustion.",
    "Biogas": "Biogenic CO2 counted as 0, following the CARB convention for biogas combustion.",
    "Solar, Wind, Geothermal, Nuclear, Large Hydro, Small Hydro, Batteries": (
        "Zero operational CO2 (battery discharge is re-timed energy; charging is "
        "clipped to 0 and excluded)."
    ),
}
CLEAN_FUELS = ("Solar", "Wind", "Geothermal", "Nuclear", "Large Hydro", "Small Hydro")

# Gap filling. CAISO's published day files occasionally end early (e.g. 2024-01-11
# stops at 14:30 PST), so a few whole hours are missing at the source.
MAX_INTERP_HOURS = 3  # gaps up to this long: linear interpolation
MAX_GAP_HOURS = 12  # longer gaps up to this: same PST hour on the nearest days with data
MAX_MISSING_FRACTION = 0.02  # fail loudly above this per column
FUEL_WORKERS = 4  # parallel day downloads from caiso.com (polite)

OASIS_URL = (
    "https://oasis.caiso.com/oasisapi/SingleZip?resultformat=6&queryname=PRC_LMP"
    "&version=12&market_run_id=DAM&node=DLAP_PGAE-APND,DLAP_SCE-APND,DLAP_SDGE-APND"
)
FUEL_URL = "https://www.caiso.com/outlook/history/{yyyymmdd}/fuelsource.csv"

log = logging.getLogger("gridforge.prep.caiso")
T = TypeVar("T")


def canonical_index() -> pd.DatetimeIndex:
    """The contract's hourly index: hour-beginning, fixed UTC-8, 8784 h in 2024."""
    return pd.date_range(f"{YEAR}-01-01", periods=8784, freq="h", tz=TZ_CONTRACT)


def _local_days() -> list[pd.Timestamp]:
    """Every US/Pacific calendar day that overlaps the PST year (edge days included)."""
    idx = canonical_index()
    first = idx[0].tz_convert(TZ_CAISO).normalize().tz_localize(None)
    last = idx[-1].tz_convert(TZ_CAISO).normalize().tz_localize(None)
    return list(pd.date_range(first, last, freq="D"))


def _months(days: list[pd.Timestamp]) -> dict[str, list[pd.Timestamp]]:
    out: dict[str, list[pd.Timestamp]] = {}
    for d in days:
        out.setdefault(d.strftime("%Y-%m"), []).append(d)
    return out


def _retry(fn: Callable[[], T], what: str, attempts: int = 6, base_sleep_s: float = 5.0) -> T:
    """Call fn with exponential backoff. Empty DataFrames count as failures (OASIS
    answers rate limits and outages with an empty result, not an exception)."""
    for attempt in range(1, attempts + 1):
        try:
            result = fn()
            if isinstance(result, pd.DataFrame) and result.empty:
                raise RuntimeError("empty result")
            return result
        except Exception as exc:  # network, parsing, rate limit: all retried
            if attempt == attempts:
                raise RuntimeError(f"{what}: failed after {attempts} attempts: {exc}") from exc
            wait = base_sleep_s * 2 ** (attempt - 1)
            log.warning("%s: attempt %d failed (%s); retrying in %.0fs", what, attempt, exc, wait)
            time.sleep(wait)
    raise AssertionError("unreachable")


def _write_atomic(df: pd.DataFrame, path: Path) -> None:
    """Write a CSV via a temp file so an interrupted run never leaves a 'done' month."""
    tmp = path.with_suffix(".tmp")
    df.to_csv(tmp, index=False)
    tmp.replace(path)


# --------------------------------------------------------------------------- LMP


def _fetch_lmp_month(caiso: gridstatus.CAISO, month: str, days: list[pd.Timestamp]) -> pd.DataFrame:
    """One OASIS PRC_LMP DAM request (<= 31 days) for the three DLAPs, cached per month."""
    path = RAW_DIR / f"lmp_dam_dlap_{month}.csv"
    if path.exists():
        return pd.read_csv(path, parse_dates=["interval_start_utc"])

    start = pd.Timestamp(days[0]).tz_localize(TZ_CAISO)
    end = (pd.Timestamp(days[-1]) + pd.DateOffset(days=1)).tz_localize(TZ_CAISO)
    expected_hours = round((end - start).total_seconds() / 3600)  # 743 in March, 721 in Nov

    def pull() -> pd.DataFrame:
        df = caiso.get_oasis_dataset(
            dataset="lmp_day_ahead_hourly",
            date=start,
            end=end,
            params={"node": ",".join(DLAPS.values())},
            raw_data=False,
            sleep=2,
        )
        if df.empty:
            return df
        df = df[df["LMP_TYPE"] == "LMP"]
        got = df.groupby("NODE")["Interval Start"].nunique()
        short = {n: int(got.get(n, 0)) for n in DLAPS.values() if got.get(n, 0) < 0.98 * expected_hours}
        if short:
            raise RuntimeError(f"incomplete month, hours per node {short} of {expected_hours}")
        return df

    df = _retry(pull, f"LMP {month}")
    raw = pd.DataFrame(
        {
            "interval_start_utc": df["Interval Start"].dt.tz_convert("UTC"),
            "node": df["NODE"].values,
            "lmp_usd_per_mwh": df["MW"].astype(float).values,
        }
    ).sort_values(["interval_start_utc", "node"])
    _write_atomic(raw, path)
    log.info("LMP %s: %d rows saved", month, len(raw))
    return raw


def load_lmp(days: list[pd.Timestamp]) -> pd.DataFrame:
    caiso = gridstatus.CAISO()
    frames = [_fetch_lmp_month(caiso, m, d) for m, d in _months(days).items()]
    raw = pd.concat(frames, ignore_index=True)
    raw["ts"] = pd.to_datetime(raw["interval_start_utc"], utc=True).dt.tz_convert(TZ_CONTRACT)
    dupes = raw.duplicated(["ts", "node"]).sum()
    if dupes:
        log.warning("LMP: dropping %d duplicate (hour, node) rows", dupes)
        raw = raw.drop_duplicates(["ts", "node"], keep="last")
    wide = raw.pivot(index="ts", columns="node", values="lmp_usd_per_mwh")
    return wide.rename(columns={v: k for k, v in DLAPS.items()})[list(DLAPS)]


# ---------------------------------------------------------------------- fuel mix


def _fetch_fuel_day(caiso: gridstatus.CAISO, day: pd.Timestamp) -> pd.DataFrame:
    def pull() -> pd.DataFrame:
        return caiso.get_fuel_mix(day.strftime("%Y-%m-%d"))

    df = _retry(pull, f"fuel mix {day:%Y-%m-%d}", attempts=5, base_sleep_s=3.0)
    unknown = set(df.columns) - set(FUELS) - {"Time", "Interval Start", "Interval End"}
    if unknown:
        raise RuntimeError(f"fuel mix {day:%Y-%m-%d}: unknown columns {sorted(unknown)} (need an EF)")
    out = pd.DataFrame({"interval_start_utc": df["Interval Start"].dt.tz_convert("UTC")})
    for col in FUELS:
        out[col] = pd.to_numeric(df[col], errors="coerce") if col in df.columns else np.nan
    return out


def _fetch_fuel_month(caiso: gridstatus.CAISO, month: str, days: list[pd.Timestamp]) -> pd.DataFrame:
    """Every day of one month of 5-minute fuel mix, cached as one raw file."""
    path = RAW_DIR / f"fuelmix_5min_{month}.csv"
    if path.exists():
        return pd.read_csv(path, parse_dates=["interval_start_utc"])
    with ThreadPoolExecutor(max_workers=FUEL_WORKERS) as pool:
        frames = list(pool.map(lambda d: _fetch_fuel_day(caiso, d), days))
    raw = pd.concat(frames, ignore_index=True).sort_values("interval_start_utc")
    _write_atomic(raw, path)
    log.info("fuel mix %s: %d days, %d rows saved", month, len(days), len(raw))
    return raw


def load_fuel_mix(days: list[pd.Timestamp]) -> tuple[pd.DataFrame, pd.Series]:
    """Hourly mean MW per fuel (intervals starting in each PST hour) and intervals/hour."""
    caiso = gridstatus.CAISO()
    frames = [_fetch_fuel_month(caiso, m, d) for m, d in _months(days).items()]
    raw = pd.concat(frames, ignore_index=True)
    ts = pd.to_datetime(raw["interval_start_utc"], utc=True).dt.tz_convert(TZ_CONTRACT)
    # gridstatus maps CAISO's single 01:xx block on the fall-back day to PDT, so
    # 01:00 PST that day has no intervals; it shows up as a 1-hour gap and is filled.
    raw = raw.drop(columns="interval_start_utc").assign(ts=ts).drop_duplicates("ts", keep="last")
    hour = raw["ts"].dt.floor("h")
    hourly = raw.drop(columns="ts").groupby(hour).mean()
    counts = raw.groupby(hour).size()
    return hourly.rename(columns=FUELS), counts


# ---------------------------------------------------------------------- assemble


def _gaps(missing: pd.Series) -> list[tuple[int, int]]:
    """(start position, length) of each run of True."""
    m = missing.to_numpy()
    edges = np.flatnonzero(np.diff(np.r_[0, m.astype(int), 0]))
    return [(int(a), int(b - a)) for a, b in zip(edges[::2], edges[1::2])]


def _fill_gaps(df: pd.DataFrame) -> dict[str, dict[str, int]]:
    """Fill missing hours in place, per column:
    * gaps <= MAX_INTERP_HOURS: linear interpolation;
    * gaps <= MAX_GAP_HOURS: mean of the same PST hour on the nearest days (+-1, +-2, +-3)
      that have observed data, which keeps the diurnal shape (solar, duck curve);
    * anything longer, or > MAX_MISSING_FRACTION of a column: raise.
    Returns {column: {"interpolated": n, "neighbor_day_same_hour": n}}."""
    filled: dict[str, dict[str, int]] = {}
    for col in df.columns:
        s = df[col]
        missing = s.isna()
        n = int(missing.sum())
        filled[col] = {"interpolated": 0, "neighbor_day_same_hour": 0}
        if n == 0:
            continue
        if n > MAX_MISSING_FRACTION * len(df):
            raise RuntimeError(f"{col}: {n} of {len(df)} hours missing (> {MAX_MISSING_FRACTION:.0%})")
        observed = s.to_numpy(dtype=float).copy()
        values = observed.copy()
        for start, length in _gaps(missing):
            if length > MAX_GAP_HOURS:
                raise RuntimeError(f"{col}: a {length} h gap at {s.index[start]} exceeds {MAX_GAP_HOURS} h")
            if length <= MAX_INTERP_HOURS:
                continue  # interpolated below
            for i in range(start, start + length):
                for k in (24, 48, 72):
                    near = [observed[j] for j in (i - k, i + k) if 0 <= j < len(s) and np.isfinite(observed[j])]
                    if near:
                        values[i] = float(np.mean(near))
                        filled[col]["neighbor_day_same_hour"] += 1
                        break
                else:
                    raise RuntimeError(f"{col}: no neighbor-day data to fill {s.index[i]}")
        out = pd.Series(values, index=s.index).interpolate(limit_direction="both")
        filled[col]["interpolated"] = int(out.notna().sum() - pd.Series(values).notna().sum())
        df[col] = out
    return filled


def _gap_log(df: pd.DataFrame) -> list[dict[str, object]]:
    """Whole-row gaps (any column missing) for the meta file, before filling."""
    return [
        {"start": df.index[a].isoformat(), "hours": n, "method": "interpolated" if n <= MAX_INTERP_HOURS else "neighbor_day_same_hour"}
        for a, n in _gaps(df.isna().any(axis=1))
    ]


def grid_intensity(fuel_mw: pd.DataFrame) -> tuple[pd.Series, pd.Series]:
    """(grid CO2 kg/MWh, CFE share 0-1) per hour from hourly-mean fuel MW (CAISO names)."""
    pos = fuel_mw.clip(lower=0.0)
    supply = pos.sum(axis=1)
    if (supply <= 0).any():
        raise RuntimeError("an hour has no positive supply; cannot compute intensity")
    ef = pd.Series(EMISSION_FACTORS_KG_PER_MWH)[pos.columns]
    co2 = (pos * ef).sum(axis=1) / supply
    cfe = pos[list(CLEAN_FUELS)].sum(axis=1) / supply
    return co2, cfe


def build() -> tuple[pd.DataFrame, dict]:
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    idx = canonical_index()
    days = _local_days()
    log.info("PST year needs %d US/Pacific days (%s .. %s)", len(days), days[0].date(), days[-1].date())

    lmp = load_lmp(days)
    fuel, counts = load_fuel_mix(days)

    # Keep only the PST year, then require the exact canonical index.
    lmp = lmp.reindex(idx)
    fuel = fuel.reindex(idx)
    counts = counts.reindex(idx, fill_value=0)
    assert lmp.index.equals(idx) and fuel.index.equals(idx), "index != canonical PST index"

    gaps = {"lmp": _gap_log(lmp), "fuel_mix": _gap_log(fuel)}
    filled = _fill_gaps(lmp) | _fill_gaps(fuel)

    caiso_names = {v: k for k, v in FUELS.items()}
    co2, cfe = grid_intensity(fuel.rename(columns=caiso_names))

    out = pd.DataFrame(
        {
            "hour": np.arange(len(idx)),
            "timestamp": [t.isoformat() for t in idx],
            **{c: lmp[c].round(2).values for c in DLAPS},
            "grid_co2_kg_per_mwh": co2.round(1).values,
            "grid_cfe_share": cfe.clip(0.0, 1.0).round(4).values,
            **{c: fuel[c].round(1).values for c in FUELS.values()},
        }
    )
    numeric = out.drop(columns="timestamp").to_numpy(dtype=float)
    assert len(out) == 8784 and np.isfinite(numeric).all(), "NaN/inf reached the output"
    return out, _meta(out, filled, gaps, counts)


# -------------------------------------------------------------------------- meta


def _r(x: float, nd: int = 2) -> float:
    return round(float(x), nd)


def _meta(
    out: pd.DataFrame,
    filled: dict[str, dict[str, int]],
    gaps: dict[str, list[dict[str, object]]],
    counts: pd.Series,
) -> dict:
    hod = out["hour"] % 24
    month = pd.to_datetime(out["timestamp"].str[:7])
    spring = month.dt.month.isin([3, 4, 5])
    fuel_cols = list(FUELS.values())
    mean_mw = out[fuel_cols].clip(lower=0).mean()
    lmp_stats = {
        c: {
            "node": DLAPS[c],
            "mean": _r(out[c].mean()),
            "min": _r(out[c].min()),
            "max": _r(out[c].max()),
            "share_hours_negative": _r((out[c] < 0).mean(), 4),
            "spring_midday_share_negative": _r((out.loc[spring & hod.between(10, 15), c] < 0).mean(), 4),
        }
        for c in DLAPS
    }
    return {
        "description": "CAISO 2024 hourly DA DLAP LMPs, fuel mix and average grid CO2 / CFE share.",
        "owner": "workstream B (Simulate + Stress Test)",
        "generated_at": datetime.now(UTC).isoformat(timespec="seconds"),
        "generator": "backend/app/simulate/prep/caiso.py",
        "time_convention": (
            "row i = hour beginning 2024-01-01T00:00-08:00 + i h; fixed UTC-8 (Etc/GMT+8), "
            "no DST; 8784 rows (leap year). gridstatus 'Interval Start' (US/Pacific) "
            "converted with tz_convert('Etc/GMT+8')."
        ),
        "units": {
            "lmp_dlap_*": "USD/MWh (day-ahead hourly LMP)",
            "grid_co2_kg_per_mwh": "kg CO2/MWh, average (not marginal) intensity of CAISO supply",
            "grid_cfe_share": "0-1 fraction of positive supply that is carbon-free",
            "*_mw": "hourly mean MW of the 5-minute fuel mix (net; negative = charging/parasitic/export)",
        },
        "provenance": "observed (prices, fuel mix); inferred (CO2 via assumed emission factors)",
        "sources": {
            "gridstatus_version": gridstatus.__version__,
            "lmp": {
                "name": "CAISO OASIS PRC_LMP, market_run_id=DAM (day-ahead hourly), LMP component",
                "nodes": list(DLAPS.values()),
                "url": OASIS_URL,
                "gridstatus_call": "CAISO().get_oasis_dataset('lmp_day_ahead_hourly', params={'node': ...})",
            },
            "fuel_mix": {
                "name": "CAISO Today's Outlook fuel source history (5-minute MW by fuel)",
                "url": FUEL_URL,
                "gridstatus_call": "CAISO().get_fuel_mix(date)",
            },
        },
        "method": {
            "hourly_aggregation": "mean of the 5-minute intervals starting in each PST hour",
            "negatives": "clipped to 0 and excluded from the denominator (battery charging, solar night parasitics, net exports)",
            "denominator": "all positive supply including Imports and Batteries",
            "grid_co2": "sum(MW_fuel x EF_fuel) / sum(positive supply)",
            "grid_cfe_share": "(Solar + Wind + Geothermal + Nuclear + Large Hydro + Small Hydro) / sum(positive supply)",
            "gap_fill": (
                f"gaps <= {MAX_INTERP_HOURS} h: linear interpolation; gaps <= {MAX_GAP_HOURS} h: mean of "
                "the same PST hour on the nearest days with observed data (keeps the diurnal shape); "
                f"fail if a gap is longer or > {MAX_MISSING_FRACTION:.0%} of a column is missing. Fuel-mix "
                "gaps are hours missing from CAISO's published day files (e.g. 2024-01-11 ends at "
                "14:30 PST; the DST fall-back file has only one 01:xx block), not fetch failures."
            ),
        },
        "emission_factors_kg_per_mwh": EMISSION_FACTORS_KG_PER_MWH,
        "emission_factor_sources": EMISSION_FACTOR_SOURCES,
        "clean_fuels": list(CLEAN_FUELS),
        "filled_hours": {c: sum(v.values()) for c, v in filled.items()},
        "filled_hours_by_method": filled,
        "gaps": gaps,
        "fuel_mix_intervals_per_hour": {
            "min": int(counts.min()),
            "hours_with_12": int((counts == 12).sum()),
            "hours_with_fewer": int(((counts > 0) & (counts < 12)).sum()),
            "hours_with_none": int((counts == 0).sum()),
        },
        "annual_stats": {
            "lmp": lmp_stats,
            "grid_co2_kg_per_mwh": {
                "mean": _r(out["grid_co2_kg_per_mwh"].mean(), 1),
                "min": _r(out["grid_co2_kg_per_mwh"].min(), 1),
                "max": _r(out["grid_co2_kg_per_mwh"].max(), 1),
            },
            "grid_cfe_share": {
                "mean": _r(out["grid_cfe_share"].mean(), 4),
                "min": _r(out["grid_cfe_share"].min(), 4),
                "max": _r(out["grid_cfe_share"].max(), 4),
            },
            "mean_supply_share_by_fuel": (mean_mw / mean_mw.sum()).round(4).to_dict(),
            "co2_by_hour_of_day": out.groupby(hod)["grid_co2_kg_per_mwh"].mean().round(1).tolist(),
            "cfe_by_hour_of_day": out.groupby(hod)["grid_cfe_share"].mean().round(4).tolist(),
            "lmp_pgae_by_hour_of_day": out.groupby(hod)["lmp_dlap_pgae"].mean().round(2).tolist(),
            "monthly_mean": {
                "lmp_dlap_pgae": out.groupby(month.dt.month)["lmp_dlap_pgae"].mean().round(2).tolist(),
                "grid_co2_kg_per_mwh": out.groupby(month.dt.month)["grid_co2_kg_per_mwh"].mean().round(1).tolist(),
                "grid_cfe_share": out.groupby(month.dt.month)["grid_cfe_share"].mean().round(4).tolist(),
            },
        },
    }


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    logging.getLogger("gridstatus").setLevel(logging.WARNING)
    t0 = time.time()
    out, meta = build()
    out.to_csv(OUT_CSV, index=False)
    OUT_META.write_text(json.dumps(meta, indent=2) + "\n")
    s = meta["annual_stats"]
    log.info(
        "wrote %s (%.2f MB) in %.0fs: PG&E DLAP mean $%.2f/MWh, CO2 mean %.1f kg/MWh, CFE mean %.3f",
        OUT_CSV,
        OUT_CSV.stat().st_size / 1e6,
        time.time() - t0,
        s["lmp"]["lmp_dlap_pgae"]["mean"],
        s["grid_co2_kg_per_mwh"]["mean"],
        s["grid_cfe_share"]["mean"],
    )


if __name__ == "__main__":
    main()
