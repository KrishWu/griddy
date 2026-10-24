"""Cached loaders for data/household/** and the CAISO 2024 hourly file.  OWNER: household (backend).

Every loader degrades gracefully: a missing or unparsable file returns None (or an empty structure) and the
caller adds an explicit warning; nothing is silently replaced by a placeholder.
"""

from __future__ import annotations

import json
import logging
import math
import re
from dataclasses import dataclass
from functools import lru_cache
from typing import Any

import numpy as np

from app import DATA_DIR

log = logging.getLogger(__name__)

HH = DATA_DIR / "household"
CAISO_CSV = DATA_DIR / "simulate" / "caiso_2024_hourly.csv"
HOURS = 8784  # 2024 is a leap year
DAYS = 366


# ---------------------------------------------------------------------------
# 2024 calendar (hour-beginning, fixed UTC-8)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Calendar:
    month_h: np.ndarray  # 0..11 per hour
    weekend_h: np.ndarray  # 0 weekday, 1 weekend (Sat/Sun; holidays ignored)
    hod: np.ndarray  # 0..23
    day_h: np.ndarray  # 0..365
    month_d: np.ndarray  # per day
    weekend_d: np.ndarray  # per day
    days_in_month: np.ndarray  # 12
    tmy_day: np.ndarray  # per 2024 day -> 365-day TMY day (Feb 29 reuses Feb 28)
    dst_h: np.ndarray  # 1 on days when Pacific clocks show PDT (whole-day approximation: 2024-03-10 .. 2024-11-02)
    local_hod: np.ndarray  # local clock hour shown to the user = (PST hour + DST) % 24


@lru_cache(maxsize=1)
def calendar() -> Calendar:
    dates = np.datetime64("2024-01-01") + np.arange(DAYS)
    month_d = (dates.astype("datetime64[M]").astype(int) % 12).astype(np.int64)
    dow = (dates.astype("datetime64[D]").astype(np.int64) + 3) % 7  # 1970-01-01 was a Thursday; Monday = 0
    weekend_d = (dow >= 5).astype(np.int64)
    days = np.arange(DAYS)
    tmy_day = np.where(days < 59, days, np.maximum(days - 1, 0))  # day 59 = Feb 29 -> Feb 28 (day 58)
    # DST is applied per whole day so a local-clock daily pattern maps to each PST day as a permutation (daily
    # totals preserved exactly); the two transition days are off by an hour or two.
    dst_d = ((days >= 69) & (days <= 306)).astype(np.int64)  # 2024-03-10 .. 2024-11-02
    dst_h = np.repeat(dst_d, 24)
    hod = np.tile(np.arange(24), DAYS)
    return Calendar(
        month_h=np.repeat(month_d, 24),
        weekend_h=np.repeat(weekend_d, 24),
        hod=hod,
        day_h=np.repeat(days, 24),
        month_d=month_d,
        weekend_d=weekend_d,
        days_in_month=np.bincount(month_d, minlength=12).astype(float),
        tmy_day=tmy_day,
        dst_h=dst_h,
        local_hod=(hod + dst_h) % 24,
    )


# ---------------------------------------------------------------------------
# Generic JSON
# ---------------------------------------------------------------------------


@lru_cache(maxsize=None)
def load_json(name: str) -> Any | None:
    path = HH / name
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        log.warning("household data missing: %s", path)
        return None
    except (OSError, ValueError):
        log.exception("household data unreadable: %s", path)
        return None


def meta(doc: Any) -> dict:
    return doc.get("_meta", {}) if isinstance(doc, dict) else {}


def num(x: Any, default: float | None = None) -> float | None:
    """A finite float from a number / {"value": n} / numeric string, else default."""
    if isinstance(x, dict):
        for k in ("value", "usd_per_kwh", "rate", "v"):
            if k in x:
                return num(x[k], default)
        return default
    if isinstance(x, bool):
        return default
    try:
        v = float(x)
    except (TypeError, ValueError):
        return default
    return v if math.isfinite(v) else default


def norm_key(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", str(s).lower()).strip("_")


# ---------------------------------------------------------------------------
# CAISO 2024 hourly (workstream B's file, read only)
# ---------------------------------------------------------------------------

FUEL_COLS = (
    "solar_mw", "wind_mw", "geothermal_mw", "biomass_mw", "biogas_mw", "small_hydro_mw", "large_hydro_mw",
    "nuclear_mw", "natural_gas_mw", "coal_mw", "batteries_mw", "imports_mw", "other_mw",
)


@lru_cache(maxsize=1)
def caiso() -> dict[str, np.ndarray] | None:
    try:
        import pandas as pd

        df = pd.read_csv(CAISO_CSV)
        if len(df) != HOURS:
            log.warning("caiso_2024_hourly.csv has %d rows, expected %d", len(df), HOURS)
            return None
        out = {"grid_co2_kg_per_mwh": df["grid_co2_kg_per_mwh"].to_numpy(float), "grid_cfe_share": df["grid_cfe_share"].to_numpy(float)}
        for c in FUEL_COLS:
            if c in df.columns:
                out[c] = df[c].to_numpy(float)
        for k, v in out.items():
            if not np.all(np.isfinite(v)):
                out[k] = np.nan_to_num(v, nan=float(np.nanmean(v)))
        return out
    except (OSError, KeyError, ValueError):
        log.exception("caiso_2024_hourly.csv unreadable")
        return None


# ---------------------------------------------------------------------------
# PVWatts (hourly AC kWh per kW_DC, 8760 TMY) and ZIP centroids
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class PVProfile:
    slug: str
    city: str
    lat: float
    lon: float
    hourly_8784: np.ndarray  # kWh AC per kW_DC on the 2024 calendar
    source: str
    url: str | None
    note: str | None


@lru_cache(maxsize=1)
def pv_profiles() -> dict[str, PVProfile]:
    out: dict[str, PVProfile] = {}
    folder = HH / "pvwatts"
    if not folder.is_dir():
        return out
    cal = calendar()
    for path in sorted(folder.glob("*.json")):
        try:
            d = json.loads(path.read_text(encoding="utf-8"))
            arr = None
            for k in ("hourly_ac_kwh_per_kw", "ac_kwh_per_kw", "hourly_kwh_per_kw", "ac"):
                if isinstance(d.get(k), list):
                    arr = np.asarray(d[k], dtype=float)
                    if k == "ac" and arr.max() > 5:  # Wac per kW -> kWh
                        arr = arr / 1000.0
                    break
            if arr is None or arr.size != 8760 or not np.all(np.isfinite(arr)):
                log.warning("pvwatts file %s has no 8760-hour array", path.name)
                continue
            arr = np.clip(arr, 0, None).reshape(365, 24)
            hourly = arr[cal.tmy_day].reshape(-1)
            m = meta(d)
            slug = d.get("slug") or path.stem
            out[slug] = PVProfile(
                slug=slug,
                city=d.get("city") or slug.replace("_", " ").title(),
                lat=float(d.get("lat", 0.0)),
                lon=float(d.get("lon", 0.0)),
                hourly_8784=hourly,
                source=m.get("source", "NREL PVWatts v8"),
                url=m.get("url"),
                note=m.get("description"),
            )
        except (OSError, ValueError, TypeError):
            log.exception("pvwatts file %s unreadable", path.name)
    return out


@lru_cache(maxsize=1)
def zip_centroids() -> dict[str, tuple[float, float]]:
    d = load_json("ca_zip_centroids.json")
    out: dict[str, tuple[float, float]] = {}
    if not isinstance(d, dict):
        return out
    for k, v in d.items():
        if k.startswith("_"):
            continue
        try:
            if isinstance(v, dict):
                out[k] = (float(v["lat"]), float(v["lon"]))
            else:
                out[k] = (float(v[0]), float(v[1]))
        except (KeyError, TypeError, ValueError, IndexError):
            continue
    return out


def zip_meta() -> dict:
    return meta(load_json("ca_zip_centroids.json"))


# ---------------------------------------------------------------------------
# Assumptions: data/household/assumptions.json first, then a stated built-in default (with a warning)
# ---------------------------------------------------------------------------

# key -> (value, label, unit/format, source, url). Used only when assumptions.json lacks the key; the result
# then lists the key in `warnings` so the fallback is never silent.
DEFAULTS: dict[str, tuple[Any, str, str, str, str | None]] = {
    "ev_kwh_per_mile": (0.30, "EV energy use incl. charging losses", "kWh/mile",
                        "US DOE/EPA fueleconomy.gov typical EV efficiency", "https://www.fueleconomy.gov/feg/evsbs.shtml"),
    "ev_default_miles_per_day": (30.0, "EV miles per day (not given)", "miles/day", "Assumption (~US average daily driving)", None),
    "l2_charger_kw": (7.2, "Level 2 home charger power", "kW", "Typical 240 V Level 2 charger (US DOE AFDC)",
                      "https://afdc.energy.gov/fuels/electricity-charging-home"),
    "washer_kwh_per_load": (0.3, "Clothes washer energy per load", "kWh/load", "ENERGY STAR clothes washers", None),
    "dryer_kwh_per_load": (2.5, "Electric dryer energy per load", "kWh/load", "ENERGY STAR clothes dryers", None),
    "washer_loads_per_week_by_occupants": ({"1": 2.3, "2": 3.3, "3": 4.1, "4": 4.6, "5": 5.2}, "Washer loads per week", "loads/week",
                                           "Assumption", None),
    "dryer_loads_per_week_by_occupants": ({"1": 2.2, "2": 3.3, "3": 4.2, "4": 4.6, "5": 5.2}, "Dryer loads per week", "loads/week",
                                          "Assumption", None),
    "dishwasher_kwh_per_cycle": (1.0, "Dishwasher energy per cycle", "kWh/cycle", "ENERGY STAR dishwashers", None),
    "dishwasher_cycles_per_week_by_occupants": ({"1": 1.5, "2": 2.6, "3": 3.2, "4": 3.2, "5": 3.0}, "Dishwasher cycles per week",
                                                "cycles/week", "Assumption", None),
    "cooling_monthly_kwh_by_climate": ({"coastal": [0, 0, 0, 0, 26, 161, 333, 191, 130, 82, 0, 0],
                                        "inland": [0, 0, 0, 0, 50, 309, 641, 367, 250, 158, 0, 0]},
                                       "Central AC electricity by month", "kWh/month", "Assumption (EIA RECS 2020 scale)", None),
    "cooling_pct_change_per_degF": (3.0, "AC energy change per 1 F of setpoint", "%/F", "Assumption (utility rules of thumb)", None),
    "ac_recommended_setpoint_f": (78.0, "Reference cooling setpoint", "F", "ENERGY STAR guidance", None),
    "electric_heating_annual_kwh_by_climate": ({"coastal": 1000, "inland": 800}, "Electric space heating per year", "kWh/yr",
                                               "Assumption (EIA RECS 2020 scale)", None),
    "heating_monthly_share": ([0.28, 0.18, 0.08, 0, 0, 0, 0, 0, 0, 0, 0.16, 0.30], "Heating by month (share)", "fraction",
                              "Assumption", None),
    "ca_avg_annual_kwh": (6_300.0, "California average household electricity use", "kWh/yr",
                          "EIA Form 861 California residential sales / customers", "https://www.eia.gov/electricity/sales_revenue_price/"),
    "ca_avg_annual_kwh_by_occupants": ({"1": 4000, "2": 6700, "3": 7300, "4": 7650, "5": 8300}, "CA household use by size",
                                       "kWh/yr", "Assumption (EIA RECS 2020 scale)", None),
    "default_occupants": (3, "Household size when not given", "people", "Assumption (~California average household size 2.8)", None),
    "ca_avg_rate_usd_per_kwh": (0.3197, "California average residential price, 2024 (used when no rate is entered)", "$/kWh",
                                "EIA State Electricity Profile, California, Table 8 (Form EIA-861): 31.97 cents/kWh in 2024",
                                "https://www.eia.gov/electricity/state/xls/SEP%20Tables%20for%20CA.xlsx"),
    "rate_escalation_pct_per_yr": (5.0, "Electricity price escalation", "%/yr",
                            "Assumption from EIA California residential average price growth", "https://www.eia.gov/electricity/data/browser/"),
    "discount_rate_pct": (5.0, "Discount rate for NPV", "%/yr", "Assumption (household cost of capital)", None),
    "pv_degradation_pct_per_yr": (0.5, "Solar output degradation", "%/yr", "NREL (Jordan & Kurtz) median PV degradation",
                           "https://www.nrel.gov/docs/fy12osti/51664.pdf"),
    "pv_installed_usd_per_w": (3.3, "Installed residential solar cost", "$/W_DC", "LBNL Tracking the Sun (CA residential, recent)",
                          "https://emp.lbl.gov/tracking-the-sun"),
    "battery_installed_usd_per_kwh": (1_100.0, "Installed home battery cost", "$/kWh", "Assumption (~$15k for 13.5 kWh installed)", None),
    "battery_round_trip_efficiency": (0.90, "Battery round-trip efficiency", "fraction", "Typical lithium-ion home battery spec sheets", None),
    "battery_kw_per_kwh": (0.4, "Battery power per kWh of capacity", "kW/kWh",
                           "NREL ATB 2025 representative residential battery (5 kW / 12.5 kWh)", "https://atb.nlr.gov/electricity/2025/residential_battery_storage"),
    "battery_life_years": (15, "Battery life before replacement", "years", "Assumption (10-yr warranties, ~15-yr life)", None),
    "pv_system_life_years": (25, "Solar NPV horizon", "years", "Assumption (typical panel warranty)", None),
    "federal_residential_clean_energy_credit_pct": (0.0, "Federal residential clean energy credit (25D) for 2026 installs", "%",
                        "Public Law 119-21 (2025) ended 25D for expenditures after 2025-12-31",
                        "https://www.irs.gov/credits-deductions/residential-clean-energy-credit"),
    "epa_kg_co2e_per_car_mile": (0.393, "CO2 per average passenger-car mile", "kg/mile", "US EPA Greenhouse Gas Equivalencies Calculator",
                                 "https://www.epa.gov/energy/greenhouse-gas-equivalencies-calculator"),
    "epa_kg_co2_per_tree_seedling_10yr": (60.0, "CO2 sequestered by one tree seedling grown for 10 years", "kg",
                                          "US EPA Greenhouse Gas Equivalencies Calculator",
                                          "https://www.epa.gov/energy/greenhouse-gas-equivalencies-calculator"),
    "nbt_flat_export_usd_per_kwh": (0.05, "Flat export credit when hourly NBT export rates are not loaded", "$/kWh",
                                    "Assumption (~average of PG&E NBT ACC export values)", None),
    "existing_solar_kw_default": (6.0, "Existing solar size when not given", "kW_DC", "Assumption (typical CA home system)", None),
    "existing_battery_kwh_default": (13.5, "Existing battery size when not given", "kWh", "Assumption (one common home battery)", None),
}


ASSUMPTION_FILES = ("assumptions.json", "costs_incentives.json")


def lookup_assumption(key: str) -> tuple[Any, str | None, str | None, str | None, str | None, str | None] | None:
    """(value, label, source, url, note, kind) from assumptions.json / costs_incentives.json (top level or one level down)."""
    for name in ASSUMPTION_FILES:
        doc = load_json(name)
        if not isinstance(doc, dict):
            continue
        cands: list[Any] = []
        if key in doc:
            cands.append(doc[key])
        for k, v in doc.items():
            if isinstance(v, dict) and key in v and not k.startswith("_"):
                cands.append(v[key])
        for c in cands:
            if isinstance(c, dict) and "value" in c:
                return c["value"], c.get("label"), c.get("source"), c.get("url"), c.get("note"), c.get("kind")
            if isinstance(c, (int, float, list)) and not isinstance(c, bool):
                return c, None, meta(doc).get("source"), meta(doc).get("url"), None, None
    return None


class Ctx:
    """Per-request collector of warnings and the assumptions actually used (shown in the result)."""

    def __init__(self) -> None:
        self.warnings: list[str] = []
        self.used: dict[str, dict[str, Any]] = {}
        self.defaulted: list[str] = []

    def warn(self, msg: str) -> None:
        if msg not in self.warnings:
            self.warnings.append(msg)

    def a(self, key: str) -> Any:
        """The value of assumption `key`: assumptions.json if it has it, else the stated built-in default."""
        if key in self.used:
            return self.used[key]["value"]
        default = DEFAULTS.get(key)
        found = lookup_assumption(key)
        if found is not None:
            value, label, source, url, note, kind = found
            unit = default[2] if default else ""
            rec = {"value": value, "label": label or (default[1] if default else key), "unit": unit,
                   "kind": kind if kind in ("observed", "assumption", "simulated", "inferred") else "assumption",
                   "source": source or "data/household/assumptions.json", "url": url, "note": note}
        elif default is not None:
            value, label, unit, source, url = default
            rec = {"value": value, "label": label, "unit": unit, "kind": "assumption", "source": source, "url": url,
                   "note": "built-in default (not in data/household/assumptions.json)"}
            self.defaulted.append(key)
        else:
            raise KeyError(key)
        self.used[key] = rec
        return rec["value"]

    def record(self, key: str, value: Any, label: str, source: str, kind: str = "assumption", url: str | None = None,
               note: str | None = None, unit: str = "") -> None:
        self.used[key] = {"value": value, "label": label, "unit": unit, "kind": kind, "source": source, "url": url, "note": note}

    def by_occ(self, key: str, occ: float) -> float:
        """An occupant-keyed assumption ('1'..'5', '5' = 5+), linearly interpolated for fractional sizes."""
        v = self.a(key)
        if not isinstance(v, dict):
            return float(num(v, 0.0) or 0.0)
        pts = sorted((int(k), float(num(x, 0.0) or 0.0)) for k, x in v.items() if str(k).isdigit())
        o = min(max(float(occ), pts[0][0]), pts[-1][0])
        xs, ys = [p[0] for p in pts], [p[1] for p in pts]
        return float(np.interp(o, xs, ys))


# CEC climate zones of the PVWatts cities -> Building America climate (RECS): Marine = coastal, Hot-Dry = inland.
CITY_CLIMATE = {"san_francisco": "coastal", "oakland": "coastal", "san_jose": "coastal", "san_diego": "coastal",
                "los_angeles": "inland", "sacramento": "inland", "fresno": "inland", "bakersfield": "inland"}
