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
   prices are known that far ahead. In a cheap hour the battery charges from import
   capacity left over after serving demand, so imports never exceed the limit, and it
   never imports to charge while spilling surplus or into room the renewable surplus of
   the next 24 h will need. A cheap deficit hour that cannot charge (battery full, or its
   room kept for that surplus) holds the stored energy for the dear hours ahead, but
   delivers now whatever exceeds the carry limit (_carry_limit: the most the battery can
   keep without curtailing surplus within 24 h), unless unserved load lies that close. The
   battery tracks the average cost of what it holds (renewable surplus = 0, grid energy
   = import cost / eta). A discharge displaces the stack from the top (unmet, then back
   down the merit order), so it is capped at the MW of the tiers above the stored
   energy's cost: grid-charged energy displaces imports, CT or unserved load, never
   cheaper gas, even when a user prices CT below CC.
   Every rule 6 decision for hour t uses inputs up to t + LOOKAHEAD_H only.
   Safety net: the rules above are a heuristic, not an optimum, so for a cyclic year
   dispatch() also runs the year without grid charging and keeps the grid-charging
   result only if its cost (imports + gas - export revenue + VOLL x unmet) is not
   higher. Dispatch.grid_charging records which one it kept.

Balance every hour t (exact to float rounding):
    demand = sum(generation) + discharge + imports + unmet - charge - exports - curtailed

Only the battery state is sequential: that loop runs over Python floats; everything
else is vectorized. A cyclic year with grid charging runs it four times (with and
without grid charging, two passes each): ~15 ms for 8,784 h on a laptop.
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
EPS_MW = 1e-9  # below this a tier counts as not serving


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
    # Rule 6 policy this dispatch followed: False when Fleet.grid_charging is off or the safety
    # net kept the plain year. A rerun of part of this year sets Fleet.grid_charging to it.
    grid_charging: bool = False


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
    carry_max: list[float] | None = None,
) -> tuple[list[float], list[float], list[float], list[float]]:
    """Greedy charge on surplus (net < 0) / discharge on deficit (net > 0) for one year.

    With grid charging (rule 6), spare_import[t] > 0 marks a cheap hour: charge up to
    that many MW from imports at import_cost[t], leaving room for the renewable surplus
    expected over the next 24 h (surplus_ahead[t], MWh storable) so it never displaces
    free solar. A cheap deficit hour that cannot charge delivers only the stored energy
    above carry_max[t]. Once grid energy is stored, a discharge is capped at the MW of
    tiers[t] = [(cost, mw), ...] (last-dispatched first; unserved load at VOLL) that
    cost more than the stored energy.
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
    cost_in = import_cost if priced else spare
    room_for = surplus_ahead if priced else spare
    keep = carry_max if priced else spare
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
        d = 0.0
        if spare[t] > 0.0:  # cheap hour: top up from spare import capacity
            g = min(spare[t], p_max - c, (e_max - e - room_for[t]) / eta)
            if g > 0.0:
                grid[t] = g
                charge[t] = c + g
                e = min(e + g * eta, e_max)
                basis += g * cost_in[t]
            elif x > 0.0:  # can't charge: hold, but deliver what surplus ahead would spill anyway
                d = min(x, p_max, (e - keep[t]) * eta)
        elif x > 0.0:  # deficit: deliver what the SOC allows
            d = min(x, p_max, e * eta)
        if d > 0.0 and basis > 0.0:  # ... and only where it beats what the stored energy cost
            unit = basis / (e * eta)  # $ per delivered MWh of what is stored
            cap = 0.0
            for cost, mw in tiers[t]:
                if cost <= unit:
                    break
                cap += mw
            d = min(d, cap)
        if d > 0.0:
            discharge[t] = d
            e_new = max(e - d / eta, 0.0)
            basis *= e_new / e
            e = e_new
        soc[t] = e
    return charge, grid, discharge, soc


def _carry_limit(fill: np.ndarray, drain: np.ndarray, holds_at: np.ndarray, value: np.ndarray, e_max: float) -> np.ndarray:
    """Rule 6 release: the most MWh the battery can hold at the end of hour t without
    having to curtail surplus within the next LOOKAHEAD_H hours.

    Walks hours t+LOOKAHEAD_H .. t+1 backwards (vectorized over t) under the battery's own
    policy: a surplus hour fills it by fill (curtailable surplus only: exportable surplus
    still earns the export price, so stored energy is never given away to make room for
    it) and a deficit hour drains it by drain, unless it holds: holds_at[k] (the cost at
    which hour k would count as cheap, NaN if never) is below value[t], hour t's own
    yardstick. Only inputs up to t+LOOKAHEAD_H are used, so a window rerun that sees
    LOOKAHEAD_H hours past its end reproduces the year.
    """
    n = fill.shape[0]

    def pad(a: np.ndarray, past_end: float) -> np.ndarray:
        return np.concatenate([a, np.full(LOOKAHEAD_H + 1, past_end)])

    fill_p, drain_p, holds_p = pad(fill, 0.0), pad(drain, 0.0), pad(holds_at, np.nan)
    h = np.full(n, e_max)  # past the window nothing constrains the battery
    for j in range(LOOKAHEAD_H, 0, -1):
        k = slice(j, j + n)  # hour t + j for every t
        holds = holds_p[k] < value  # NaN compares False
        h = np.clip(h - fill_p[k] + np.where(holds, 0.0, drain_p[k]), 0.0, e_max)
    return h


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
    Returns (gas_cc, gas_ct, imports, unmet, stack), where stack lists (served MW, $/MWh)
    per tier in dispatch order, ending with unmet at VOLL.
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
    voll = np.full_like(need, VOLL_USD_PER_MWH)
    stack = ((imp_a, import_cost), (gas_cc, cc_cost), (imp_b, import_cost), (gas_ct, ct_cost), (imp_c, import_cost), (need, voll))
    return gas_cc, gas_ct, imports, need, stack


def _rule6_inputs(net, import_cost, cc_cost, ct_cost, cc_avail, ct_avail, import_limit, export_cap, rte, p_max, e_max):
    """Everything _battery_pass needs for rule 6, as Python lists: (spare import MW in
    cheap hours else 0, import cost, per-hour tiers last-dispatched first, renewable
    surplus storable over the next 24 h, carry limit)."""
    n = net.shape[0]
    eta = math.sqrt(rte)
    _, _, imports, unmet, stack = _merit_order(np.maximum(net, 0.0), import_cost, cc_cost, ct_cost, cc_avail, ct_avail, import_limit)
    # Each hour's value to the battery is the cost of the last tier serving it: that is what
    # the battery's first MW displaces (CT, when a user prices CT below CC, though CC also runs).
    marginal = np.zeros(n)
    for served, cost in stack:
        marginal = np.where(served > EPS_MW, cost, marginal)
    top = [(c.tolist(), s.tolist()) for s, c in reversed(stack)]
    tiers = [[(c, m) for c, m in hour if m > EPS_MW] for hour in zip(*(zip(c, s) for c, s in top))]

    k = int(min(LOOKAHEAD_H, max(1, round(e_max / p_max))))  # battery duration, h

    def ahead(a: np.ndarray) -> np.ndarray:  # row t = a[t+1 .. t+LOOKAHEAD_H], zero past the end
        return np.lib.stride_tricks.sliding_window_view(np.concatenate([a[1:], np.zeros(LOOKAHEAD_H)]), LOOKAHEAD_H)[:n]

    value = np.partition(ahead(marginal), LOOKAHEAD_H - k, axis=1)[:, LOOKAHEAD_H - k :].mean(axis=1)
    buy_cost = import_cost / rte + GRID_SPREAD_USD_PER_MWH  # $ per delivered MWh of grid charging
    can_buy = (unmet <= EPS_MW) & (imports < import_limit)  # firm covers the hour with import headroom
    spare = np.where(can_buy & (buy_cost < value), import_limit - imports, 0.0)

    fill = np.minimum(np.maximum(-net - export_cap, 0.0), p_max) * eta
    drain = np.minimum(np.maximum(net, 0.0), p_max) / eta
    carry = _carry_limit(fill, drain, np.where(can_buy, buy_cost, np.nan), value, e_max)
    carry = np.where((ahead(unmet) > EPS_MW).any(axis=1), math.inf, carry)  # unserved load ahead: hold all
    return spare.tolist(), import_cost.tolist(), tiers, _surplus_ahead(net, p_max, eta).tolist(), carry.tolist()


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

    initial_soc_frac: None -> cyclic year (two passes, see rule 5) with the rule 6 safety
    net; a value in [0, 1] -> a single pass starting at that fraction of batt_mwh that
    follows Fleet.grid_charging as given (a window continuing a year, like a stress rerun,
    sets it to the year's Dispatch.grid_charging and passes LOOKAHEAD_H hours past its end).
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
    net_list = net.tolist()
    export_cap = np.where(export_price >= 0.0, export_limit, 0.0)  # exportable MW each hour
    # batt_mwh = 0 or batt_mw = 0 means nothing moves (SOC stays put).
    storage = p_max > 0.0 and e_max > 0.0 and n > 0

    def settle(priced: tuple) -> Dispatch:
        """Rules 4/5 (battery, cyclic), then 2 (surplus left) and 3 (deficit left)."""
        soc0 = frac * e_max
        if storage:
            ch, gc, dis, soc = _battery_pass(net_list, p_max, e_max, eta, soc0, *priced)
            if initial_soc_frac is None:  # cyclic: restart from the year-end SOC
                soc0 = soc[-1]
                ch, gc, dis, soc = _battery_pass(net_list, p_max, e_max, eta, soc0, *priced)
            charge, grid_charge, discharge, soc_mwh = np.array(ch), np.array(gc), np.array(dis), np.array(soc)
        else:
            charge, grid_charge, discharge, soc_mwh = np.zeros(n), np.zeros(n), np.zeros(n), np.full(n, soc0)

        # 2. Surplus left after charging from it: export at a non-negative price, else curtail.
        # Clamped: (c + g) - g is not exactly c in floats, and exports must never go negative.
        spill = np.maximum(np.maximum(-net, 0.0) - (charge - grid_charge), 0.0)
        exports = np.minimum(spill, export_cap)
        curtailed = spill - exports

        # 3. Deficit left after discharging: merit order with CC always before CT.
        need = np.maximum(net, 0.0) - discharge
        gas_cc, gas_ct, imports, unmet, _ = _merit_order(need, import_cost, cc_cost, ct_cost, cc_avail, ct_avail, import_limit)
        return Dispatch(
            generation_mw={"solar_pv": solar, "onshore_wind": wind, "gas_cc": gas_cc, "gas_ct": gas_ct},
            charge_mw=charge,
            discharge_mw=discharge,
            soc_mwh=soc_mwh,
            imports_mw=imports + grid_charge,  # rule 6 picked only hours with this much spare capacity
            exports_mw=exports,
            unmet_mw=unmet,
            curtailed_mw=curtailed,
            initial_soc_mwh=float(soc0),
            grid_charge_mw=grid_charge,
        )

    if not (fleet.grid_charging and import_limit > 0.0 and storage):
        return settle(())
    rule6 = _rule6_inputs(net, import_cost, cc_cost, ct_cost, cc_avail, ct_avail, import_limit, export_cap, rte, p_max, e_max)
    priced = settle(rule6)
    priced.grid_charging = True
    if initial_soc_frac is not None:  # a single pass follows the fleet's policy as given
        return priced

    def cost(d: Dispatch) -> float:  # rule 6 safety net: energy cost with unserved load at VOLL
        g = d.generation_mw
        firm = d.imports_mw @ import_cost + g["gas_cc"] @ cc_cost + g["gas_ct"] @ ct_cost
        return float(firm - d.exports_mw @ export_price + VOLL_USD_PER_MWH * d.unmet_mw.sum())

    plain = settle(())
    return priced if cost(priced) <= cost(plain) else plain
