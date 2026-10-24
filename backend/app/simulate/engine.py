"""Hourly supply/demand simulator.  OWNER: workstream B (Simulate + Stress Test).

STUB: synthetic solar/wind/price/carbon shapes and a greedy dispatch so the
pipeline runs end to end. Replace the profiles with real CAISO 2024 data
(see docs/workstreams/B-simulate.md) and harden the dispatch. Keep the
signature of simulate() unchanged; app/pipeline.py calls it.

Balance enforced every hour t:
    demand = sum(generation) + discharge + imports + unmet - charge - exports - curtailed
(curtailed is renewable output thrown away; it is included in generation_mw.)
"""

from __future__ import annotations

import calendar

import numpy as np

from app.contract import (
    Catalog,
    HourlySeries,
    Provenance,
    Scenario,
    SimulationResult,
    SimulationSummary,
)

RENEWABLE = ("solar_pv", "onshore_wind")


def _hours(year: int) -> int:
    return 8784 if calendar.isleap(year) else 8760


def _synthetic_profiles(n: int) -> dict[str, np.ndarray]:
    """Per-MW capacity factors plus price and grid carbon. STUB - replace with CAISO data."""
    h = np.arange(n)
    hour_of_day = h % 24
    day = h // 24
    season = 0.75 + 0.25 * np.sin(2 * np.pi * (day - 80) / 365)  # summer peak
    solar = np.clip(np.sin(np.pi * (hour_of_day - 6) / 12), 0, None) * season
    solar = np.clip(solar / solar.mean() * 0.27, 0, 1)  # per-MW output never exceeds nameplate
    wind = 0.32 + 0.12 * np.cos(2 * np.pi * (hour_of_day - 2) / 24) + 0.08 * np.sin(2 * np.pi * day / 9)
    wind = np.clip(wind, 0.02, 0.95)
    solar_hours = solar > 0.05
    price = np.where(solar_hours, 25.0, 70.0) + 25 * np.clip(np.sin(np.pi * (hour_of_day - 16) / 6), 0, None)
    grid_co2 = np.where(solar_hours, 150.0, 330.0)
    return {"solar_pv": solar, "onshore_wind": wind, "price": price, "grid_co2": grid_co2}


def _demand(scenario: Scenario, n: int) -> np.ndarray:
    d = scenario.demand
    avg = d.peak_mw * d.load_factor
    hour_of_day = np.arange(n) % 24
    if d.profile == "flat":
        return np.full(n, avg)
    # Gentle diurnal swing around the average, capped at peak.
    swing = (d.peak_mw - avg) * np.sin(2 * np.pi * (hour_of_day - 9) / 24)
    return np.clip(avg + swing, 0, d.peak_mw)


def simulate(scenario: Scenario, catalog: Catalog) -> SimulationResult:
    n = _hours(scenario.assumptions.weather_year)
    prof = _synthetic_profiles(n)
    demand = _demand(scenario, n)

    cap = {k: 0.0 for k in ("solar_pv", "onshore_wind", "gas_cc", "gas_ct")}
    batt_mw = batt_mwh = 0.0
    for a in scenario.assets:
        if a.kind == "battery":
            batt_mw += a.capacity_mw
            batt_mwh += a.capacity_mw * (4 if a.duration_h is None else a.duration_h)
        else:
            cap[a.kind] += a.capacity_mw
    rte = catalog.spec("battery").round_trip_efficiency or 0.85
    eta = rte**0.5  # split losses evenly between charge and discharge

    gen = {k: np.zeros(n) for k in cap}
    charge, discharge, soc = np.zeros(n), np.zeros(n), np.zeros(n)
    imports, exports, unmet, curtailed = np.zeros(n), np.zeros(n), np.zeros(n), np.zeros(n)
    grid = scenario.grid
    import_cap = grid.import_limit_mw if grid.connected else 0.0
    export_cap = grid.export_limit_mw if grid.connected else 0.0

    e = batt_mwh * 0.5
    for t in range(n):
        for k in RENEWABLE:
            gen[k][t] = cap[k] * prof[k][t]
        net = demand[t] - gen["solar_pv"][t] - gen["onshore_wind"][t]
        if net < 0:  # surplus: charge, then export, then curtail
            c = min(-net, batt_mw, (batt_mwh - e) / eta)
            charge[t], e = c, e + c * eta
            surplus = -net - c
            exports[t] = min(surplus, export_cap)
            curtailed[t] = surplus - exports[t]
        else:  # deficit: discharge, gas CC, gas CT, imports
            dch = min(net, batt_mw, e * eta)
            discharge[t], e = dch, e - dch / eta
            net -= dch
            for k in ("gas_cc", "gas_ct"):
                g = min(net, cap[k])
                gen[k][t], net = g, net - g
            imports[t] = min(net, import_cap)
            unmet[t] = net - imports[t]
        soc[t] = e

    def total(x: np.ndarray) -> float:
        return float(x.sum())

    clean = total(gen["solar_pv"]) + total(gen["onshore_wind"]) - total(curtailed) - total(exports)
    summary = SimulationSummary(
        demand_mwh=total(demand),
        generation_mwh={k: total(v) for k, v in gen.items() if cap[k] > 0},
        imports_mwh=total(imports),
        exports_mwh=total(exports),
        unmet_mwh=total(unmet),
        curtailed_mwh=total(curtailed),
        peak_import_mw=float(imports.max(initial=0)),
        hours_unmet=int((unmet > 1e-6).sum()),
        onsite_clean_share=float(min(1.0, max(0.0, clean / max(total(demand), 1e-9)))),
        battery_cycles=float(total(discharge) / batt_mwh) if batt_mwh else 0.0,
    )

    def r(x: np.ndarray) -> list[float]:
        return np.round(x, 2).tolist()

    hourly = HourlySeries(
        start=f"{scenario.assumptions.weather_year}-01-01T00:00:00-08:00",
        demand_mw=r(demand),
        generation_mw={k: r(v) for k, v in gen.items() if cap[k] > 0},
        battery_charge_mw=r(charge),
        battery_discharge_mw=r(discharge),
        battery_soc_mwh=r(soc),
        imports_mw=r(imports),
        exports_mw=r(exports),
        unmet_mw=r(unmet),
        curtailed_mw=r(curtailed),
        price_usd_per_mwh=r(prof["price"]),
        grid_co2_kg_per_mwh=r(prof["grid_co2"]),
    )
    return SimulationResult(
        scenario_id=scenario.id,
        hourly=hourly,
        summary=summary,
        provenance=[
            Provenance(kind="assumption", source="STUB synthetic solar/wind/price/carbon profiles - replace with CAISO 2024"),
        ],
    )
