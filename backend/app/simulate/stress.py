"""Feasibility / stress-test screening.  OWNER: workstream B (Simulate + Stress Test).

Transparent, rule-based checks on the simulated year plus a few reruns under stressed
inputs (July heat wave, loss of the largest gas unit). Every threshold is a named
constant with its basis, and anything that really needs a utility interconnection study
says so (needs_utility_study=True). Keep the signature of stress_test() unchanged;
app/pipeline.py calls it.
"""

from __future__ import annotations

import logging
import math
from functools import lru_cache

import numpy as np

from app.contract import Finding, Scenario, SimulationResult
from app.simulate.demand import pue_hourly

log = logging.getLogger(__name__)

# Firm-capacity derates (screening values, not a resource-adequacy / ELCC study).
EFOR = {"gas_cc": 0.05, "gas_ct": 0.08}  # equivalent forced-outage rates, NERC GADS fleet averages (approx.)
RESERVE_MARGIN_TARGET = 0.15  # CPUC planning reserve margin is ~15-17%
# Solar/wind credit = their average output in the top net-load hours (a capacity-value proxy).
CAPACITY_VALUE_HOURS = 100
# Battery credit by duration, relative to how long storage must carry the load each day:
# credit = min(BATTERY_CREDIT_MAX, duration / daily deficit hours). A peaky load with a 4 h
# evening deficit gets ~90% (CPUC practice); a flat 24/7 load with 14 h nights gets ~30%.
BATTERY_CREDIT_MAX = 0.9
MIN_DEFICIT_HOURS = 4.0

# Rough single-circuit transfer capability by point-of-interconnection voltage (low, high MW).
POI_CAPABILITY_MW = ((69, 50, 100), (115, 100, 200), (138, 150, 300), (230, 400, 600), (345, 800, 1200), (500, 1500, 2000))

# Gas units: how an asset's capacity splits into units for N-1 (assumption).
UNIT_SIZE_MW = {"gas_cc": 400.0, "gas_ct": 100.0}
# Ambient-temperature derate of gas turbine output above ISO 15 C (per deg C, typical OEM curves).
GAS_DERATE_PER_C = {"gas_cc": 0.004, "gas_ct": 0.006}
HEAT_WAVE_EXTRA_C = 2.0  # stress on top of the observed July 2024 heat wave
HEAT_WAVE_DAYS = 7
N1_OUTAGE_DAYS = 7  # forced outage of the largest unit during the tightest week
DROUGHT_HOURS = 72
CURTAILMENT_WARN = 0.10
MIN_BATTERY_CYCLES = 100


def _f(id_: str, severity: str, title: str, detail: str, **kw) -> Finding:
    return Finding(id=id_, module="stress", severity=severity, title=title, detail=detail, **kw)


def _runs(mask: np.ndarray) -> list[tuple[int, int]]:
    """[start, end) index ranges where mask is True."""
    edges = np.diff(np.concatenate([[0], mask.astype(int), [0]]))
    return list(zip(np.flatnonzero(edges == 1).tolist(), np.flatnonzero(edges == -1).tolist()))


def _date(start_hour: int, year: int) -> str:
    import datetime as dt

    t = dt.datetime(year, 1, 1) + dt.timedelta(hours=start_hour)
    return f"{t:%b} {t.day} {t:%H}:00 PST"


# ---------------------------------------------------------------------------
# Checks on the simulated year
# ---------------------------------------------------------------------------


def _unmet(sim: SimulationResult) -> Finding:
    s = sim.summary
    if not s.hours_unmet:
        return _f("unmet_demand", "pass", "Demand met every hour", "No unserved energy in the simulated year.", metric=0, threshold=0)
    worst = max(sim.hourly.unmet_mw)
    share = s.unmet_mwh / max(s.demand_mwh, 1e-9)
    return _f(
        "unmet_demand",
        "fail",
        f"Demand not met in {s.hours_unmet:,} hours",
        f"{s.unmet_mwh:,.0f} MWh/yr unserved ({share:.2%} of demand), up to {worst:,.0f} MW short. "
        "Add firm capacity, longer storage, or import headroom.",
        metric=s.hours_unmet,
        threshold=0,
    )


def _storage_duration(scenario: Scenario, sim: SimulationResult, prep) -> Finding:
    """Compare the battery with the deficit left AFTER firm resources (gas + import limit).

    The raw overnight deficit of a flat 24/7 load would flag every battery; what matters is
    the energy only storage can supply between two renewable surpluses (when it can recharge).
    """
    f, d = prep.fleet, prep.drivers
    renew = f.solar_mw * np.clip(d.solar_cf, 0, 1) + f.wind_mw * np.clip(d.wind_cf, 0, 1)
    firm = np.asarray(f.gas_cc_mw, float) + np.asarray(f.gas_ct_mw, float) + f.import_limit_mw
    residual = np.clip(d.demand_mw - renew - firm, 0, None)
    if residual.max() <= 1e-6:
        detail = "Gas and grid imports alone cover every hour after renewables."
        if f.batt_mwh:
            detail += " The battery shifts solar and cuts fuel and imports; reliability doesn't depend on it."
        return _f("storage_duration", "pass", "No deficit left for storage after firm resources", detail, metric=0, threshold=f.batt_mwh)

    # Energy storage must deliver between recharge opportunities (hours with renewable surplus).
    segment = np.cumsum(renew > d.demand_mw)
    need_mwh = float(np.bincount(segment, weights=residual).max())
    need_mw = float(residual.max())
    hours = int(max(e - s for s, e in _runs(residual > 1e-6)))
    usable = f.batt_mwh * math.sqrt(f.rte)
    ok = f.batt_mw >= need_mw - 1e-6 and usable >= need_mwh - 1e-6
    if ok:
        return _f(
            "storage_duration",
            "pass",
            "Storage covers the residual deficit",
            f"Longest gap firm resources can't cover needs {need_mwh:,.0f} MWh (up to {need_mw:,.0f} MW, {hours} h); "
            f"the battery delivers {usable:,.0f} MWh at {f.batt_mw:,.0f} MW.",
            metric=need_mwh,
            threshold=usable,
        )
    hours_needed = need_mwh / max(need_mw, 1e-9)
    return _f(
        "storage_duration",
        "warn" if f.batt_mwh else "fail",
        "Storage too short for the residual deficit",
        f"After gas and the import limit, storage alone must supply {need_mwh:,.0f} MWh between recharges "
        f"(up to {need_mw:,.0f} MW; a run of {hours} h). The battery delivers {usable:,.0f} MWh at {f.batt_mw:,.0f} MW. "
        f"It would need about {need_mw:,.0f} MW x {hours_needed:.1f} h, or more firm capacity.",
        metric=need_mwh,
        threshold=usable,
    )


def _daily_deficit_hours(net_load: np.ndarray) -> float:
    """Median hours per day that renewables fall short of demand (what storage must bridge)."""
    days = len(net_load) // 24
    per_day = (net_load[: days * 24].reshape(days, 24) > 1e-6).sum(axis=1)
    return float(np.median(per_day)) if days else 24.0


def _firm_capacity(scenario: Scenario, sim: SimulationResult, prep) -> Finding:
    f, d = prep.fleet, prep.drivers
    cap = prep.capacity_mw
    solar = f.solar_mw * np.clip(d.solar_cf, 0, 1)
    wind = f.wind_mw * np.clip(d.wind_cf, 0, 1)
    net_load = d.demand_mw - solar - wind
    top = np.argsort(net_load)[-CAPACITY_VALUE_HOURS:]
    solar_credit = float(np.clip(d.solar_cf[top], 0, 1).mean())
    wind_credit = float(np.clip(d.wind_cf[top], 0, 1).mean())
    duration = f.batt_mwh / f.batt_mw if f.batt_mw else 0.0
    deficit_h = max(MIN_DEFICIT_HOURS, _daily_deficit_hours(net_load))
    batt_credit = min(BATTERY_CREDIT_MAX, duration / deficit_h)
    parts = {
        "gas CC": cap["gas_cc"] * (1 - EFOR["gas_cc"]),
        "gas CT": cap["gas_ct"] * (1 - EFOR["gas_ct"]),
        "battery": f.batt_mw * batt_credit,
        "solar": cap["solar_pv"] * solar_credit,
        "wind": cap["onshore_wind"] * wind_credit,
        "grid imports": f.import_limit_mw,
    }
    firm = sum(parts.values())
    peak = max(sim.hourly.demand_mw)
    margin = firm / max(peak, 1e-9) - 1
    breakdown = ", ".join(f"{k} {v:,.0f}" for k, v in parts.items() if v >= 0.5) or "none"
    credits = [f"gas derated by forced-outage rates {EFOR['gas_cc']:.0%} (CC) / {EFOR['gas_ct']:.0%} (CT)"]
    if f.batt_mw:
        credits.append(f"{duration:g} h battery credited {batt_credit:.0%} against a typical {deficit_h:.0f} h daily deficit")
    if cap["solar_pv"] or cap["onshore_wind"]:
        credits.append(f"solar/wind at their average output in the {CAPACITY_VALUE_HOURS} highest net-load hours ({solar_credit:.0%} / {wind_credit:.0%})")
    basis = (
        f"Firm capacity {firm:,.0f} MW vs simulated peak {peak:,.0f} MW ({margin:+.0%} margin). "
        f"Counted: {breakdown} MW; {'; '.join(credits)}. Screening estimate, not an ELCC study."
    )
    if margin < 0:
        sev, title = "fail", "Firm capacity below peak demand"
    elif margin < RESERVE_MARGIN_TARGET:
        sev, title = "warn", f"Firm capacity margin under {RESERVE_MARGIN_TARGET:.0%}"
    else:
        sev, title = "pass", "Firm capacity covers peak with margin"
    return _f("firm_capacity", sev, title, basis, metric=round(margin, 4), threshold=RESERVE_MARGIN_TARGET)


def _import_headroom(scenario: Scenario, sim: SimulationResult) -> Finding | None:
    g, s = scenario.grid, sim.summary
    if not g.connected or not g.import_limit_mw:
        return None
    share = s.peak_import_mw / g.import_limit_mw
    if share > 0.9:
        return _f(
            "import_headroom",
            "warn",
            "Grid imports near the interconnection limit",
            f"Peak import {s.peak_import_mw:,.0f} MW is {share:.0%} of the {g.import_limit_mw:,.0f} MW limit, "
            "so there's no headroom for contingencies.",
            metric=s.peak_import_mw,
            threshold=0.9 * g.import_limit_mw,
            needs_utility_study=True,
        )
    return _f(
        "import_headroom",
        "pass",
        "Import headroom available",
        f"Peak import {s.peak_import_mw:,.0f} MW of a {g.import_limit_mw:,.0f} MW limit ({share:.0%}).",
        metric=s.peak_import_mw,
        threshold=0.9 * g.import_limit_mw,
    )


@lru_cache(maxsize=256)
def _poi_kv_from_explore(lon: float, lat: float) -> float | None:
    """A's site summary, cached per 0.01 deg; a GIS hiccup must never break a run."""
    try:
        from app.contract import LngLat
        from app.explore.service import summarize_site

        s = summarize_site(LngLat(lon=lon, lat=lat))
        if s.nearest_line_kv:
            return float(s.nearest_line_kv)
        kvs = [float(x["voltage_kv"]) for x in s.nearest_substations if x.get("voltage_kv")]
        return kvs[0] if kvs else None
    except Exception:  # noqa: BLE001
        log.exception("summarize_site failed")
        return None


def _poi_voltage(scenario: Scenario, sim: SimulationResult) -> Finding | None:
    g = scenario.grid
    if not g.connected:
        return None
    transfer = max(g.import_limit_mw, g.export_limit_mw, sim.summary.peak_import_mw)
    if transfer <= 0:
        return None
    kv, source = g.poi_voltage_kv, "scenario"
    if kv is None:
        loc = scenario.site.location
        kv, source = _poi_kv_from_explore(round(loc.lon, 2), round(loc.lat, 2)), "nearest line/substation (Explore)"
    if not kv:
        return _f(
            "poi_voltage",
            "info",
            "Point-of-interconnection voltage unknown",
            f"Can't check whether the tie can carry {transfer:,.0f} MW. Pick a site on the map or set the POI voltage.",
            needs_utility_study=True,
        )
    cls = max((c for c in POI_CAPABILITY_MW if c[0] <= kv + 1), default=POI_CAPABILITY_MW[0], key=lambda c: c[0])
    _, low, high = cls
    where = f"{kv:,.0f} kV POI ({source})"
    if transfer <= low:
        return _f(
            "poi_voltage",
            "pass",
            f"{transfer:,.0f} MW fits a {kv:,.0f} kV tie",
            f"One {kv:,.0f} kV circuit typically carries {low:,}-{high:,} MW; this campus needs {transfer:,.0f} MW at the {where}.",
            metric=transfer,
            threshold=low,
        )
    if transfer <= high:
        return _f(
            "poi_voltage",
            "warn",
            f"{transfer:,.0f} MW is near the limit of a {kv:,.0f} kV tie",
            f"One {kv:,.0f} kV circuit typically carries {low:,}-{high:,} MW; {transfer:,.0f} MW at the {where} "
            "likely needs a second circuit or upgrades.",
            metric=transfer,
            threshold=high,
            needs_utility_study=True,
        )
    return _f(
        "poi_voltage",
        "fail",
        f"{transfer:,.0f} MW exceeds a single {kv:,.0f} kV tie",
        f"One {kv:,.0f} kV circuit typically carries {low:,}-{high:,} MW, but this campus needs {transfer:,.0f} MW at the {where}. "
        "Plan for multiple circuits or a higher-voltage (e.g. 500 kV) interconnection.",
        metric=transfer,
        threshold=high,
        needs_utility_study=True,
    )


def _renewable_drought(scenario: Scenario, sim: SimulationResult, prep) -> Finding | None:
    h = sim.hourly
    ren = np.zeros(len(h.demand_mw))
    for k in ("solar_pv", "onshore_wind"):
        if k in h.generation_mw:
            ren += np.asarray(h.generation_mw[k])
    if ren.sum() <= 0 or len(ren) < DROUGHT_HOURS:
        return None
    window = np.convolve(ren, np.ones(DROUGHT_HOURS), mode="valid")
    i = int(window.argmin())
    typical = ren.mean() * DROUGHT_HOURS
    unmet = float(np.sum(h.unmet_mw[i : i + DROUGHT_HOURS]))
    year = scenario.assumptions.weather_year
    detail = (
        f"Lowest {DROUGHT_HOURS} h of solar + wind starts {_date(i, year)}: {window[i]:,.0f} MWh, "
        f"{window[i] / max(typical, 1e-9):.0%} of a typical {DROUGHT_HOURS} h."
    )
    if unmet > 1e-6:
        return _f("renewable_drought", "warn", "Renewable drought causes shortfalls", detail + f" {unmet:,.0f} MWh went unserved.", metric=unmet, threshold=0)
    return _f("renewable_drought", "info", "Worst renewable drought is covered", detail + " Firm resources carried it.", metric=float(window[i]), threshold=float(typical))


def _design_quality(scenario: Scenario, sim: SimulationResult, prep) -> list[Finding]:
    out: list[Finding] = []
    share = float(sim.extras.get("curtailment_share") or 0.0)
    if share > CURTAILMENT_WARN:
        out.append(
            Finding(
                id="curtailment_high",
                module="simulate",
                severity="info",
                title=f"{share:.0%} of renewable output curtailed",
                detail="Surplus solar/wind with nowhere to go. More storage, export capacity, or less PV would raise its value.",
                metric=share,
                threshold=CURTAILMENT_WARN,
            )
        )
    if prep.fleet.batt_mwh and sim.summary.battery_cycles < MIN_BATTERY_CYCLES:
        out.append(
            Finding(
                id="battery_underused",
                module="simulate",
                severity="info",
                title=f"Battery cycles {sim.summary.battery_cycles:,.0f} times a year",
                detail=f"Below ~{MIN_BATTERY_CYCLES} full cycles/yr the battery is lightly used; it may be oversized for the solar surplus.",
                metric=sim.summary.battery_cycles,
                threshold=MIN_BATTERY_CYCLES,
            )
        )
    for note in sim.extras.get("notes") or []:
        out.append(Finding(id="profile_fallback", module="simulate", severity="info", title="Profile data note", detail=str(note)))
    return out


# ---------------------------------------------------------------------------
# Reruns under stressed inputs
# ---------------------------------------------------------------------------


def _units(capacity_mw: float, unit_mw: float) -> list[float]:
    if capacity_mw <= 0:
        return []
    k = max(1, math.ceil(capacity_mw / unit_mw - 1e-9))
    return [capacity_mw / k] * k


def _hourly_cap(x: float | np.ndarray, n: int) -> np.ndarray:
    return np.broadcast_to(np.asarray(x, float), (n,)).copy()


def _rerun(prep, sim: SimulationResult, w: slice, *, demand: np.ndarray | None = None, gas_cc=None, gas_ct=None):
    """Dispatch only hours w, starting from the base run's state of charge at w.start."""
    from app.simulate.dispatch import Drivers, Fleet, dispatch

    f0, d0 = prep.fleet, prep.drivers
    fleet = Fleet(
        solar_mw=f0.solar_mw,
        wind_mw=f0.wind_mw,
        gas_cc_mw=_hourly_cap(f0.gas_cc_mw, prep.n)[w] if gas_cc is None else gas_cc,
        gas_ct_mw=_hourly_cap(f0.gas_ct_mw, prep.n)[w] if gas_ct is None else gas_ct,
        batt_mw=f0.batt_mw,
        batt_mwh=f0.batt_mwh,
        rte=f0.rte,
        import_limit_mw=f0.import_limit_mw,
        export_limit_mw=f0.export_limit_mw,
    )
    drivers = Drivers(
        demand_mw=d0.demand_mw[w] if demand is None else demand,
        solar_cf=d0.solar_cf[w],
        wind_cf=d0.wind_cf[w],
        import_cost_usd_per_mwh=d0.import_cost_usd_per_mwh[w],
        export_price_usd_per_mwh=d0.export_price_usd_per_mwh[w],
        gas_cc_cost_usd_per_mwh=d0.gas_cc_cost_usd_per_mwh,
        gas_ct_cost_usd_per_mwh=d0.gas_ct_cost_usd_per_mwh,
    )
    soc0 = sim.hourly.battery_soc_mwh[w.start - 1] if w.start > 0 else sim.hourly.battery_soc_mwh[-1]
    frac = min(1.0, max(0.0, soc0 / f0.batt_mwh)) if f0.batt_mwh else 0.0
    return dispatch(fleet, drivers, initial_soc_frac=frac), fleet


def _days_window(daily: np.ndarray, days: int, first_day: int = 0, last_day: int | None = None) -> slice:
    """Hour slice of the `days`-day window with the largest total of `daily` within [first_day, last_day)."""
    last_day = len(daily) if last_day is None else last_day
    span = daily[first_day:last_day]
    k = min(days, len(span))
    best = first_day + int(np.convolve(span, np.ones(k), mode="valid").argmax())
    return slice(best * 24, (best + k) * 24)


def _n_minus_1(scenario: Scenario, sim: SimulationResult, prep) -> Finding | None:
    cap = prep.capacity_mw
    units = [(k, u) for k in ("gas_cc", "gas_ct") for u in _units(cap[k], UNIT_SIZE_MW[k])]
    if not units:
        return None
    kind, size = max(units, key=lambda x: x[1])
    h = sim.hourly
    n_days = prep.n // 24
    firm = np.zeros(prep.n)
    for k in ("gas_cc", "gas_ct"):
        if k in h.generation_mw:
            firm += np.asarray(h.generation_mw[k])
    firm += np.asarray(h.imports_mw) + np.asarray(h.unmet_mw)
    w = _days_window(firm[: n_days * 24].reshape(n_days, 24).sum(axis=1), N1_OUTAGE_DAYS)
    out = _hourly_cap(getattr(prep.fleet, f"{kind}_mw"), prep.n)[w]
    out = np.maximum(out - size, 0.0)
    d, _ = _rerun(prep, sim, w, **{kind: out})
    base_h = int((np.asarray(h.unmet_mw[w]) > 1e-6).sum())
    base_mwh = float(np.sum(h.unmet_mw[w]))
    hours = int((d.unmet_mw > 1e-6).sum()) - base_h
    extra = float(d.unmet_mw.sum()) - base_mwh
    label = "CC block" if kind == "gas_cc" else "CT unit"
    n_units = sum(1 for k, _ in units if k == kind)
    year = scenario.assumptions.weather_year
    basis = (
        f"Largest gas unit: a {size:,.0f} MW {label} ({n_units} assumed for {cap[kind]:,.0f} MW, "
        f"<= {UNIT_SIZE_MW[kind]:,.0f} MW each), forced out for the tightest {N1_OUTAGE_DAYS} days "
        f"(from {_date(w.start, year)}, most gas + imports)."
    )
    if hours <= 0 and extra <= 1e-6:
        return _f("n_minus_1", "pass", "Survives loss of the largest gas unit (N-1)", basis + " No additional unserved energy.", metric=0, threshold=0)
    return _f(
        "n_minus_1",
        "warn",
        f"N-1: losing the largest gas unit adds {hours:,} unmet hours",
        basis + f" {extra:,.0f} MWh more unserved that week (beyond the base case). "
        "A data center usually needs N+1 firm supply (a spare unit or more import capacity).",
        metric=hours,
        threshold=0,
    )


def _heat_wave(scenario: Scenario, sim: SimulationResult, prep) -> Finding | None:
    import datetime as dt

    year = scenario.assumptions.weather_year
    temp = prep.temp_c
    n_days = prep.n // 24
    july1 = (dt.date(year, 7, 1) - dt.date(year, 1, 1)).days
    daily_t = temp[: n_days * 24].reshape(n_days, 24).mean(axis=1)
    w = _days_window(daily_t, HEAT_WAVE_DAYS, july1, july1 + 31)
    t_hot = temp[w] + HEAT_WAVE_EXTRA_C

    d0 = prep.drivers
    spec = scenario.demand
    if spec.profile == "flat":
        # A flat load runs at its design PUE; heat adds cooling above design, up to the
        # facility peak (peak_mw already includes cooling).
        demand = np.minimum(d0.demand_mw[w] * pue_hourly(spec.pue, t_hot) / spec.pue, max(spec.peak_mw, float(d0.demand_mw.max())))
    elif spec.profile == "community":
        demand = d0.demand_mw[w].copy()  # the EIA-930 shape already carries the observed heat-wave load
    else:
        demand = d0.demand_mw[w] * pue_hourly(spec.pue, t_hot) / pue_hourly(spec.pue, temp[w])

    def derated(kind: str) -> np.ndarray:
        cap = _hourly_cap(getattr(prep.fleet, f"{kind}_mw"), prep.n)[w]
        return cap * (1 - GAS_DERATE_PER_C[kind] * np.clip(t_hot - 15, 0, None))

    d, fleet = _rerun(prep, sim, w, demand=demand, gas_cc=derated("gas_cc"), gas_ct=derated("gas_ct"))
    unmet_mwh = float(d.unmet_mw.sum())
    unmet_h = int((d.unmet_mw > 1e-6).sum())
    gas_cap = prep.capacity_mw["gas_cc"] + prep.capacity_mw["gas_ct"]
    gas_lost = gas_cap - float((fleet.gas_cc_mw + fleet.gas_ct_mw).min()) if gas_cap else 0.0
    price = np.asarray(sim.hourly.price_usd_per_mwh[w])
    basis = (
        f"Hottest {HEAT_WAVE_DAYS} days of July {year} at the site (from {_date(w.start, year)}, up to {temp[w].max():.0f} C observed), "
        f"rerun {HEAT_WAVE_EXTRA_C:+.0f} C hotter: peak load {demand.max():,.0f} MW with extra cooling, "
        + (f"gas output down up to {gas_lost:,.0f} MW in the heat, " if gas_cap else "")
        + f"day-ahead prices up to ${price.max():,.0f}/MWh."
    )
    if unmet_mwh > 1e-6:
        return _f(
            "heat_wave",
            "warn",
            f"Heat wave: demand unmet in {unmet_h} hours",
            basis + f" {unmet_mwh:,.0f} MWh unserved, up to {d.unmet_mw.max():,.0f} MW short.",
            metric=unmet_h,
            threshold=0,
        )
    return _f("heat_wave", "pass", "Rides through a July heat wave", basis + " Demand met every hour.", metric=0, threshold=0)


def stress_test(scenario: Scenario, sim: SimulationResult) -> list[Finding]:
    from app.evaluate.catalog import get_catalog
    from app.simulate.engine import prepare

    findings = [_unmet(sim)]
    prep = prepare(scenario, get_catalog())
    for check in (_storage_duration, _firm_capacity, _renewable_drought, _n_minus_1, _heat_wave):
        try:
            if (f := check(scenario, sim, prep)) is not None:
                findings.append(f)
        except Exception as exc:  # noqa: BLE001 - one broken check must not hide the others
            log.exception("stress check %s failed", check.__name__)
            findings.append(_f(f"{check.__name__.strip('_')}_error", "info", "Stress check unavailable", f"{check.__name__}: {exc}"[:200]))
    for check in (_import_headroom, _poi_voltage):
        if (f := check(scenario, sim)) is not None:
            findings.append(f)
    if scenario.grid.connected:
        findings.append(
            _f(
                "interconnection_unverified",
                "warn",
                "Interconnection capacity not verified",
                "Import/export limits are planning assumptions. Real capacity and cost need a CAISO interconnection study.",
                needs_utility_study=True,
            )
        )
    findings += _design_quality(scenario, sim, prep)
    return findings
