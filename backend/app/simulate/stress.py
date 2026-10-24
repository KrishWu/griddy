"""Feasibility / stress-test screening.  OWNER: workstream B (Simulate + Stress Test).

Transparent, rule-based checks on the simulated year plus a few reruns under stressed
inputs (July heat wave, loss of the largest gas unit). Every threshold is a named
constant with its basis, and anything that really needs a utility interconnection study
says so (needs_utility_study=True). Keep the signature of stress_test() unchanged;
app/pipeline.py calls it.
"""

from __future__ import annotations

import dataclasses
import logging
import math
from functools import lru_cache

import numpy as np

from app.contract import Finding, Scenario, SimulationResult
from app.simulate.demand import pue_hourly
from app.simulate.dispatch import LOOKAHEAD_H, Dispatch, dispatch

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

# Rough single-circuit transfer capability by point-of-interconnection voltage:
# (kV from, kV below, low MW, high MW). Bands around the nominal classes 69 / 115 /
# 138-161 / 220-230 / 287-345 / 500 kV, split near their geometric midpoints, so SCE's
# 220 kV lands with 230 kV and a 66 kV line with 69 kV.
POI_CAPABILITY_MW = (
    (60, 90, 50, 100),
    (90, 127, 100, 200),
    (127, 190, 150, 300),
    (190, 257, 400, 600),
    (257, 415, 800, 1200),
    (415, math.inf, 1500, 2000),
)
TRANSMISSION_MIN_KV = 60.0  # below this a POI is a distribution voltage (12-35 kV feeders)
# At or below this, a tie without a new substation is a distribution interconnection
# (utility Rule 21 / WDAT process), not a CAISO transmission study.
DISTRIBUTION_MAX_MW = 50.0

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
# Reruns compare against the base year on the payload's 0.001 MW rounding; a week of
# rounding stays well under this, so anything above it is a real stress effect.
RERUN_TOL_MWH = 0.5


def _f(id_: str, severity: str, title: str, detail: str, **kw) -> Finding:
    return Finding(id=id_, module="stress", severity=severity, title=title, detail=detail, **kw)


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
    the energy only storage can supply. Sized as a sequent-peak pass: each hour storage
    gains what surplus solar/wind (and, with grid charging, spare import capacity) can put
    in and loses the residual deficit; the largest drawdown over the year joined to itself
    (the dispatch year is cyclic) is the energy it must hold. A short recharge counts only
    for what it stores, and a year that drains more than it can refill has no finite size.
    """
    f, d = prep.fleet, prep.drivers
    n = len(d.demand_mw)
    renew = f.solar_mw * np.clip(d.solar_cf, 0, 1) + f.wind_mw * np.clip(d.wind_cf, 0, 1)
    firm = _hourly_cap(f.gas_cc_mw, n) + _hourly_cap(f.gas_ct_mw, n) + f.import_limit_mw
    residual = np.clip(d.demand_mw - renew - firm, 0, None)
    unmet_h = sim.summary.hours_unmet
    on_paper = (
        " This screen assumes perfect foresight (the battery enters each stretch full and refills whenever it can); "
        f"the simulated dispatch plans at most {LOOKAHEAD_H} h ahead and still left {unmet_h:,} h unmet (see the unmet-demand finding)."
    )
    if residual.max() <= 1e-6:
        detail = "Gas and grid imports alone cover every hour after renewables."
        if f.batt_mwh:
            detail += " The battery shifts solar and cuts fuel and imports; reliability doesn't depend on it."
        if unmet_h:  # a screen never passes a year that left demand unmet
            return _f("storage_duration", "warn", "No residual deficit on paper, yet demand went unmet", detail + on_paper, metric=0, threshold=f.batt_mwh)
        return _f("storage_duration", "pass", "No deficit left for storage after firm resources", detail, metric=0, threshold=f.batt_mwh)

    after = "After gas and the import limit" if f.import_limit_mw else "After gas"
    eta = math.sqrt(f.rte)
    need_mw = float(residual.max())
    p = max(f.batt_mw, need_mw)  # size with at least the power the worst hour needs
    recharge = np.minimum(np.clip(renew - d.demand_mw, 0, None), p)
    via = "surplus solar/wind"
    if f.grid_charging and f.import_limit_mw > 0:
        # Rule 6 also charges from spare import capacity in cheap hours. Inside a short stretch
        # nearly every such hour has unserved load (valued at VOLL) within its 24 h lookahead,
        # so it is cheap: count it all (perfect foresight, a lower bound on the size needed).
        spare = np.minimum(f.import_limit_mw, np.clip(firm - np.clip(d.demand_mw - renew, 0, None), 0, None))
        recharge = np.minimum(recharge + np.where(residual > 1e-6, 0.0, spare), p)
        via += " and spare imports"
    flow = recharge * eta - residual / eta  # MWh into storage each hour
    usable = f.batt_mwh * eta  # MWh it can deliver from full
    if flow.sum() < 0:
        need = float(residual.sum())
        return _f(
            "storage_duration",
            "fail",
            "Storage can't refill between deficits",
            f"{after}, storage must supply {need:,.0f} MWh a year (up to {need_mw:,.0f} MW), "
            f"but {via} can put back only {float(recharge.sum()) * f.rte:,.0f} MWh after losses, so no battery size closes the gap. "
            "Add firm capacity, import headroom or renewables.",
            metric=need,
            threshold=usable,
        )

    c = np.concatenate([[0.0], np.cumsum(np.tile(flow, 2))])  # stored energy, year joined to itself
    full = np.maximum.accumulate(c)
    end = int((full - c).argmax())
    need_stored = float(full[end] - c[end])
    start = int(np.flatnonzero(c[: end + 1] == full[end])[-1])  # when storage was last full
    short_h = int((residual[np.arange(start, end) % n] > 1e-6).sum())
    need_mwh = need_stored * eta  # as delivered energy, comparable with `usable`
    sizing = (
        f"storage alone must supply {need_mwh:,.0f} MWh over the {end - start:,} h from "
        f"{_date(start % n, scenario.assumptions.weather_year)} ({short_h:,} h of them short), net of what {via} "
        f"recharge along the way, and up to {need_mw:,.0f} MW in the worst hour"
    )
    battery = f"delivers {usable:,.0f} MWh at {f.batt_mw:,.0f} MW"
    if f.batt_mw >= need_mw - 1e-6 and f.batt_mwh >= need_stored - 1e-6:
        if unmet_h:
            return _f("storage_duration", "warn", "Storage big enough on paper, yet demand went unmet", f"{after}, {sizing}; the battery {battery}." + on_paper, metric=need_mwh, threshold=usable)
        return _f("storage_duration", "pass", "Storage covers the residual deficit", f"{after}, {sizing}; the battery {battery}.", metric=need_mwh, threshold=usable)
    return _f(
        "storage_duration",
        "warn" if f.batt_mwh else "fail",
        "Storage too short for the residual deficit",
        f"{after}, {sizing}. The battery {battery}. "
        f"It would need about {p:,.0f} MW x {need_stored / p:,.1f} h, or more firm capacity.",
        metric=need_mwh,
        threshold=usable,
    )


def _daily_deficit_hours(net_load: np.ndarray) -> float:
    """Median hours per day that renewables fall short of demand (what storage must bridge)."""
    days = len(net_load) // 24
    per_day = (net_load[: days * 24].reshape(days, 24) > 1e-6).sum(axis=1)
    return float(np.median(per_day)) if days else 24.0


def _firm_capacity(scenario: Scenario, sim: SimulationResult, prep) -> Finding:
    """Derated firm capacity vs the facility peak, cross-checked against the simulated year.

    metric / threshold are the margin and target in percent (14.6 vs 15.0), the same
    rounded number the title and detail show.
    """
    f, d = prep.fleet, prep.drivers
    cap = prep.capacity_mw
    sim_peak = float(max(sim.hourly.demand_mw, default=0.0))
    # DemandSpec.peak_mw is the facility peak at the meter incl. cooling; a flat profile
    # simulates only peak x load factor, so the margin is measured against the larger.
    peak = max(float(scenario.demand.peak_mw), sim_peak)
    if peak <= 0:
        return _f("firm_capacity", "info", "No demand to firm", "The campus draws no power, so there is no peak to cover.")
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
    pct = round(100 * (firm / peak - 1), 1)  # severity uses the shown value, so "+15.0%" never warns
    breakdown = ", ".join(f"{k} {v:,.0f}" for k, v in parts.items() if v >= 0.5)
    breakdown = f"{breakdown} MW" if breakdown else "nothing"
    credits = []
    efor = [f"{EFOR[k]:.0%} ({label})" for k, label in (("gas_cc", "CC"), ("gas_ct", "CT")) if cap[k] > 0]
    if efor:
        credits.append(f"gas derated by forced-outage rate {' / '.join(efor)}")
    if f.batt_mw:
        credits.append(f"{duration:g} h battery credited {batt_credit:.0%} against a typical {deficit_h:.0f} h daily deficit")
    if cap["solar_pv"] or cap["onshore_wind"]:
        credits.append(f"solar/wind at their average output in the {CAPACITY_VALUE_HOURS} highest net-load hours ({solar_credit:.0%} / {wind_credit:.0%})")
    sim_max = f"; simulated max {sim_peak:,.0f} MW" if abs(peak - sim_peak) >= 0.5 else ""
    basis = (
        f"Firm capacity {firm:,.0f} MW vs facility peak {peak:,.0f} MW ({pct:+.1f}% margin{sim_max}). "
        f"Counted: {breakdown}" + (f"; {'; '.join(credits)}" if credits else "") + ". Screening estimate, not an ELCC study."
    )
    if pct < 0:
        sev, title = "fail", "Firm capacity below peak demand"
    elif pct < 100 * RESERVE_MARGIN_TARGET:
        sev, title = "warn", f"Firm capacity margin under {RESERVE_MARGIN_TARGET:.0%}"
    else:
        sev, title = "pass", "Firm capacity covers peak with margin"
    # The credits are averages (battery assumed charged, solar/wind at mean output), so check
    # them against what the simulated year actually served.
    unmet = np.asarray(sim.hourly.unmet_mw, float)
    short_top = int((unmet[top] > 1e-6).sum()) if len(unmet) == len(net_load) else 0
    why = (
        " The credits are averages (battery assumed charged, solar/wind at mean output); multi-day lulls drain "
        "storage, so see the unmet-demand and storage findings."
    )
    if sev != "fail" and short_top:
        sev, title = "fail", "Peak net-load hours went unserved"
        basis += f" Yet {short_top} of the {CAPACITY_VALUE_HOURS} highest net-load hours were unserved in the simulated year." + why
    elif sev == "pass" and sim.summary.hours_unmet:
        sev, title = "warn", "Capacity adequate on paper, yet demand went unmet"
        basis += f" Yet the simulated year left {sim.summary.hours_unmet:,} h unserved." + why
    return _f("firm_capacity", sev, title, basis, metric=pct, threshold=round(100 * RESERVE_MARGIN_TARGET, 1))


def _grid_charge_mw(sim: SimulationResult) -> np.ndarray:
    """Hourly part of battery charging drawn from imports (engine extras; zeros if absent)."""
    n = len(sim.hourly.imports_mw)
    x = sim.extras.get("battery_grid_charge_mw")
    if not isinstance(x, (list, tuple, np.ndarray)) or len(x) != n:
        return np.zeros(n)
    return np.asarray(x, float)


def _import_headroom(scenario: Scenario, sim: SimulationResult) -> Finding | None:
    """Peak LOAD-SERVING imports vs the limit. Rule 6 fills spare import capacity with
    battery charging on purpose, and that charging stops whenever the load needs the room."""
    g = scenario.grid
    if not g.connected or not g.import_limit_mw:
        return None
    imports, charging = np.asarray(sim.hourly.imports_mw, float), _grid_charge_mw(sim)
    serving = np.clip(imports - charging, 0, None)
    peak, total = round(float(serving.max(initial=0)), 2), float(imports.max(initial=0))
    share = peak / g.import_limit_mw
    flow = f"Peak load-serving import {peak:,.0f} MW"
    if total - peak >= 0.5:
        flow = (
            f"Peak import {total:,.0f} MW incl. up to {float(charging.max()):,.0f} MW of interruptible battery "
            f"charging; peak load-serving import {peak:,.0f} MW"
        )
    if share > 0.9:
        return _f(
            "import_headroom",
            "warn",
            "Grid imports near the interconnection limit",
            f"{flow} is {share:.0%} of the {g.import_limit_mw:,.0f} MW limit, so there's no headroom for contingencies.",
            metric=peak,
            threshold=0.9 * g.import_limit_mw,
            needs_utility_study=True,
        )
    return _f(
        "import_headroom",
        "pass",
        "Import headroom available",
        f"{flow} of a {g.import_limit_mw:,.0f} MW limit ({share:.0%}).",
        metric=peak,
        threshold=0.9 * g.import_limit_mw,
    )


@lru_cache(maxsize=256)
def _explore_kv(lon: float, lat: float) -> float | None:
    """A's site summary -> nearest line (else substation) kV, cached per 0.01 deg.
    Raises on a GIS error, which lru_cache does not memoize, so a hiccup is retried."""
    from app.contract import LngLat
    from app.explore.service import summarize_site

    s = summarize_site(LngLat(lon=lon, lat=lat))
    if s.nearest_line_kv:
        return float(s.nearest_line_kv)
    kvs = [float(x["voltage_kv"]) for x in s.nearest_substations if x.get("voltage_kv")]
    return kvs[0] if kvs else None


def _poi_kv_from_explore(lon: float, lat: float) -> float | None:
    """Explore's POI voltage guess; a GIS hiccup must never break a run (and isn't cached)."""
    try:
        return _explore_kv(lon, lat)
    except Exception:  # noqa: BLE001
        log.exception("summarize_site failed")
        return None


def _poi_band(kv: float) -> tuple[float, float] | None:
    """(low, high) MW one circuit at this voltage typically carries; None below transmission voltage."""
    for lo_kv, hi_kv, low, high in POI_CAPABILITY_MW:
        if lo_kv <= kv < hi_kv:
            return low, high
    return None


def _distribution_scale(scenario: Scenario, transfer_mw: float) -> bool:
    return not scenario.grid.new_substation and transfer_mw <= DISTRIBUTION_MAX_MW


def _poi_voltage(scenario: Scenario, sim: SimulationResult) -> Finding | None:
    g = scenario.grid
    if not g.connected:
        return None
    transfer = max(g.import_limit_mw, g.export_limit_mw, sim.summary.peak_import_mw)
    if transfer <= 0:
        return None
    if _distribution_scale(scenario, transfer):
        return _f(
            "poi_voltage",
            "info",
            f"Distribution-scale tie ({transfer:,.0f} MW)",
            f"{transfer:,.0f} MW on an existing feeder is a distribution interconnection; feeder and substation "
            "hosting capacity need the utility's Rule 21 / WDAT review.",
            metric=transfer,
            threshold=DISTRIBUTION_MAX_MW,
            needs_utility_study=True,
        )
    kv, source = g.poi_voltage_kv, "scenario"
    if kv is None:
        loc = scenario.site.location
        kv, source = _poi_kv_from_explore(round(loc.lon, 2), round(loc.lat, 2)), "nearest line/substation (Explore)"
    if kv is None or not math.isfinite(kv) or kv <= 0:  # missing, or a GIS sentinel such as -999999
        return _f(
            "poi_voltage",
            "info",
            "Point-of-interconnection voltage unknown",
            f"Can't check whether the tie can carry {transfer:,.0f} MW. Pick a site on the map or set the POI voltage.",
            needs_utility_study=True,
        )
    band = _poi_band(kv)
    if band is None:
        return _f(
            "poi_voltage",
            "info",
            f"{kv:,.0f} kV is a distribution voltage",
            f"A {kv:,.0f} kV POI ({source}) is a distribution voltage, built for feeders of tens of MW at most. "
            f"{transfer:,.0f} MW needs the utility's review of a transmission-level tie ({TRANSMISSION_MIN_KV:.0f} kV or more) "
            "or a new substation; set that voltage to check the circuit rating.",
            metric=kv,
            threshold=TRANSMISSION_MIN_KV,
            needs_utility_study=True,
        )
    low, high = band
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


def _cut(obj, ext: slice, n: int, **stressed):
    """Copy a Fleet/Drivers with every hourly (length-n) field cut to ext; a stressed field
    (one value per window hour) replaces the head of its field, base values pad the rest."""
    update = {}
    for fld in dataclasses.fields(obj):
        v, x = getattr(obj, fld.name), stressed.get(fld.name)
        if x is not None:
            v = _hourly_cap(v, n)[ext]
            v[: len(x)] = x
            update[fld.name] = v
        elif np.ndim(v) == 1 and len(v) == n:
            update[fld.name] = np.asarray(v, float)[ext]
    return dataclasses.replace(obj, **update)


def _head(d: Dispatch, k: int) -> Dispatch:
    """The first k hours of a dispatch."""
    update = {}
    for fld in dataclasses.fields(d):
        v = getattr(d, fld.name)
        if isinstance(v, dict):
            update[fld.name] = {key: a[:k] for key, a in v.items()}
        elif isinstance(v, np.ndarray):
            update[fld.name] = v[:k]
    return dataclasses.replace(d, **update)


def _rerun(prep, sim: SimulationResult, w: slice, *, demand: np.ndarray | None = None, gas_cc=None, gas_ct=None) -> Dispatch:
    """Dispatch hours w under stressed inputs, from the base run's state of charge at w.start.

    Every other Fleet/Drivers field carries over (grid_charging included), so the rerun uses
    the base year's dispatch policy. It runs on past w.stop for up to LOOKAHEAD_H hours of
    base inputs, so rule 6 sees the same prices and load ahead as the base year; only the
    first len(w) hours come back. Unstressed, it reproduces the base run's window.
    """
    n = prep.n
    ext = slice(w.start, min(w.stop + LOOKAHEAD_H, n))
    fleet = _cut(prep.fleet, ext, n, gas_cc_mw=gas_cc, gas_ct_mw=gas_ct)
    # Follow the policy the base year kept (dispatch's safety net may have dropped rule 6).
    fleet.grid_charging = bool(sim.extras.get("grid_charging", fleet.grid_charging)) and fleet.grid_charging
    drivers = _cut(prep.drivers, ext, n, demand_mw=demand)
    f0 = prep.fleet
    soc0 = sim.hourly.battery_soc_mwh[w.start - 1] if w.start > 0 else sim.hourly.battery_soc_mwh[-1]
    frac = min(1.0, max(0.0, soc0 / f0.batt_mwh)) if f0.batt_mwh else 0.0
    return _head(dispatch(fleet, drivers, initial_soc_frac=frac), w.stop - w.start)


def _shortfall(unmet) -> tuple[int, float]:
    """(hours, MWh) unserved, on the payload's 0.001 MW rounding so a rerun and the base compare."""
    u = np.round(np.asarray(unmet, float), 3)
    return int((u > 1e-6).sum()), float(u.sum())


def _added(sim: SimulationResult, w: slice, d: Dispatch) -> tuple[int, float, int, float]:
    """(added hours, added MWh, base hours, base MWh) of shortfall in window w vs the base year."""
    base_h, base_mwh = _shortfall(sim.hourly.unmet_mw[w])
    h, mwh = _shortfall(d.unmet_mw)
    return max(0, h - base_h), max(0.0, mwh - base_mwh), base_h, base_mwh


def _base_note(base_h: int, base_mwh: float) -> str:
    return f" ({base_h:,} h / {base_mwh:,.0f} MWh of that week were already unmet in the base year.)" if base_h else ""


def _days_window(daily: np.ndarray, days: int, first_day: int = 0, last_day: int | None = None) -> slice:
    """Hour slice of the `days`-day window with the largest total of `daily` within [first_day, last_day)."""
    last_day = len(daily) if last_day is None else last_day
    span = daily[first_day:last_day]
    k = min(days, len(span))
    best = first_day + int(np.convolve(span, np.ones(k), mode="valid").argmax())
    return slice(best * 24, (best + k) * 24)


def _n1_window(sim: SimulationResult, prep) -> slice:
    """The tightest N1_OUTAGE_DAYS: most gas + imports (incl. grid charging, whose energy later
    displaces gas and imports) + unmet."""
    h = sim.hourly
    n_days = prep.n // 24
    firm = np.zeros(prep.n)
    for k in ("gas_cc", "gas_ct"):
        if k in h.generation_mw:
            firm += np.asarray(h.generation_mw[k])
    firm += np.asarray(h.imports_mw) + np.asarray(h.unmet_mw)
    return _days_window(firm[: n_days * 24].reshape(n_days, 24).sum(axis=1), N1_OUTAGE_DAYS)


def _heat_window(scenario: Scenario, prep) -> slice:
    """The hottest HEAT_WAVE_DAYS of July at the site."""
    import datetime as dt

    year = scenario.assumptions.weather_year
    n_days = prep.n // 24
    july1 = (dt.date(year, 7, 1) - dt.date(year, 1, 1)).days
    daily_t = prep.temp_c[: n_days * 24].reshape(n_days, 24).mean(axis=1)
    return _days_window(daily_t, HEAT_WAVE_DAYS, july1, july1 + 31)


def _n_minus_1(scenario: Scenario, sim: SimulationResult, prep) -> Finding | None:
    cap = prep.capacity_mw
    # Units per asset: two separate plants never merge into one notional unit (that would be N-2).
    plants = {k: [a for a in scenario.assets if a.kind == k and a.capacity_mw > 0] for k in ("gas_cc", "gas_ct")}
    units = [(k, u) for k, assets in plants.items() for a in assets for u in _units(a.capacity_mw, UNIT_SIZE_MW[k])]
    if not units:
        return None
    kind, size = max(units, key=lambda x: x[1])
    w = _n1_window(sim, prep)
    out = _hourly_cap(getattr(prep.fleet, f"{kind}_mw"), prep.n)[w]
    out = np.maximum(out - size, 0.0)
    hours, extra, base_h, base_mwh = _added(sim, w, _rerun(prep, sim, w, **{kind: out}))
    label = "CC block" if kind == "gas_cc" else "CT unit"
    n_units = sum(1 for k, _ in units if k == kind)
    n_plants = len(plants[kind])
    year = scenario.assumptions.weather_year
    basis = (
        f"Largest gas unit: a {size:,.0f} MW {label} ({n_units} assumed for {cap[kind]:,.0f} MW"
        + (f" in {n_plants} plants" if n_plants > 1 else "")
        + f", <= {UNIT_SIZE_MW[kind]:,.0f} MW each), forced out for the tightest {N1_OUTAGE_DAYS} days "
        f"(from {_date(w.start, year)}, most gas + imports)."
    )
    if hours <= 0 and extra <= RERUN_TOL_MWH:
        if base_h:
            return _f(
                "n_minus_1",
                "info",
                "Losing the largest gas unit adds no shortfall (N-1)",
                basis + f" No unserved energy beyond the {base_h:,} h ({base_mwh:,.0f} MWh) already unmet that week in the base year.",
                metric=0,
                threshold=0,
            )
        return _f("n_minus_1", "pass", "Survives loss of the largest gas unit (N-1)", basis + " No additional unserved energy.", metric=0, threshold=0)
    return _f(
        "n_minus_1",
        "warn",
        f"N-1: losing the largest gas unit adds {hours:,} unmet hours" if hours else f"N-1: losing the largest gas unit adds {extra:,.0f} MWh of shortfall",
        basis + f" {extra:,.0f} MWh more unserved that week (beyond the base case)." + _base_note(base_h, base_mwh)
        + " A data center usually needs N+1 firm supply (a spare unit or more import capacity).",
        metric=hours,
        threshold=0,
    )


def _heat_wave(scenario: Scenario, sim: SimulationResult, prep) -> Finding | None:
    year = scenario.assumptions.weather_year
    temp = prep.temp_c
    w = _heat_window(scenario, prep)
    t_hot = temp[w] + HEAT_WAVE_EXTRA_C

    d0 = prep.drivers
    spec = scenario.demand
    community = spec.profile == "community"
    if spec.profile == "flat":
        # A flat load runs at its design PUE; heat adds cooling above design, up to the
        # facility peak (peak_mw already includes cooling).
        demand = np.minimum(d0.demand_mw[w] * pue_hourly(spec.pue, t_hot) / spec.pue, max(spec.peak_mw, float(d0.demand_mw.max())))
    elif community:
        demand = d0.demand_mw[w].copy()  # the EIA-930 shape already carries the observed heat-wave load
    else:
        demand = d0.demand_mw[w] * pue_hourly(spec.pue, t_hot) / pue_hourly(spec.pue, temp[w])

    def derated(kind: str) -> np.ndarray:
        cap = _hourly_cap(getattr(prep.fleet, f"{kind}_mw"), prep.n)[w]
        return cap * (1 - GAS_DERATE_PER_C[kind] * np.clip(t_hot - 15, 0, None))

    gas_cc, gas_ct = derated("gas_cc"), derated("gas_ct")
    d = _rerun(prep, sim, w, demand=demand, gas_cc=gas_cc, gas_ct=gas_ct)
    hours, extra, base_h, base_mwh = _added(sim, w, d)
    gas_cap = prep.capacity_mw["gas_cc"] + prep.capacity_mw["gas_ct"]
    gas_lost = gas_cap - float((gas_cc + gas_ct).min()) if gas_cap else 0.0
    price = np.asarray(sim.hourly.price_usd_per_mwh[w])
    if community:
        # No temperature sensitivity is modeled for community load, so only gas feels the +2 C.
        stress = "observed load replayed (the EIA-930 community shape already carries the heat wave; no added load modeled)"
        if gas_cap:
            stress += f", gas rerun {HEAT_WAVE_EXTRA_C:+.0f} C hotter (output down up to {gas_lost:,.0f} MW)"
    else:
        stress = f"rerun {HEAT_WAVE_EXTRA_C:+.0f} C hotter: peak load {demand.max():,.0f} MW with extra cooling"
        if gas_cap:
            stress += f", gas output down up to {gas_lost:,.0f} MW in the heat"
    basis = (
        f"Hottest {HEAT_WAVE_DAYS} days of July {year} at the site (from {_date(w.start, year)}, up to {temp[w].max():.0f} C observed), "
        f"{stress}, day-ahead prices up to ${price.max():,.0f}/MWh."
    )
    if hours > 0 or extra > RERUN_TOL_MWH:
        return _f(
            "heat_wave",
            "warn",
            f"Heat wave adds {hours:,} unmet hours" if hours else f"Heat wave adds {extra:,.0f} MWh of shortfall",
            basis + f" {extra:,.0f} MWh more unserved that week than in the base year, up to {d.unmet_mw.max():,.0f} MW short."
            + _base_note(base_h, base_mwh),
            metric=hours,
            threshold=0,
        )
    if base_h:
        return _f(
            "heat_wave",
            "info",
            "Heat wave adds no shortfall beyond the base year",
            basis + f" No unserved energy beyond the {base_h:,} h ({base_mwh:,.0f} MWh) already unmet that week in the base year.",
            metric=0,
            threshold=0,
        )
    if community and not gas_cap:
        return _f("heat_wave", "pass", "Met the observed July heat wave", basis + " Demand met every hour.", metric=0, threshold=0)
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
                "Import/export limits are planning assumptions. Real capacity and cost need "
                + (
                    "the utility's distribution interconnection review (Rule 21 / WDAT)."
                    if _distribution_scale(scenario, max(scenario.grid.import_limit_mw, scenario.grid.export_limit_mw))
                    else "a CAISO interconnection study."
                ),
                needs_utility_study=True,
            )
        )
    findings += _design_quality(scenario, sim, prep)
    from app.simulate.resilience import resilience_findings, resilience_metrics
    metrics = resilience_metrics(scenario, sim, prep)
    sim.extras["resilience"] = metrics
    findings += resilience_findings(metrics)
    return findings
