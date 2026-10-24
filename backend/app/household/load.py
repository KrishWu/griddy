"""Household hourly load model (2024 calendar, 8784 h) and Green Button CSV parsing.  OWNER: household (backend).

Internal arrays are indexed by PST hour of year (fixed UTC-8, aligned with CAISO and PVWatts). Anything the
user types or reads as an hour (EV start, laundry time, TOU periods, Green Button timestamps) is local clock time;
`calendar().local_hod` maps between the two per whole day, so a daily pattern lands on each day as a permutation.

Load = base + ev + laundry + dishwasher + cooling + heating (kWh per hour).
"""

from __future__ import annotations

import csv
import io
import math
import re
from dataclasses import dataclass, field
from datetime import date, datetime

import numpy as np

from app.household.data import CITY_CLIMATE, DAYS, HOURS, Ctx, calendar, load_json, meta
from app.household.models import HouseholdRequest

COMPONENTS = ("base", "ev", "laundry", "dishwasher", "cooling", "heating")
FLEX = ("ev", "laundry", "dishwasher", "cooling", "heating")

# Fixed diurnal shapes (local clock), each sums to 1. Stated assumptions (no hourly temperature model).
_COOL = np.array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 4, 6, 8, 10, 11, 11, 10, 8, 6, 4, 2, 1], float)
COOLING_SHAPE = _COOL / _COOL.sum()
_HEAT = np.array([2, 2, 2, 2, 3, 5, 8, 9, 7, 4, 2, 1, 1, 1, 1, 2, 4, 7, 8, 8, 7, 5, 4, 3], float)
HEATING_SHAPE = _HEAT / _HEAT.sum()



@dataclass
class LoadModel:
    components: dict[str, np.ndarray]
    source: str
    label: str
    ev_start: int | None = None
    laundry_hour: int = 19
    dishwasher_hour: int = 20
    notes: list[str] = field(default_factory=list)

    def total(self) -> np.ndarray:
        return np.sum([v for v in self.components.values()], axis=0)

    def copy(self) -> "LoadModel":
        return LoadModel({k: v.copy() for k, v in self.components.items()}, self.source, self.label, self.ev_start,
                         self.laundry_hour, self.dishwasher_hour, list(self.notes))


# ---------------------------------------------------------------------------
# Daily patterns (local clock) -> 8784 PST hourly
# ---------------------------------------------------------------------------


def daily_to_hourly(pattern24: np.ndarray, per_day_scale: np.ndarray | None = None) -> np.ndarray:
    """Repeat a 24-value local-clock pattern on every 2024 day (optionally x a per-day factor)."""
    cal = calendar()
    out = np.asarray(pattern24, float)[cal.local_hod]
    if per_day_scale is not None:
        out = out * np.asarray(per_day_scale, float)[cal.day_h]
    return out


def ev_block(kwh_per_day: float, charger_kw: float, start_hour: int) -> np.ndarray:
    """24-h local-clock EV charging pattern: full power from start_hour for ceil(kWh/kW) hours, last hour fractional.
    Wraps past midnight within the same day (daily energy preserved)."""
    p = np.zeros(24)
    left = max(0.0, float(kwh_per_day))
    kw = max(0.1, float(charger_kw))
    h = int(start_hour) % 24
    for _ in range(24):
        if left <= 1e-12:
            break
        e = min(kw, left)
        p[h] += e
        left -= e
        h = (h + 1) % 24
    if left > 1e-9:  # more than 24 h of charging at this power: spread the rest evenly (still conserves energy)
        p += left / 24.0
    return p


def appliance_block(kwh_per_day: float, hour: int, split: tuple[float, ...]) -> np.ndarray:
    p = np.zeros(24)
    for i, s in enumerate(split):
        p[(int(hour) + i) % 24] += kwh_per_day * s
    return p


def shift(arr: np.ndarray, hours: int) -> np.ndarray:
    """Move a component later by `hours` within each day (a pure timing shift: a per-day permutation)."""
    if hours % 24 == 0:
        return arr.copy()
    return np.roll(arr.reshape(DAYS, 24), int(hours), axis=1).reshape(-1)


def matrix_to_hourly(matrix: np.ndarray) -> np.ndarray:
    """12 x 2 x 24 (month, [weekday, weekend], local hour) average kWh -> 8784 PST hourly kWh."""
    cal = calendar()
    return np.asarray(matrix, float)[cal.month_h, cal.weekend_h, cal.local_hod]


def avg_day(arr: np.ndarray, mask: np.ndarray | None = None) -> list[float]:
    """Average-day profile by LOCAL clock hour (what the user reads on a chart)."""
    cal = calendar()
    m = np.ones(HOURS, bool) if mask is None else mask
    sums = np.bincount(cal.local_hod[m], weights=arr[m], minlength=24)
    counts = np.bincount(cal.local_hod[m], minlength=24)
    return [float(x) for x in sums / np.maximum(counts, 1)]


def monthly(arr: np.ndarray) -> np.ndarray:
    return np.bincount(calendar().month_h, weights=arr, minlength=12)


# ---------------------------------------------------------------------------
# Base shape (PG&E E1 residential class profile)
# ---------------------------------------------------------------------------

_FALLBACK_DAY = np.array([0.55, 0.5, 0.47, 0.45, 0.45, 0.5, 0.62, 0.72, 0.7, 0.65, 0.62, 0.62, 0.62, 0.62, 0.65, 0.72,
                          0.85, 1.0, 1.12, 1.15, 1.1, 0.98, 0.82, 0.66])


def base_shape_hourly(ctx: Ctx) -> tuple[np.ndarray, str]:
    """Average E1 customer kWh per PST hour on 2024 (unscaled), plus a source label."""
    cal = calendar()
    d = load_json("load_shapes.json")
    try:
        avg = np.asarray(d["avg_kw"], float)
        if avg.shape != (12, 2, 24) or not np.all(np.isfinite(avg)) or avg.min() < 0:
            raise ValueError(avg.shape)
        src = meta(d).get("source", "PG&E residential class load profile (E1)")
        return avg[cal.month_h, cal.weekend_h, cal.hod], src
    except (TypeError, KeyError, ValueError):
        ctx.warn("Residential load shape (data/household/load_shapes.json) not loaded: using a generic built-in "
                 "evening-peaking daily shape with no seasonal variation.")
        return _FALLBACK_DAY[cal.hod] * 0.7, "built-in generic residential shape (fallback)"


def load_shape_meta() -> dict:
    return meta(load_json("load_shapes.json"))


# ---------------------------------------------------------------------------
# Flexible end uses
# ---------------------------------------------------------------------------


def _occupants(req: HouseholdRequest, ctx: Ctx) -> float:
    if req.occupants:
        return float(req.occupants)
    return float(ctx.a("default_occupants"))


def _monthly_list(v, name: str, ctx: Ctx) -> np.ndarray:
    try:
        a = np.asarray(v, float).reshape(-1)
        if a.size == 12 and np.all(np.isfinite(a)) and a.min() >= 0:
            return a
    except (TypeError, ValueError):
        pass
    ctx.warn(f"Assumption {name} is not 12 monthly values; ignoring it.")
    return np.zeros(12)


def flex_components(req: HouseholdRequest, ctx: Ctx, city_slug: str) -> tuple[dict[str, np.ndarray], dict]:
    cal = calendar()
    occ = _occupants(req, ctx)
    climate = CITY_CLIMATE.get(city_slug, "coastal")
    out: dict[str, np.ndarray] = {}
    info: dict = {"climate": climate}

    ev = req.ev
    if ev and ev.has_ev:
        miles = ev.miles_per_day if ev.miles_per_day is not None else float(ctx.a("ev_default_miles_per_day"))
        kwh_day = miles * float(ctx.a("ev_kwh_per_mile"))
        start = ev.charge_start_hour if ev.charge_start_hour is not None else 18
        out["ev"] = daily_to_hourly(ev_block(kwh_day, float(ctx.a("l2_charger_kw")), start))
        info["ev_start"] = start
        info["ev_kwh_per_day"] = kwh_day

    # Laundry: washer + (assumed electric) dryer, run back to back starting at laundry_hour.
    lh = req.laundry_hour if req.laundry_hour is not None else 19
    wash = ctx.by_occ("washer_loads_per_week_by_occupants", occ) * float(ctx.a("washer_kwh_per_load"))
    dry = ctx.by_occ("dryer_loads_per_week_by_occupants", occ) * float(ctx.a("dryer_kwh_per_load"))
    p = appliance_block(wash / 7.0, lh, (1.0,)) + appliance_block(dry / 7.0, lh + 1, (1.0,))
    out["laundry"] = daily_to_hourly(p)
    info["laundry_hour"] = lh
    ctx.record("dryer_fuel", "electric", "Clothes dryer fuel", "Assumption (many CA homes use gas dryers; then laundry kWh is lower)")

    dh = req.dishwasher_hour if req.dishwasher_hour is not None else 20
    dish = ctx.by_occ("dishwasher_cycles_per_week_by_occupants", occ) * float(ctx.a("dishwasher_kwh_per_cycle"))
    out["dishwasher"] = daily_to_hourly(appliance_block(dish / 7.0, dh, (0.6, 0.4)))
    info["dishwasher_hour"] = dh

    if req.cooling and req.cooling.has_ac:
        by_cl = ctx.a("cooling_monthly_kwh_by_climate")
        mk = _monthly_list(by_cl.get(climate) if isinstance(by_cl, dict) else by_cl, "cooling_monthly_kwh_by_climate", ctx)
        factor = 1.0
        ref = float(ctx.a("ac_recommended_setpoint_f"))
        if req.cooling.setpoint_f is not None:
            pct = float(ctx.a("cooling_pct_change_per_degF")) / 100.0
            factor = float(np.clip(1 - pct * (req.cooling.setpoint_f - ref), 0.2, 2.5))
        per_day = (mk / cal.days_in_month)[cal.month_d] * factor
        out["cooling"] = daily_to_hourly(COOLING_SHAPE, per_day)
        ctx.record("climate", climate, f"Climate for cooling/heating ({city_slug.replace('_', ' ').title()})",
                   "Building America climate of the nearest solar-profile city (Marine = coastal, Hot-Dry = inland)")

    if req.electric_heating:
        by_cl = ctx.a("electric_heating_annual_kwh_by_climate")
        annual = float((by_cl.get(climate) if isinstance(by_cl, dict) else by_cl) or 0.0)
        share = _monthly_list(ctx.a("heating_monthly_share"), "heating_monthly_share", ctx)
        share = share / share.sum() if share.sum() > 0 else share
        per_day = (annual * share / cal.days_in_month)[cal.month_d]
        out["heating"] = daily_to_hourly(HEATING_SHAPE, per_day)
    return out, info


# ---------------------------------------------------------------------------
# Build the household load
# ---------------------------------------------------------------------------


def validate_matrix(m) -> np.ndarray | None:
    try:
        a = np.asarray(m, float)
    except (TypeError, ValueError):
        return None
    if a.shape != (12, 2, 24) or not np.all(np.isfinite(a)) or a.min() < 0:
        return None
    return a


def _fit_flex_to_total(flex: dict[str, np.ndarray], total: np.ndarray, ctx: Ctx) -> np.ndarray:
    """base = total - sum(flex); where flex exceeds the measured total, scale flex down in that hour."""
    fsum = np.sum(list(flex.values()), axis=0) if flex else np.zeros(HOURS)
    over = fsum > total
    if np.any(over):
        scale = np.ones(HOURS)
        scale[over] = total[over] / np.maximum(fsum[over], 1e-12)
        removed = float(np.sum(fsum[over] - total[over]))
        for k in flex:
            flex[k] = flex[k] * scale
        if removed > 0.02 * max(float(fsum.sum()), 1e-9):
            ctx.warn(f"Your meter data has less energy than the modeled end uses in some hours; scaled those end uses "
                     f"down ({removed:,.0f} kWh/yr) so they fit inside the measured total.")
    fsum = np.sum(list(flex.values()), axis=0) if flex else np.zeros(HOURS)
    return np.clip(total - fsum, 0, None)


def _scale_to_months(base_shape: np.ndarray, flex: dict[str, np.ndarray], targets: np.ndarray, ctx: Ctx) -> np.ndarray:
    """Scale the base so each month's total (base + flex) equals targets[m]."""
    cal = calendar()
    bm = monthly(base_shape)
    fm = monthly(np.sum(list(flex.values()), axis=0)) if flex else np.zeros(12)
    k = np.zeros(12)
    squeezed = []
    for m in range(12):
        room = targets[m] - fm[m]
        if room < 0.1 * targets[m]:
            # End uses alone exceed ~90% of the month's kWh: shrink them so the base keeps 10%.
            f = 0.9 * targets[m] / fm[m] if fm[m] > 0 else 1.0
            mask = cal.month_h == m
            for key in flex:
                flex[key][mask] *= f
            room = 0.1 * targets[m]
            squeezed.append(m)
        k[m] = room / bm[m] if bm[m] > 0 else 0.0
    if squeezed:
        names = ", ".join(["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m] for m in squeezed)
        ctx.warn(f"Your EV/appliance answers use more energy than the monthly kWh you gave in {names}; scaled those end "
                 "uses down to fit.")
    return base_shape * k[cal.month_h]


def build_load(req: HouseholdRequest, ctx: Ctx, city_slug: str) -> LoadModel:
    flex, info = flex_components(req, ctx, city_slug)
    base_shape, base_src = base_shape_hourly(ctx)
    lm_kwargs = {"ev_start": info.get("ev_start"), "laundry_hour": info["laundry_hour"], "dishwasher_hour": info["dishwasher_hour"]}

    if req.interval_matrix_kwh is not None:
        mat = validate_matrix(req.interval_matrix_kwh)
        if mat is not None and mat.sum() > 0:
            total = matrix_to_hourly(mat)
            base = _fit_flex_to_total(flex, total, ctx)
            comps = {"base": base, **flex}
            return LoadModel(comps, "interval_data", "From your meter data, averaged by month/day-type/hour", **lm_kwargs)
        ctx.warn("interval_matrix_kwh must be 12 x 2 x 24 finite, non-negative kWh with some usage; ignored it and "
                 "fell back to monthly kWh / the California benchmark.")

    targets = None
    if req.monthly_kwh is not None:
        vals = [req.monthly_kwh] if isinstance(req.monthly_kwh, (int, float)) else list(req.monthly_kwh)
        vals = [float(v) for v in vals if v is not None and math.isfinite(float(v)) and float(v) >= 0]
        if len(vals) == 12 and sum(vals) > 0:
            targets = np.asarray(vals)
            label = "Simulated hourly load: PG&E residential class shape scaled to your 12 monthly kWh values, plus modeled end uses"
        elif vals and sum(vals) > 0:
            if len(vals) != 1:
                ctx.warn(f"monthly_kwh had {len(vals)} values (expected 1 or 12); used their average as a typical month.")
            typical = float(np.mean(vals))
            annual = 12.0 * typical
            bm = monthly(base_shape)
            fm = monthly(np.sum(list(flex.values()), axis=0))
            # Keep the end uses as modeled; the base keeps the class profile's seasonality.
            k = max(annual - fm.sum(), 0.1 * annual) / max(bm.sum(), 1e-9)
            targets = fm + k * bm
            targets *= annual / targets.sum()
            label = (f"Simulated hourly load: {typical:,.0f} kWh in a typical month (x12 = {annual:,.0f} kWh/yr), spread "
                     "over the year with the PG&E residential class seasonal shape, plus modeled end uses")
        else:
            ctx.warn("monthly_kwh had no usable positive values; used the California benchmark instead.")
    if targets is not None:
        base = _scale_to_months(base_shape, flex, targets, ctx)
        return LoadModel({"base": base, **flex}, "simulated_from_monthly", label, **lm_kwargs)

    occ = _occupants(req, ctx)
    annual = ctx.by_occ("ca_avg_annual_kwh_by_occupants", occ)
    ca = annual
    bm = monthly(base_shape)
    fm = monthly(np.sum(list(flex.values()), axis=0))
    # The benchmark already includes typical appliance and AC use; EV and electric heat are added on top of it.
    extra = sum(float(flex[k].sum()) for k in ("ev", "heating") if k in flex)
    annual_total = annual + extra
    if info["climate"] == "inland" and req.cooling and req.cooling.has_ac:
        cooling = ctx.a("cooling_monthly_kwh_by_climate")
        if isinstance(cooling, dict):
            coastal = float(np.sum(cooling.get("coastal", [0])))
            inland = float(np.sum(cooling.get("inland", [0])))
            delta = max(0, inland - coastal)
            annual_total += delta
            ctx.record("climate_benchmark_adjustment_kwh", delta, "Inland AC adjustment to benchmark use",
                       "Illustrative inland minus coastal annual cooling allowance; applied only without entered monthly or meter data",
                       unit="kWh/year", kind="assumption")
    k = max(annual_total - fm.sum(), 0.1 * annual_total) / max(bm.sum(), 1e-9)
    targets = fm + k * bm
    base = _scale_to_months(base_shape, flex, targets, ctx)
    label = (f"Simulated hourly load: California benchmark for a {occ:g}-person household ({ca:,.0f} kWh/yr, EIA RECS), "
             "PG&E residential class shape, plus modeled end uses")
    return LoadModel({"base": base, **flex}, "simulated_from_benchmark", label, **lm_kwargs)


# ---------------------------------------------------------------------------
# Green Button CSV parsing
# ---------------------------------------------------------------------------

_DATE_FMTS = ("%Y-%m-%d", "%m/%d/%Y", "%m/%d/%y", "%Y/%m/%d", "%d-%b-%Y", "%b %d, %Y")
_TIME_FMTS = ("%H:%M", "%H:%M:%S", "%I:%M %p", "%I:%M:%S %p", "%I:%M%p", "%I %p")


def _parse_date(s: str) -> date | None:
    s = s.strip().strip('"')
    if not s:
        return None
    for f in _DATE_FMTS:
        try:
            return datetime.strptime(s, f).date()
        except ValueError:
            continue
    return None


def _parse_time(s: str) -> tuple[int, int] | None:
    s = s.strip().strip('"').upper()
    if not s:
        return None
    for f in _TIME_FMTS:
        try:
            t = datetime.strptime(s, f)
            return t.hour, t.minute
        except ValueError:
            continue
    return None


def _parse_datetime(s: str) -> datetime | None:
    s = s.strip().strip('"')
    if not s:
        return None
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        return dt.replace(tzinfo=None)  # keep the local wall-clock time as written
    except ValueError:
        pass
    parts = s.split()
    if len(parts) >= 2:
        d = _parse_date(parts[0])
        t = _parse_time(" ".join(parts[1:]))
        if d and t:
            return datetime(d.year, d.month, d.day, t[0], t[1])
    return None


def _num(s: str) -> float | None:
    s = re.sub(r"[^0-9.\-eE]", "", s or "")
    if not s or s in ("-", "."):
        return None
    try:
        v = float(s)
    except ValueError:
        return None
    return v if math.isfinite(v) else None


def _find_col(header: list[str], *needles: str, exclude: tuple[str, ...] = ()) -> int | None:
    for needle in needles:
        for i, h in enumerate(header):
            hu = h.upper()
            if needle in hu and not any(x in hu for x in exclude):
                return i
    return None


def parse_green_button(csv_text: str) -> dict:
    warnings: list[str] = []
    text = (csv_text or "").lstrip("﻿")
    lines = text.splitlines()
    hdr_idx = None
    for i, line in enumerate(lines[:200]):
        u = line.upper()
        if "DATE" in u and any(k in u for k in ("USAGE", "IMPORT", "KWH", "VALUE", "CONSUMPTION")):
            hdr_idx = i
            break
    if hdr_idx is None:
        return _empty_parse(["Could not find a header row with DATE and USAGE (kWh) columns. Download 'Green Button' "
                             "electric usage as CSV from your PG&E account (Energy usage details > Green Button > Export)."])
    rows = list(csv.reader(io.StringIO("\n".join(lines[hdr_idx:]))))
    header = [h.strip() for h in rows[0]]
    c_type = _find_col(header, "TYPE")
    c_date = _find_col(header, "DATE", exclude=("END",))
    if c_date is None:
        c_date = _find_col(header, "DATE")
    c_start = _find_col(header, "START TIME", "START", "TIME", exclude=("END",))
    c_end = _find_col(header, "END TIME", "END")
    c_use = _find_col(header, "USAGE", "IMPORT", "CONSUMPTION", "KWH", "VALUE", exclude=("COST", "EXPORT"))
    c_exp = _find_col(header, "EXPORT")
    if c_use is None or (c_date is None and c_start is None):
        return _empty_parse([f"Header found ({', '.join(header)}) but no usable DATE/USAGE columns."])
    if c_start == c_date:
        c_start = None
    unit_wh = "(WH)" in header[c_use].upper().replace(" ", "") and "KWH" not in header[c_use].upper()

    hourly: dict[tuple[date, int], float] = {}
    samples_per_day: dict[date, int] = {}
    minutes_seen: list[int] = []
    skipped = 0
    gas_rows = 0
    negatives = 0
    exports_total = 0.0
    prev: datetime | None = None
    for r in rows[1:]:
        if not r or all(not x.strip() for x in r):
            continue
        if c_type is not None and c_type < len(r):
            t = r[c_type].upper()
            if "GAS" in t:
                gas_rows += 1
                continue
        try:
            dt = None
            if c_date is not None and c_start is not None:
                d = _parse_date(r[c_date])
                tm = _parse_time(r[c_start])
                if d is None or tm is None:
                    dt = _parse_datetime(r[c_start]) or _parse_datetime(r[c_date])
                else:
                    dt = datetime(d.year, d.month, d.day, tm[0], tm[1])
            else:
                col = c_start if c_start is not None else c_date
                dt = _parse_datetime(r[col])
            v = _num(r[c_use]) if c_use < len(r) else None
        except (IndexError, ValueError):
            dt, v = None, None
        if dt is None or v is None:
            skipped += 1
            continue
        if unit_wh:
            v /= 1000.0
        if c_exp is not None and c_exp < len(r):
            e = _num(r[c_exp])
            if e:
                exports_total += abs(e)
        if v < 0:
            negatives += 1
            v = 0.0
        if c_end is not None and c_end < len(r) and c_start is not None:
            te = _parse_time(r[c_end])
            if te:
                mins = (te[0] * 60 + te[1]) - (dt.hour * 60 + dt.minute)
                if mins < 0:
                    mins += 24 * 60
                mins = mins + 1 if mins % 5 == 4 else mins  # PG&E writes 00:00-00:14 for a 15-min interval
                if 0 < mins <= 60:
                    minutes_seen.append(mins)
        elif prev is not None:
            delta = int((dt - prev).total_seconds() // 60)
            if 0 < delta <= 60:
                minutes_seen.append(delta)
        prev = dt
        key = (dt.date(), dt.hour)
        hourly[key] = hourly.get(key, 0.0) + v
        samples_per_day[dt.date()] = samples_per_day.get(dt.date(), 0) + 1

    if not hourly:
        return _empty_parse([f"No usable electric usage rows found ({skipped} rows could not be parsed)."])
    interval = int(np.median(minutes_seen)) if minutes_seen else 60
    if interval not in (5, 15, 30, 60):
        warnings.append(f"Unusual interval length ({interval} min); treated samples as summing into each hour.")
    if skipped:
        warnings.append(f"Skipped {skipped} rows that had no parsable date/time or kWh value.")
    if gas_rows:
        warnings.append(f"Ignored {gas_rows} natural-gas rows (this tool models electricity only).")
    if negatives:
        warnings.append(f"{negatives} intervals had negative kWh (net export from solar); counted them as 0 usage.")
    if exports_total > 0:
        warnings.append(f"File has an EXPORT column ({exports_total:,.0f} kWh exported): the usage is grid IMPORT net of "
                        "your solar, not total household consumption.")

    # Hourly sums by (date, hour) -> averages by (month, daytype, local hour) over the days that have that hour.
    sums = np.zeros((12, 2, 24))
    counts = np.zeros((12, 2, 24))
    for (d, h), v in hourly.items():
        wk = 1 if d.weekday() >= 5 else 0
        sums[d.month - 1, wk, h] += v
        counts[d.month - 1, wk, h] += 1
    expected = 60 // interval if interval in (5, 15, 30, 60) else None
    if expected:
        partial = sum(1 for d, n in samples_per_day.items() if n < 24 * expected * 0.9)
        if partial:
            warnings.append(f"{partial} days have missing intervals; their hours were averaged over the samples present.")
    with np.errstate(invalid="ignore", divide="ignore"):
        mat = np.where(counts > 0, sums / np.maximum(counts, 1), np.nan)
    days = len(samples_per_day)
    mat, fill_note = _fill_matrix(mat)
    if fill_note:
        warnings.append(fill_note)
    if days < 28:
        warnings.append(f"Only {days} days of data: the monthly pattern is extrapolated from very little data.")
    annual = float(matrix_to_hourly(mat).sum())
    return {"matrix_kwh": [[[round(float(x), 5) for x in row] for row in m] for m in mat], "days": int(days),
            "interval_minutes": int(interval), "annual_kwh_estimate": round(annual, 1), "warnings": warnings}


def _fill_matrix(mat: np.ndarray) -> tuple[np.ndarray, str | None]:
    """Fill missing (month, daytype, hour) cells: other daytype of that month, else the nearest month with data."""
    filled_months: list[int] = []
    out = mat.copy()
    for m in range(12):
        for wk in range(2):
            miss = np.isnan(out[m, wk])
            if miss.any():
                other = mat[m, 1 - wk]
                out[m, wk, miss] = other[miss]
    have = [m for m in range(12) if not np.isnan(out[m]).all()]
    for m in range(12):
        if np.isnan(out[m]).any():
            if not have:
                break
            near = min(have, key=lambda x: min(abs(x - m), 12 - abs(x - m)))
            miss = np.isnan(out[m])
            out[m][miss] = out[near][miss]
            filled_months.append(m)
    out = np.nan_to_num(out, nan=float(np.nanmean(out)) if np.isfinite(np.nanmean(out)) else 0.0)
    note = None
    if filled_months:
        names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
        note = ("No data for " + ", ".join(names[m] for m in filled_months) +
                ": filled from the nearest month you have (seasonal differences in those months are not captured).")
    return out, note


def _empty_parse(warnings: list[str]) -> dict:
    return {"matrix_kwh": [[[0.0] * 24 for _ in range(2)] for _ in range(12)], "days": 0, "interval_minutes": 0,
            "annual_kwh_estimate": 0.0, "warnings": warnings}
