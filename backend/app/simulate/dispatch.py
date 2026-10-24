"""Hourly dispatch core.  OWNER: workstream B (Simulate + Stress Test).

Pure numpy/python, no I/O. engine.py builds a Fleet (capacities) and Drivers (hourly
demand, per-MW renewable output, prices) and dispatch() decides, hour by hour, how the
campus is supplied. Every rule below has a unit test in tests/test_simulate_dispatch.py.

1. Renewables: solar = solar_mw x clip(solar_cf, 0, 1), wind likewise. They are
   must-take; generation_mw INCLUDES output that is later curtailed.
2. Surplus hour (renewables > demand): charge the battery (power and headroom
   limits), then export up to the export limit if the export price is >= 0, then
   curtail the rest. The battery charges from on-site renewable surplus and, only when
   Fleet.grid_charging is on, from spare import capacity in cheap hours (rule 6). Never
   from gas.
3. Deficit hour: discharge the battery (power and SOC limits), then firm resources in
   merit order of this hour's marginal cost. Gas CC is always dispatched before gas CT;
   imports go ahead of a gas tier only when strictly cheaper than it (ties go to gas:
   order gas_cc, gas_ct, imports). Each is capped by its hourly available capacity;
   whatever is left is unmet.
4. Battery: eta_c = eta_d = sqrt(rte); soc[t] = soc[t-1] + charge*eta_c - discharge/eta_d,
   soc within [0, batt_mwh]. A surplus hour only charges and a deficit hour only
   discharges, so the battery never does both in one hour.
5. Cyclic year: by default a first pass from 50% SOC finds the year-end SOC, and the
   returned pass starts from it, so Dec 31 joins up with Jan 1 (nearly periodic).
6. Price-aware grid charging (Fleet.grid_charging): an hour is "cheap" when firm
   resources fully cover it without the battery and its import cost / rte + GRID_SPREAD
   is below the value of stored energy over the next 24 h (mean of the top-k marginal
   firm costs ahead, k = battery duration; unserved hours count at VOLL). Day-ahead
   prices are known that far ahead. In a cheap hour the battery holds (no discharge) and
   charges from import capacity left over after serving demand, so imports never exceed
   the limit, and it never imports to charge while spilling surplus. The battery tracks
   the average cost of what it holds (renewable surplus = 0, grid energy = import cost /
   eta) and then discharges only when the hour's marginal firm cost beats that cost, so
   grid-charged energy displaces imports, CT or unserved load, not cheaper gas CC.

Balance every hour t (exact to float rounding):
    demand = sum(generation) + discharge + imports + unmet - charge - exports - curtailed

Only the battery state is sequential: that loop runs over Python floats; everything
else is vectorized. A few ms for 8,784 h on a laptop.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

GENERATION_KEYS = ("solar_pv", "onshore_wind", "gas_cc", "gas_ct")
DEFAULT_INITIAL_SOC_FRAC = 0.5  # first pass of the cyclic year
GRID_SPREAD_USD_PER_MWH = 5.0  # minimum margin before grid charging is worth the cycle
VOLL_USD_PER_MWH = 1000.0  # value of lost load: what an unserved MWh is worth avoiding
LOOKAHEAD_H = 24


@dataclass
class Fleet:
    solar_mw: float = 0.0
    wind_mw: float = 0.0
    gas_cc_mw: float | np.ndarray = 0.0  # scalar nameplate, or hourly AVAILABLE capacity (derates / outages)
    gas_ct_mw: float | np.ndarray = 0.0
    batt_mw: float = 0.0  # charge and discharge power limit
    batt_mwh: float = 0.0  # energy capacity
    rte: float = 0.85  # round-trip efficiency, split as sqrt on charge and discharge
    import_limit_mw: float = 0.0  # 0 when not grid-connected (engine handles that)
    export_limit_mw: float = 0.0
    grid_charging: bool = False  # rule 6: charge from spare imports in cheap hours


@dataclass
class Drivers:  # all hourly arrays of length n
    demand_mw: np.ndarray
    solar_cf: np.ndarray  # per-MW output, clipped to [0,1] inside dispatch
    wind_cf: np.ndarray
    import_cost_usd_per_mwh: np.ndarray  # what an imported MWh costs the campus this hour (price + adder + carbon), used for merit order
    export_price_usd_per_mwh: np.ndarray  # wholesale price; never export when < 0 (curtail instead)
    gas_cc_cost_usd_per_mwh: float = 30.0  # marginal cost (fuel + var O&M + carbon); an hourly array also works
    gas_ct_cost_usd_per_mwh: float = 45.0


@dataclass
class Dispatch:
    generation_mw: dict[str, np.ndarray]  # ALWAYS keys solar_pv, onshore_wind, gas_cc, gas_ct; renewable generation INCLUDES curtailed output
    charge_mw: np.ndarray
    discharge_mw: np.ndarray
    soc_mwh: np.ndarray  # state of charge at the END of each hour
    imports_mw: np.ndarray
    exports_mw: np.ndarray
    unmet_mw: np.ndarray
    curtailed_mw: np.ndarray
    initial_soc_mwh: float
    grid_charge_mw: np.ndarray | None = None  # part of charge_mw drawn from imports (rule 6); None = all zero


# ---------------------------------------------------------------------------
# Input checks: fail loudly here rather than let NaN reach the contract.
# ---------------------------------------------------------------------------


def _hourly(x: float | np.ndarray, n: int, name: str, nonneg: bool) -> np.ndarray:
    """Broadcast a scalar or validate an hourly array of length n (finite, optionally >= 0)."""
    a = np.asarray(x, dtype=float)
    if a.ndim == 0:
        a = np.full(n, float(a))
    elif a.shape != (n,):
        raise ValueError(f"{name}: expected a scalar or {n} hourly values, got shape {a.shape}")
    if not np.isfinite(a).all():
        raise ValueError(f"{name}: contains NaN or inf")
    if nonneg and (a < 0).any():
        raise ValueError(f"{name}: must be >= 0")
    return a


def _scalar(x: float, name: str) -> float:
    v = float(x)
    if not math.isfinite(v) or v < 0:
        raise ValueError(f"{name}: must be a finite number >= 0, got {x!r}")
    return v


# ---------------------------------------------------------------------------
# Battery (the only sequential part)
# ---------------------------------------------------------------------------


def _battery_pass(
    net: list[float],
    p_max: float,
    e_max: float,
    eta: float,
    soc0: float,
    spare_import: list[float] | None = None,
    import_cost: list[float] | None = None,
    tiers: list[list[tuple[float, float]]] | None = None,
    surplus_ahead: list[float] | None = None,
) -> tuple[list[float], list[float], list[float], list[float]]:
    """Greedy charge on surplus (net < 0) / discharge on deficit (net > 0) for one year.

    With grid charging (rule 6), spare_import[t] > 0 marks a cheap hour: hold, and charge
    up to that many MW from imports at import_cost[t]; a deficit hour discharges only the
    MW that firm tiers[t] = [(cost, mw), ...] would serve at a cost above the stored
    energy's cost (unserved load counts at VOLL). Grid charging leaves room for the
    renewable surplus expected over the next 24 h (surplus_ahead[t], MWh storable), so
    it never displaces free solar.
    Plain Python floats on purpose: ~10x faster than indexing numpy scalars.
    Returns (charge_mw, grid_charge_mw, discharge_mw, soc_mwh at the end of each hour).
    """
    n = len(net)
    charge = [0.0] * n
    grid = [0.0] * n
    discharge = [0.0] * n
    soc = [0.0] * n
    priced = spare_import is not None
    spare = spare_import if priced else [0.0] * n
    cost_in = import_cost if priced else [0.0] * n
    room_for = surplus_ahead if priced else [0.0] * n
    e = soc0
    basis = 0.0  # $ paid for the energy currently stored (renewable surplus is free)
    for t, x in enumerate(net):
        c = 0.0
        if x < 0.0:  # surplus: store what fits
            c = min(-x, p_max, (e_max - e) / eta)
            if c > 0.0:
                e = min(e + c * eta, e_max)
            charge[t] = c
            if c < -x:  # still spilling surplus: never import to charge on top of it
                soc[t] = e
                continue
        if spare[t] > 0.0:  # cheap hour: hold, top up from spare import capacity
            g = min(spare[t], p_max - c, (e_max - e - room_for[t]) / eta)
            if g > 0.0:
                grid[t] = g
                charge[t] = c + g
                e = min(e + g * eta, e_max)
                basis += g * cost_in[t]
        elif x > 0.0 and e > 0.0:  # deficit: deliver what the SOC allows (and is worth it)
            d = min(x, p_max, e * eta)
            if priced and basis > 0.0:
                unit = basis / (e * eta)  # $ per delivered MWh of what is stored
                d = min(d, sum(mw for cost, mw in tiers[t] if cost > unit))
            if d > 0.0:
                discharge[t] = d
                e_new = max(e - d / eta, 0.0)
                basis = basis * (e_new / e) if e > 0.0 else 0.0
                e = e_new
        soc[t] = e
    return charge, grid, discharge, soc


def _take(need: np.ndarray, cap: float | np.ndarray, mask: np.ndarray | None = None) -> tuple[np.ndarray, np.ndarray]:
    """Serve min(need, cap) (only where mask is True); return (served, remaining need)."""
    served = np.minimum(need, cap)
    if mask is not None:
        served = np.where(mask, served, 0.0)
    return served, need - served


def _merit_order(need, import_cost, cc_cost, ct_cost, cc_avail, ct_avail, import_limit):
    """Serve `need` with gas CC, gas CT and imports in merit order (rule 3).

    Imports slot ahead of a tier only when strictly cheaper; comparing against
    max(cc, ct) keeps the order sane if a user prices CT below CC.
    Returns (gas_cc, gas_ct, imports, unmet, marginal cost of the last MW served).
    """
    imp_first = import_cost < cc_cost
    imp_mid = ~imp_first & (import_cost < np.maximum(cc_cost, ct_cost))
    imp_last = ~(imp_first | imp_mid)
    imp_a, need = _take(need, import_limit, imp_first)
    gas_cc, need = _take(need, cc_avail)
    imp_b, need = _take(need, import_limit, imp_mid)
    gas_ct, need = _take(need, ct_avail)
    imp_c, need = _take(need, import_limit, imp_last)
    imports = imp_a + imp_b + imp_c  # at most one is non-zero in any hour
    eps = 1e-9
    marginal = np.zeros_like(need)
    # Later tiers overwrite earlier ones, so this ends at the most expensive tier used.
    for served, cost in ((imp_a, import_cost), (gas_cc, cc_cost), (imp_b, import_cost), (gas_ct, ct_cost), (imp_c, import_cost)):
        marginal = np.where(served > eps, cost, marginal)
    marginal = np.where(need > eps, VOLL_USD_PER_MWH, marginal)
    return gas_cc, gas_ct, imports, need, marginal


def _spare_import_when_cheap(net, import_cost, cc_cost, ct_cost, cc_avail, ct_avail, import_limit, rte, duration_h):
    """Rule 6: (MW of import capacity free for grid charging in cheap hours else 0,
    per-hour firm tiers [(cost, mw), ...] the battery could displace without itself)."""
    n = net.shape[0]
    cc, ct, imports, unmet, marginal = _merit_order(np.maximum(net, 0.0), import_cost, cc_cost, ct_cost, cc_avail, ct_avail, import_limit)
    tiers = [
        [(c, m) for c, m in hour if m > 0.0]
        for hour in zip(
            zip(cc_cost.tolist(), cc.tolist()),
            zip(ct_cost.tolist(), ct.tolist()),
            zip(import_cost.tolist(), imports.tolist()),
            zip([VOLL_USD_PER_MWH] * n, unmet.tolist()),
        )
    ]
    k = int(min(LOOKAHEAD_H, max(1, round(duration_h))))
    ahead = np.lib.stride_tricks.sliding_window_view(np.concatenate([marginal[1:], np.zeros(LOOKAHEAD_H)]), LOOKAHEAD_H)[:n]
    value = np.partition(ahead, LOOKAHEAD_H - k, axis=1)[:, LOOKAHEAD_H - k :].mean(axis=1)
    cheap = (unmet <= 1e-9) & (import_cost / rte + GRID_SPREAD_USD_PER_MWH < value)
    return np.where(cheap, np.maximum(import_limit - imports, 0.0), 0.0), tiers


def _surplus_ahead(net: np.ndarray, p_max: float, eta: float) -> np.ndarray:
    """MWh of renewable surplus the battery could store over the next LOOKAHEAD_H hours."""
    storable = np.minimum(np.maximum(-net, 0.0), p_max) * eta
    c = np.concatenate([[0.0], np.cumsum(storable)])
    n = net.shape[0]
    idx = np.arange(n)
    return c[np.minimum(idx + 1 + LOOKAHEAD_H, n)] - c[idx + 1]


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------


def dispatch(fleet: Fleet, drivers: Drivers, initial_soc_frac: float | None = None) -> Dispatch:
    """Dispatch one year (or any n hours). See the module docstring for the rules.

    initial_soc_frac: None -> cyclic year (two passes, see rule 5); a value in [0, 1]
    -> a single pass starting at that fraction of batt_mwh.
    """
    demand = np.asarray(drivers.demand_mw, dtype=float)
    if demand.ndim != 1:
        raise ValueError(f"demand_mw: expected a 1-D hourly array, got shape {demand.shape}")
    n = demand.shape[0]
    demand = _hourly(demand, n, "demand_mw", nonneg=True)
    solar_cf = np.clip(_hourly(drivers.solar_cf, n, "solar_cf", nonneg=False), 0.0, 1.0)
    wind_cf = np.clip(_hourly(drivers.wind_cf, n, "wind_cf", nonneg=False), 0.0, 1.0)
    import_cost = _hourly(drivers.import_cost_usd_per_mwh, n, "import_cost_usd_per_mwh", nonneg=False)
    export_price = _hourly(drivers.export_price_usd_per_mwh, n, "export_price_usd_per_mwh", nonneg=False)
    cc_cost = _hourly(drivers.gas_cc_cost_usd_per_mwh, n, "gas_cc_cost_usd_per_mwh", nonneg=False)
    ct_cost = _hourly(drivers.gas_ct_cost_usd_per_mwh, n, "gas_ct_cost_usd_per_mwh", nonneg=False)

    cc_avail = _hourly(fleet.gas_cc_mw, n, "gas_cc_mw", nonneg=True)
    ct_avail = _hourly(fleet.gas_ct_mw, n, "gas_ct_mw", nonneg=True)
    p_max = _scalar(fleet.batt_mw, "batt_mw")
    e_max = _scalar(fleet.batt_mwh, "batt_mwh")
    import_limit = _scalar(fleet.import_limit_mw, "import_limit_mw")
    export_limit = _scalar(fleet.export_limit_mw, "export_limit_mw")
    rte = float(fleet.rte)
    if not 0.0 < rte <= 1.0:
        raise ValueError(f"rte: must be in (0, 1], got {fleet.rte!r}")
    eta = math.sqrt(rte)

    if initial_soc_frac is None:
        frac = DEFAULT_INITIAL_SOC_FRAC
    else:
        frac = float(initial_soc_frac)
        if not 0.0 <= frac <= 1.0:
            raise ValueError(f"initial_soc_frac: must be in [0, 1], got {initial_soc_frac!r}")

    # 1. Renewables (must-take). net > 0 is a deficit, net < 0 a surplus.
    solar = _scalar(fleet.solar_mw, "solar_mw") * solar_cf
    wind = _scalar(fleet.wind_mw, "wind_mw") * wind_cf
    net = demand - solar - wind

    # 4/5. Battery. batt_mwh = 0 or batt_mw = 0 means nothing moves (SOC stays put).
    soc0 = frac * e_max
    if p_max > 0.0 and e_max > 0.0 and n > 0:
        net_list = net.tolist()
        priced: tuple = ()
        if fleet.grid_charging and import_limit > 0.0:
            spare, tiers = _spare_import_when_cheap(net, import_cost, cc_cost, ct_cost, cc_avail, ct_avail, import_limit, rte, e_max / p_max)
            priced = (spare.tolist(), import_cost.tolist(), tiers, _surplus_ahead(net, p_max, eta).tolist())
        ch, gc, dis, soc = _battery_pass(net_list, p_max, e_max, eta, soc0, *priced)
        if initial_soc_frac is None:  # cyclic: restart from the year-end SOC
            soc0 = soc[-1]
            ch, gc, dis, soc = _battery_pass(net_list, p_max, e_max, eta, soc0, *priced)
        charge, grid_charge, discharge, soc_mwh = np.array(ch), np.array(gc), np.array(dis), np.array(soc)
    else:
        charge, grid_charge, discharge, soc_mwh = np.zeros(n), np.zeros(n), np.zeros(n), np.full(n, soc0)

    # 2. Surplus left after charging from it: export at a non-negative price, else curtail.
    spill = np.maximum(-net, 0.0) - (charge - grid_charge)
    exports, _ = _take(spill, export_limit, export_price >= 0.0)
    curtailed = spill - exports

    # 3. Deficit left after discharging: merit order with CC always before CT.
    need = np.maximum(net, 0.0) - discharge
    gas_cc, gas_ct, imports, need, _ = _merit_order(need, import_cost, cc_cost, ct_cost, cc_avail, ct_avail, import_limit)
    imports = imports + grid_charge  # rule 6 picked only hours with this much spare capacity

    return Dispatch(
        generation_mw={"solar_pv": solar, "onshore_wind": wind, "gas_cc": gas_cc, "gas_ct": gas_ct},
        charge_mw=charge,
        discharge_mw=discharge,
        soc_mwh=soc_mwh,
        imports_mw=imports,
        exports_mw=exports,
        unmet_mw=need,
        curtailed_mw=curtailed,
        initial_soc_mwh=float(soc0),
        grid_charge_mw=grid_charge,
    )
