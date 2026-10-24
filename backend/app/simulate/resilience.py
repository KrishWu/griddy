"""Screening of a complete grid-tie outage, using base-run SOC and hourly dispatch."""
from __future__ import annotations

import dataclasses
import math

import numpy as np

from app.contract import Finding, Provenance, Scenario, SimulationResult
from app.evaluate.catalog import NUCLEAR_UNIT_MW
from app.evaluate.project import project_options
from app.simulate.dispatch import dispatch


def _window(obj, start: int, stop: int, n: int):
    return dataclasses.replace(obj, **{
        f.name: np.asarray(getattr(obj, f.name))[start:stop]
        for f in dataclasses.fields(obj)
        if np.ndim(getattr(obj, f.name)) == 1 and len(getattr(obj, f.name)) == n
    })


def resilience_metrics(scenario: Scenario, sim: SimulationResult, prep) -> dict:
    p, _ = project_options(scenario)
    n, f, d = prep.n, prep.fleet, prep.drivers
    length = min(p.outage_hours, n)
    critical = np.asarray(d.demand_mw) * p.critical_load_share
    gas_cc = np.broadcast_to(np.asarray(f.gas_cc_mw), (n,)) * 0.95
    gas_ct = np.broadcast_to(np.asarray(f.gas_ct_mw), (n,)) * 0.92
    renewable = f.solar_mw * np.clip(d.solar_cf, 0, 1) + f.wind_mw * np.clip(d.wind_cf, 0, 1)
    nuclear = np.broadcast_to(np.asarray(f.nuclear_mw) + np.asarray(f.nuclear_smr_mw), (n,))  # available output, carries on islanded
    residual = np.maximum(0, critical - renewable - gas_cc - gas_ct - nuclear)
    # Screen all possible start hours, then dispatch the most energy-constrained window.
    cumulative = np.r_[0, np.cumsum(residual)]
    rolling = cumulative[length:] - cumulative[:-length]
    soc = np.asarray(sim.hourly.battery_soc_mwh)
    starting_soc = np.r_[soc[-1], soc[:-1]][:len(rolling)]
    start = int(np.argmax(rolling - starting_soc * math.sqrt(f.rte)))
    stop = start + length
    fleet = dataclasses.replace(_window(f, start, stop, n), import_limit_mw=0, export_limit_mw=0,
        grid_charging=False, gas_cc_mw=gas_cc[start:stop], gas_ct_mw=gas_ct[start:stop])
    drivers = dataclasses.replace(_window(d, start, stop, n), demand_mw=critical[start:stop])
    frac = min(1, max(0, float(starting_soc[start]) / f.batt_mwh)) if f.batt_mwh else 0
    out = dispatch(fleet, drivers, initial_soc_frac=frac)
    unmet = np.asarray(out.unmet_mw)
    demand = float(critical[start:stop].sum())
    failures = np.flatnonzero(unmet > 0.001)
    critical_peak = float(critical.max())
    units = []
    for a in scenario.assets:
        if a.kind in ("gas_cc", "gas_ct") and a.capacity_mw > 0:
            count = max(1, math.ceil(a.capacity_mw / (400 if a.kind == "gas_cc" else 100)))
            units.extend([a.capacity_mw / count * (0.95 if a.kind == "gas_cc" else 0.92)] * count)
        elif a.kind in NUCLEAR_UNIT_MW and a.capacity_mw > 0:
            count = max(1, math.ceil(a.capacity_mw / NUCLEAR_UNIT_MW[a.kind] - 1e-9))
            avail = prep.fleet.nuclear_mw / prep.capacity_mw["nuclear"] if a.kind == "nuclear" else prep.fleet.nuclear_smr_mw / prep.capacity_mw["nuclear_smr"]
            units.extend([a.capacity_mw / count * float(avail)] * count)
    grid = scenario.grid.import_limit_mw if scenario.grid.connected else 0
    if grid > 0:
        units.append(grid)  # one tie is one common-mode failure; multiple circuits are not established
    firm = sum(units)
    n1 = firm - max(units, default=0)
    return {"outage_hours": length, "critical_load_share": p.critical_load_share,
        "outage_start_hour": start, "starting_soc_mwh": float(starting_soc[start]),
        "critical_demand_mwh": demand, "unserved_critical_mwh": float(unmet.sum()),
        "critical_energy_served_share": max(0, 1 - float(unmet.sum()) / demand) if demand else 1,
        "hours_before_shortfall": int(failures[0]) if len(failures) else length,
        "firm_capacity_mw": firm, "largest_contingency_mw": max(units, default=0),
        "n_minus_1_firm_mw": n1, "n_minus_1_coverage": n1 / critical_peak if critical_peak else None,
        "reserve_margin": firm / critical_peak - 1 if critical_peak else None,
        "basis": "Complete grid loss in the most energy-constrained screened window; actual preceding SOC, critical load only, gas derated 5% CC / 8% CT. Assumes islanding controls and continuous gas supply; nuclear keeps running at its availability (islanded operation needs a design that rides through loss of the grid). N-1 removes the largest of one grid tie, one assumed gas unit (≤400 MW CC / ≤100 MW CT) or one reactor / SMR module; excludes intermittent renewables and energy-limited batteries from sustained firm capacity. This is a screening heuristic, not exhaustive outage dispatch or a reliability probability.",
        "provenance": Provenance(kind="simulated", source="Griddy critical-load outage dispatch + explicit firm-unit assumptions",
            note="Engineering, protection, fuel assurance and utility studies are required before island operation.").model_dump()}


def resilience_findings(metrics: dict) -> list[Finding]:
    shortfall = metrics["unserved_critical_mwh"]
    coverage = metrics["n_minus_1_coverage"]
    return [Finding(id="grid_outage_resilience", module="stress", severity="warn" if shortfall > 0.01 else "pass",
        title=f"Grid outage: {metrics['critical_energy_served_share']:.1%} of critical energy served",
        detail=f"{metrics['outage_hours']} h outage, {shortfall:,.1f} MWh critical load unserved; {metrics['hours_before_shortfall']} h before first shortfall. " + metrics["basis"],
        metric=shortfall, threshold=0, needs_utility_study=True),
        Finding(id="firm_redundancy", module="stress", severity="pass" if coverage is not None and coverage >= 1 else "warn",
            title="Sustained N-1 firm supply coverage",
            detail=f"{metrics['n_minus_1_firm_mw']:,.1f} MW remains after loss of the largest {metrics['largest_contingency_mw']:,.1f} MW contingency. " + metrics["basis"],
            metric=coverage, threshold=1, needs_utility_study=True)]
