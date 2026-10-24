"""Hourly supply/demand simulator.  OWNER: workstream B (Simulate + Stress Test).

simulate() = load cached hourly profiles (profiles.py) -> build the campus demand
(demand.py) -> dispatch the fleet hour by hour (dispatch.py) -> package the contract
result. Keep the signature of simulate() unchanged; app/pipeline.py calls it.
stress.py reuses prepare()/dispatch() to rerun the year under stressed inputs.

Balance enforced every hour t:
    demand = sum(generation) + discharge + imports + unmet - charge - exports - curtailed
(curtailed is renewable output thrown away; it is included in generation_mw.) to_result()
rounds the hourly series to 0.001 MW and clips capped ones to their limits, so the
contract's per-hour limits hold exactly and the balance stays within a few kW.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field

import numpy as np

from app.contract import (
    Asset,
    AssetKind,
    Catalog,
    HourlySeries,
    Provenance,
    Scenario,
    SimulationResult,
    SimulationSummary,
)
from app.simulate import profiles
from app.simulate.demand import fit_demand
from app.simulate.dispatch import GRID_SPREAD_USD_PER_MWH, LOOKAHEAD_H, Dispatch, Drivers, Fleet, dispatch

RENEWABLE = ("solar_pv", "onshore_wind")
THERMAL = ("gas_cc", "gas_ct")
DEFAULT_BATTERY_H = 4.0


@dataclass
class Prepared:
    """Everything one dispatch run needs, so stress tests can tweak and rerun cheaply."""

    scenario: Scenario
    n: int
    fleet: Fleet
    drivers: Drivers
    temp_c: np.ndarray
    grid: profiles.GridProfile
    capacity_mw: dict[str, float]
    provenance: list[Provenance] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    weather_site: str = ""  # key of the site whose weather was used (a stand-in's key on fallback)


def _of_kind(scenario: Scenario, kind: AssetKind) -> list[Asset]:
    return [a for a in scenario.assets if a.kind == kind and a.capacity_mw > 0]


def _tech(catalog: Catalog, assets: list[Asset], kind: AssetKind, name: str, default: float) -> float:
    """Capacity-weighted TechSpec value for a kind, honoring per-asset overrides."""
    base = getattr(catalog.spec(kind), name, None)
    base = default if base is None else float(base)
    cap = sum(a.capacity_mw for a in assets)
    if not cap:
        return base
    return sum(a.capacity_mw * float(a.overrides.get(name, base)) for a in assets) / cap


def _marginal_cost(catalog: Catalog, scenario: Scenario, kind: AssetKind) -> float:
    a = scenario.assumptions
    assets = _of_kind(scenario, kind)
    heat_rate = _tech(catalog, assets, kind, "heat_rate_mmbtu_per_mwh", 7.0)
    co2 = _tech(catalog, assets, kind, "co2_kg_per_mmbtu", 53.06)
    var_om = _tech(catalog, assets, kind, "var_om_usd_per_mwh", 0.0)
    return heat_rate * a.gas_price_usd_per_mmbtu + var_om + a.carbon_price_usd_per_t * heat_rate * co2 / 1000


def _renewable_cf(scenario: Scenario, kind: AssetKind, site_w: profiles.SiteWeather, year: int, prov: list[Provenance]) -> np.ndarray:
    """Capacity-weighted per-MW output; assets with their own location use that location's weather."""
    attr = "solar_cf" if kind == "solar_pv" else "wind_cf"
    assets = _of_kind(scenario, kind)
    cap = sum(a.capacity_mw for a in assets)
    if not cap:
        return getattr(site_w, attr)
    total = np.zeros_like(site_w.solar_cf)
    for a in assets:
        w = site_w
        if a.location and profiles.site_key(a.location.lat, a.location.lon) != site_w.key:
            w = profiles.site_weather(a.location.lat, a.location.lon, year)
            prov.append(Provenance(kind="observed", source=f"{a.name or a.id}: weather at its own location ({w.key})", note=w.note))
        total += a.capacity_mw * getattr(w, attr)
    return total / cap


def prepare(scenario: Scenario, catalog: Catalog) -> Prepared:
    year = scenario.assumptions.weather_year
    n = profiles.n_hours(year)
    loc = scenario.site.location
    site_w = profiles.site_weather(loc.lat, loc.lon, year)
    grid = profiles.grid_profile(scenario.site, year, scenario.assumptions.price_source, scenario.assumptions.flat_price_usd_per_mwh)
    prov: list[Provenance] = [*site_w.provenance, *grid.provenance]
    notes = [site_w.note] if site_w.note else []

    community = profiles.community_shape(year) if scenario.demand.profile == "community" else None
    fit = fit_demand(scenario.demand, site_w.temp_c, community)
    demand = fit.demand_mw
    if not fit.met and fit.note:
        notes.append(fit.note)
    prov.append(_demand_provenance(scenario, community is not None))

    cap = {k: sum(a.capacity_mw for a in _of_kind(scenario, k)) for k in (*RENEWABLE, *THERMAL)}
    batts = _of_kind(scenario, "battery")
    batt_mw = sum(a.capacity_mw for a in batts)
    batt_mwh = sum(a.capacity_mw * (DEFAULT_BATTERY_H if a.duration_h is None else a.duration_h) for a in batts)
    rte = _tech(catalog, batts, "battery", "round_trip_efficiency", 0.85)

    g, a = scenario.grid, scenario.assumptions
    fleet = Fleet(
        solar_mw=cap["solar_pv"],
        wind_mw=cap["onshore_wind"],
        gas_cc_mw=cap["gas_cc"],
        gas_ct_mw=cap["gas_ct"],
        batt_mw=batt_mw,
        batt_mwh=batt_mwh,
        rte=rte,
        import_limit_mw=g.import_limit_mw if g.connected else 0.0,
        export_limit_mw=g.export_limit_mw if g.connected else 0.0,
        # Price-aware grid charging (dispatch rule 6); scenario.options["grid_charging"] = False turns it off.
        grid_charging=g.connected and bool(scenario.options.get("grid_charging", True)),
    )
    drivers = Drivers(
        demand_mw=demand,
        solar_cf=_renewable_cf(scenario, "solar_pv", site_w, year, prov),
        wind_cf=_renewable_cf(scenario, "onshore_wind", site_w, year, prov),
        # CAISO prices already embed cap-and-trade, so (like evaluate) no carbon price on imports.
        import_cost_usd_per_mwh=grid.price_usd_per_mwh + a.import_adder_usd_per_mwh,
        export_price_usd_per_mwh=grid.price_usd_per_mwh,
        gas_cc_cost_usd_per_mwh=_marginal_cost(catalog, scenario, "gas_cc"),
        gas_ct_cost_usd_per_mwh=_marginal_cost(catalog, scenario, "gas_ct"),
    )
    if fleet.grid_charging and batt_mw > 0 and batt_mwh > 0:
        prov.append(
            Provenance(
                kind="assumption",
                source=(
                    f"Battery also charges from grid imports in cheap hours ({LOOKAHEAD_H} h price/demand/solar "
                    f"foresight, ${GRID_SPREAD_USD_PER_MWH:g}/MWh minimum spread); "
                    "scenario.options.grid_charging=false turns it off"
                ),
                note="Perfect day-ahead foresight is an upper bound on arbitrage; adds battery cycles",
            )
        )
    cap["battery"] = batt_mw
    return Prepared(scenario, n, fleet, drivers, site_w.temp_c, grid, cap, prov, notes, site_w.source_key)


def _demand_provenance(scenario: Scenario, community: bool) -> Provenance:
    d = scenario.demand
    if community:
        return profiles.COMMUNITY_PROVENANCE
    shape = {
        "flat": "constant load",
        "ai_training": "near-flat AI training load with checkpoint dips",
        "ai_inference": "diurnal AI inference load",
        "community": "synthetic community shape",
    }[d.profile]
    # demand.py applies PUE only to the AI profiles; community and flat loads have no cooling term.
    pue = "" if d.profile in ("flat", "community") else f"; cooling (PUE {d.pue:g}) rises with outdoor temperature"
    return Provenance(
        kind="assumption",
        source=f"Demand: {shape}, {d.peak_mw:,.0f} MW peak, load factor {d.load_factor:.2f}{pue}",
    )


def _worst_day(d: Dispatch, n: int) -> dict:
    days = n // 24

    def daily(x: np.ndarray) -> np.ndarray:
        return x[: days * 24].reshape(days, 24).sum(axis=1)

    unmet = daily(d.unmet_mw)
    if unmet.max() > 1e-6:
        i = int(unmet.argmax())
        return {"index": i, "reason": f"most unserved energy ({unmet[i]:,.0f} MWh)"}
    firm = daily(d.generation_mw["gas_cc"] + d.generation_mw["gas_ct"] + d.imports_mw)
    if firm.max() > 1e-6:
        i = int(firm.argmax())
        return {"index": i, "reason": f"most gas + grid imports ({firm[i]:,.0f} MWh)"}
    ren = daily(d.generation_mw["solar_pv"] + d.generation_mw["onshore_wind"])
    i = int(ren.argmin())
    return {"index": i, "reason": "lowest on-site renewable output"}


def summarize(prep: Prepared, d: Dispatch) -> SimulationSummary:
    def total(x: np.ndarray) -> float:
        return float(x.sum())

    demand = prep.drivers.demand_mw
    ren = total(d.generation_mw["solar_pv"]) + total(d.generation_mw["onshore_wind"])
    # On-site clean energy served: renewables used directly plus the renewable share of
    # what the battery returned (it also charges from cheap imports when grid charging is on).
    grid_charge = total(d.grid_charge_mw) if d.grid_charge_mw is not None else 0.0
    ren_charge = total(d.charge_mw) - grid_charge
    ren_share = ren_charge / (ren_charge + grid_charge) if ren_charge + grid_charge > 0 else 1.0
    clean = ren - total(d.curtailed_mw) - total(d.exports_mw) - ren_charge + ren_share * total(d.discharge_mw)
    batt_mwh = prep.fleet.batt_mwh
    return SimulationSummary(
        demand_mwh=total(demand),
        generation_mwh={k: total(d.generation_mw[k]) for k in (*RENEWABLE, *THERMAL) if prep.capacity_mw[k] > 0},
        imports_mwh=total(d.imports_mw),
        exports_mwh=total(d.exports_mw),
        unmet_mwh=total(d.unmet_mw),
        curtailed_mwh=total(d.curtailed_mw),
        peak_import_mw=float(d.imports_mw.max(initial=0)),
        hours_unmet=int((d.unmet_mw > 1e-6).sum()),
        onsite_clean_share=float(min(1.0, max(0.0, clean / max(total(demand), 1e-9)))),
        battery_cycles=float(total(d.discharge_mw) / batt_mwh) if batt_mwh else 0.0,
    )


def _rounded(x: np.ndarray, nd: int = 3, cap: float | np.ndarray | None = None) -> np.ndarray:
    """Round for the payload; a capped series is clipped back to its (unrounded) limit, since
    rounding a value at a limit like 718.4466 MW would otherwise report 718.447."""
    out = np.round(np.asarray(x, dtype=float), nd)
    return out if cap is None else np.minimum(out, np.asarray(cap, dtype=float))


def to_result(prep: Prepared, d: Dispatch, started: float | None = None) -> SimulationResult:
    s, f = prep.scenario, prep.fleet
    kinds = [k for k in (*RENEWABLE, *THERMAL) if prep.capacity_mw[k] > 0]
    gen_cap = {"solar_pv": f.solar_mw, "onshore_wind": f.wind_mw, "gas_cc": f.gas_cc_mw, "gas_ct": f.gas_ct_mw}

    def r(x: np.ndarray, nd: int = 3, cap: float | np.ndarray | None = None) -> list[float]:
        return _rounded(x, nd, cap).tolist()

    charge = _rounded(d.charge_mw, cap=f.batt_mw)
    imports = _rounded(d.imports_mw, cap=f.import_limit_mw)
    grid_charge = np.zeros(prep.n) if d.grid_charge_mw is None else np.asarray(d.grid_charge_mw, dtype=float)
    # Part of battery_charge_mw drawn from imports, never more than either rounded series.
    grid_charge_hourly = np.minimum(np.round(grid_charge, 2), np.minimum(charge, imports))
    hourly = HourlySeries(
        start=f"{s.assumptions.weather_year}-01-01T00:00:00-08:00",
        demand_mw=r(prep.drivers.demand_mw),
        generation_mw={k: r(d.generation_mw[k], cap=gen_cap[k]) for k in kinds},
        battery_charge_mw=charge.tolist(),
        battery_discharge_mw=r(d.discharge_mw, cap=f.batt_mw),
        battery_soc_mwh=r(d.soc_mwh, cap=f.batt_mwh),
        imports_mw=imports.tolist(),
        exports_mw=r(d.exports_mw, cap=f.export_limit_mw),
        unmet_mw=r(d.unmet_mw),
        curtailed_mw=r(d.curtailed_mw),
        price_usd_per_mwh=r(prep.grid.price_usd_per_mwh, 2),
        grid_co2_kg_per_mwh=r(prep.grid.grid_co2_kg_per_mwh, 1),
    )
    summary = summarize(prep, d)
    ren_gen = sum(float(d.generation_mw[k].sum()) for k in RENEWABLE)
    extras = {
        "grid_cfe_share": r(prep.grid.cfe_share, 4),
        "temperature_c": r(prep.temp_c, 1),
        "capacity_factor": {k: float(d.generation_mw[k].sum()) / (prep.capacity_mw[k] * prep.n) for k in kinds},
        "curtailment_share": float(d.curtailed_mw.sum()) / ren_gen if ren_gen else 0.0,
        "worst_day": _worst_day(d, prep.n),
        "price_node": prep.grid.node,
        "weather_site": prep.weather_site or profiles.site_key(s.site.location.lat, s.site.location.lon),
        "marginal_cost_usd_per_mwh": {"gas_cc": prep.drivers.gas_cc_cost_usd_per_mwh, "gas_ct": prep.drivers.gas_ct_cost_usd_per_mwh},
        "battery_energy_mwh": prep.fleet.batt_mwh,
        "battery_grid_charge_mwh": float(grid_charge.sum()),
        # Policy the year actually used: dispatch drops rule 6 if it would have cost more.
        "grid_charging": bool(d.grid_charging),
        "battery_grid_charge_mw": grid_charge_hourly.tolist(),
        "notes": prep.notes,
    }
    if started is not None:
        extras["runtime_ms"] = round(1000 * (time.perf_counter() - started), 1)
    return SimulationResult(scenario_id=s.id, hourly=hourly, summary=summary, provenance=prep.provenance, extras=extras)


def simulate(scenario: Scenario, catalog: Catalog) -> SimulationResult:
    started = time.perf_counter()
    prep = prepare(scenario, catalog)
    return to_result(prep, dispatch(prep.fleet, prep.drivers), started)
