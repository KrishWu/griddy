"""Unit tests for the dispatch core (app/simulate/dispatch.py).  OWNER: workstream B.

One test per dispatch rule on small hand-computed cases, then a randomized property
test over many seeds, a check on the real preset inputs, and a performance check on a
full leap year.
"""

from __future__ import annotations

import dataclasses
import math
import time
import warnings

import numpy as np
import pytest

from app.simulate import dispatch as dispatch_module
from app.simulate.dispatch import GENERATION_KEYS, VOLL_USD_PER_MWH, Dispatch, Drivers, Fleet, dispatch

TOL = 1e-6
ETA = 0.9  # tests use rte = 0.81 so eta_c = eta_d = 0.9 exactly


def drivers(
    demand,
    solar_cf=0.0,
    wind_cf=0.0,
    import_cost=50.0,
    export_price=20.0,
    cc_cost=30.0,
    ct_cost=45.0,
) -> Drivers:
    """Build Drivers from scalars or lists, broadcasting scalars to len(demand)."""
    d = np.asarray(demand, dtype=float)

    def arr(x):
        return np.broadcast_to(np.asarray(x, dtype=float), d.shape).copy()

    return Drivers(
        demand_mw=d,
        solar_cf=arr(solar_cf),
        wind_cf=arr(wind_cf),
        import_cost_usd_per_mwh=arr(import_cost),
        export_price_usd_per_mwh=arr(export_price),
        gas_cc_cost_usd_per_mwh=cc_cost,
        gas_ct_cost_usd_per_mwh=ct_cost,
    )


def assert_invariants(fleet: Fleet, drv: Drivers, d: Dispatch) -> None:
    """Every contract invariant plus the dispatch-order rules, checked hour by hour."""
    n = len(drv.demand_mw)
    assert set(d.generation_mw) == set(GENERATION_KEYS)
    series = [*d.generation_mw.values(), d.charge_mw, d.discharge_mw, d.soc_mwh]
    series += [d.imports_mw, d.exports_mw, d.unmet_mw, d.curtailed_mw]
    for s in series:
        assert s.shape == (n,)
        assert np.isfinite(s).all()
        assert (s >= 0.0).all(), "flows and SOC are never negative, not even by float residue"
    assert math.isfinite(d.initial_soc_mwh)

    g = d.generation_mw
    supply = sum(g.values()) + d.discharge_mw + d.imports_mw + d.unmet_mw
    sinks = d.charge_mw + d.exports_mw + d.curtailed_mw
    assert np.abs(drv.demand_mw - (supply - sinks)).max(initial=0) < TOL

    # Capacities and limits.
    np.testing.assert_allclose(g["solar_pv"], fleet.solar_mw * np.clip(drv.solar_cf, 0, 1), atol=TOL)
    np.testing.assert_allclose(g["onshore_wind"], fleet.wind_mw * np.clip(drv.wind_cf, 0, 1), atol=TOL)
    cc_avail = np.broadcast_to(np.asarray(fleet.gas_cc_mw, dtype=float), (n,))
    ct_avail = np.broadcast_to(np.asarray(fleet.gas_ct_mw, dtype=float), (n,))
    assert (g["gas_cc"] <= cc_avail + TOL).all()
    assert (g["gas_ct"] <= ct_avail + TOL).all()
    assert (d.imports_mw <= fleet.import_limit_mw + TOL).all()
    assert (d.exports_mw <= fleet.export_limit_mw + TOL).all()
    assert (d.charge_mw <= fleet.batt_mw + TOL).all()
    assert (d.discharge_mw <= fleet.batt_mw + TOL).all()

    # Battery physics.
    assert (d.soc_mwh <= fleet.batt_mwh + TOL).all()
    assert not ((d.charge_mw > TOL) & (d.discharge_mw > TOL)).any()
    eta = math.sqrt(fleet.rte)
    prev = np.concatenate([[d.initial_soc_mwh], d.soc_mwh[:-1]])
    np.testing.assert_allclose(d.soc_mwh, prev + d.charge_mw * eta - d.discharge_mw / eta, atol=TOL)

    # Order rules.
    net = drv.demand_mw - g["solar_pv"] - g["onshore_wind"]
    storage = fleet.batt_mw > 0 and fleet.batt_mwh > 0
    grid = np.zeros(n) if d.grid_charge_mw is None else d.grid_charge_mw
    firm = g["gas_cc"] + g["gas_ct"] + d.imports_mw - grid  # firm supply serving demand
    assert (d.exports_mw[drv.export_price_usd_per_mwh < 0] <= TOL).all(), "never export at a negative price"
    if not fleet.grid_charging:
        assert (grid <= TOL).all()
        assert (d.charge_mw[net >= 0] <= TOL).all(), "battery charges only from renewable surplus"
    else:  # rule 6
        assert (grid <= d.charge_mw + TOL).all() and (grid <= d.imports_mw + TOL).all()
        assert (grid[d.exports_mw + d.curtailed_mw > TOL] <= TOL).all(), "never import to charge while spilling"
        assert (d.charge_mw[net >= 0] <= grid[net >= 0] + TOL).all(), "deficit-hour charging comes from imports"
    assert (firm[net <= 0] <= TOL).all(), "no gas or imports serving demand in a surplus hour"
    assert (g["gas_cc"][net <= 0] + g["gas_ct"][net <= 0] <= TOL).all(), "gas never charges the battery"
    if storage:
        max_charge = np.minimum(fleet.batt_mw, (fleet.batt_mwh - prev) / eta)
        max_discharge = np.minimum(fleet.batt_mw, prev * eta)
        spilled = d.exports_mw + d.curtailed_mw > TOL
        assert (d.charge_mw[spilled] >= max_charge[spilled] - TOL).all(), "charge before export/curtail"
        short = (firm + d.unmet_mw > TOL) if not fleet.grid_charging else (d.unmet_mw > TOL)
        assert (d.discharge_mw[short] >= max_discharge[short] - TOL).all(), "discharge before firm (always before unmet)"
    curtail_ok = (d.curtailed_mw > TOL) & (drv.export_price_usd_per_mwh >= 0)
    assert (d.exports_mw[curtail_ok] >= fleet.export_limit_mw - TOL).all(), "export before curtail"

    cc_full = g["gas_cc"] >= cc_avail - TOL
    ct_full = g["gas_ct"] >= ct_avail - TOL
    serving = d.imports_mw - grid  # imports serving demand (rule 6 charging rides on top)
    imp_full = d.imports_mw >= fleet.import_limit_mw - TOL
    assert cc_full[g["gas_ct"] > TOL].all(), "gas CC before gas CT"
    unmet = d.unmet_mw > TOL
    assert (cc_full & ct_full & imp_full)[unmet].all(), "unmet only once everything is exhausted"
    cc_cost = np.broadcast_to(np.asarray(drv.gas_cc_cost_usd_per_mwh, dtype=float), (n,))
    ct_cost = np.maximum(cc_cost, drv.gas_ct_cost_usd_per_mwh)
    imp_cost = drv.import_cost_usd_per_mwh
    assert imp_full[(g["gas_cc"] > TOL) & (imp_cost < cc_cost)].all(), "cheaper imports before CC"
    assert imp_full[(g["gas_ct"] > TOL) & (imp_cost < ct_cost)].all(), "cheaper imports before CT"
    assert cc_full[(serving > TOL) & (imp_cost >= cc_cost)].all(), "CC before dearer imports"
    assert ct_full[(serving > TOL) & (imp_cost >= ct_cost)].all(), "CT before dearer imports"


# ---------------------------------------------------------------------------
# Rule 1: renewables
# ---------------------------------------------------------------------------


def test_renewables_scale_nameplate_by_clipped_cf():
    fleet = Fleet(solar_mw=100, wind_mw=50, import_limit_mw=1000)
    drv = drivers([500, 500, 500], solar_cf=[-0.1, 0.5, 1.2], wind_cf=[0.2, float("1e9"), -3])
    d = dispatch(fleet, drv)
    np.testing.assert_allclose(d.generation_mw["solar_pv"], [0, 50, 100])
    np.testing.assert_allclose(d.generation_mw["onshore_wind"], [10, 50, 0])
    np.testing.assert_allclose(d.imports_mw, [490, 400, 400])
    assert_invariants(fleet, drv, d)


def test_generation_always_has_all_four_keys():
    d = dispatch(Fleet(), drivers([0.0, 0.0]))
    assert list(d.generation_mw) == list(GENERATION_KEYS)
    for v in d.generation_mw.values():
        np.testing.assert_array_equal(v, [0, 0])


def test_curtailed_output_still_counts_as_generation():
    fleet = Fleet(solar_mw=100)
    drv = drivers([40], solar_cf=1.0)
    d = dispatch(fleet, drv)
    assert d.generation_mw["solar_pv"][0] == pytest.approx(100)
    assert d.curtailed_mw[0] == pytest.approx(60)
    assert_invariants(fleet, drv, d)


# ---------------------------------------------------------------------------
# Rule 2: surplus -> charge, then export (price >= 0), then curtail
# ---------------------------------------------------------------------------


def test_surplus_charges_then_exports_then_curtails():
    # Surplus 70 MW: charge min(70, 20 MW, 100/0.9) = 20 (stores 18 MWh); export 30 (limit); curtail 20.
    fleet = Fleet(solar_mw=100, batt_mw=20, batt_mwh=100, rte=0.81, export_limit_mw=30)
    drv = drivers([30], solar_cf=1.0, export_price=25.0)
    d = dispatch(fleet, drv, initial_soc_frac=0.0)
    assert d.charge_mw[0] == pytest.approx(20)
    assert d.soc_mwh[0] == pytest.approx(18)
    assert d.exports_mw[0] == pytest.approx(30)
    assert d.curtailed_mw[0] == pytest.approx(20)
    assert_invariants(fleet, drv, d)


def test_charge_limited_by_headroom():
    # SOC 95 of 100 MWh: room = 5 / 0.9 = 5.556 MW of charge; the rest (no export limit) is curtailed.
    fleet = Fleet(solar_mw=100, batt_mw=50, batt_mwh=100, rte=0.81)
    drv = drivers([0], solar_cf=1.0)
    d = dispatch(fleet, drv, initial_soc_frac=0.95)
    assert d.charge_mw[0] == pytest.approx(5 / ETA)
    assert d.soc_mwh[0] == pytest.approx(100)
    assert d.curtailed_mw[0] == pytest.approx(100 - 5 / ETA)
    assert_invariants(fleet, drv, d)


def test_never_export_at_negative_price():
    fleet = Fleet(solar_mw=100, export_limit_mw=1000)
    drv = drivers([40, 40, 40], solar_cf=1.0, export_price=[-5.0, 0.0, 10.0])
    d = dispatch(fleet, drv)
    np.testing.assert_allclose(d.exports_mw, [0, 60, 60])
    np.testing.assert_allclose(d.curtailed_mw, [60, 0, 0])
    assert_invariants(fleet, drv, d)


def test_battery_never_charges_from_grid_or_gas():
    # Deficit hours with idle cheap gas and imports: the empty battery stays empty.
    fleet = Fleet(gas_cc_mw=500, import_limit_mw=500, batt_mw=100, batt_mwh=400)
    drv = drivers([50, 50, 50], import_cost=-20.0)
    d = dispatch(fleet, drv, initial_soc_frac=0.0)
    np.testing.assert_array_equal(d.charge_mw, 0)
    np.testing.assert_array_equal(d.soc_mwh, 0)
    assert_invariants(fleet, drv, d)


# ---------------------------------------------------------------------------
# Rule 3: deficit -> discharge, then firm in merit order, then unmet
# ---------------------------------------------------------------------------


def test_deficit_discharges_then_cc_then_ct_then_imports_then_unmet():
    # Deficit 100: discharge min(100, 30, 100*0.9) = 30 (SOC 100 -> 66.67), CC 40, CT 20,
    # imports (cost 100, dearer than both) 5 = limit, unmet 5.
    fleet = Fleet(gas_cc_mw=40, gas_ct_mw=20, batt_mw=30, batt_mwh=100, rte=0.81, import_limit_mw=5)
    drv = drivers([100], import_cost=100.0)
    d = dispatch(fleet, drv, initial_soc_frac=1.0)
    assert d.discharge_mw[0] == pytest.approx(30)
    assert d.soc_mwh[0] == pytest.approx(100 - 30 / ETA)
    assert d.generation_mw["gas_cc"][0] == pytest.approx(40)
    assert d.generation_mw["gas_ct"][0] == pytest.approx(20)
    assert d.imports_mw[0] == pytest.approx(5)
    assert d.unmet_mw[0] == pytest.approx(5)
    assert_invariants(fleet, drv, d)


def test_discharge_limited_by_soc():
    # SOC 10 MWh delivers at most 10 * 0.9 = 9 MW, leaving the battery empty.
    fleet = Fleet(batt_mw=50, batt_mwh=100, rte=0.81, gas_cc_mw=100)
    drv = drivers([40])
    d = dispatch(fleet, drv, initial_soc_frac=0.1)
    assert d.discharge_mw[0] == pytest.approx(9)
    assert d.soc_mwh[0] == pytest.approx(0, abs=1e-9)
    assert d.generation_mw["gas_cc"][0] == pytest.approx(31)
    assert_invariants(fleet, drv, d)


def test_imports_take_their_place_in_merit_order():
    # Deficit 100 each hour; CC 40 @ $30, CT 40 @ $45, imports limit 40 at varying cost.
    fleet = Fleet(gas_cc_mw=40, gas_ct_mw=40, import_limit_mw=40)
    costs = [20.0, 40.0, 30.0, 45.0, 100.0]
    drv = drivers([100] * 5, import_cost=costs)
    d = dispatch(fleet, drv)
    # $20: before CC. $40: between CC and CT. $30 (ties CC): after CC, still before CT.
    # $45 (ties CT) and $100: last.
    np.testing.assert_allclose(d.imports_mw, [40, 40, 40, 20, 20])
    np.testing.assert_allclose(d.generation_mw["gas_cc"], [40, 40, 40, 40, 40])
    np.testing.assert_allclose(d.generation_mw["gas_ct"], [20, 20, 20, 40, 40])
    np.testing.assert_array_equal(d.unmet_mw, 0)
    assert_invariants(fleet, drv, d)

    # Tie-break with CC: at equal cost CC serves first; one dollar cheaper and imports lead.
    fleet = Fleet(gas_cc_mw=100, import_limit_mw=40)
    drv = drivers([100, 100], import_cost=[30.0, 29.0])
    d = dispatch(fleet, drv)
    np.testing.assert_allclose(d.generation_mw["gas_cc"], [100, 60])
    np.testing.assert_allclose(d.imports_mw, [0, 40])
    assert_invariants(fleet, drv, d)

    # Cheap imports with spare headroom displace gas entirely.
    fleet = Fleet(gas_cc_mw=40, gas_ct_mw=40, import_limit_mw=500)
    drv = drivers([100], import_cost=10.0)
    d = dispatch(fleet, drv)
    assert d.imports_mw[0] == pytest.approx(100)
    assert d.generation_mw["gas_cc"][0] == 0 and d.generation_mw["gas_ct"][0] == 0


def test_gas_cc_runs_before_ct_even_when_ct_is_cheaper():
    fleet = Fleet(gas_cc_mw=60, gas_ct_mw=60, import_limit_mw=100)
    drv = drivers([80], import_cost=100.0, cc_cost=60.0, ct_cost=40.0)
    d = dispatch(fleet, drv)
    assert d.generation_mw["gas_cc"][0] == pytest.approx(60)
    assert d.generation_mw["gas_ct"][0] == pytest.approx(20)
    assert d.imports_mw[0] == pytest.approx(0)
    assert_invariants(fleet, drv, d)

    # Imports at $50 undercut CC ($60) but not CT ($40). CT can never run ahead of CC,
    # so imports that beat CC lead the whole stack.
    drv = drivers([80], import_cost=50.0, cc_cost=60.0, ct_cost=40.0)
    d = dispatch(fleet, drv)
    assert d.imports_mw[0] == pytest.approx(80)
    assert d.generation_mw["gas_cc"][0] == 0 and d.generation_mw["gas_ct"][0] == 0
    assert_invariants(fleet, drv, d)


def test_hourly_gas_availability_caps_generation():
    # Derates/outages: CC available 100, 50, 0 MW; CT 30 MW nameplate covers what it can.
    fleet = Fleet(gas_cc_mw=np.array([100.0, 50.0, 0.0]), gas_ct_mw=30)
    drv = drivers([80, 80, 80])
    d = dispatch(fleet, drv)
    np.testing.assert_allclose(d.generation_mw["gas_cc"], [80, 50, 0])
    np.testing.assert_allclose(d.generation_mw["gas_ct"], [0, 30, 30])
    np.testing.assert_allclose(d.unmet_mw, [0, 0, 50])
    assert_invariants(fleet, drv, d)


# ---------------------------------------------------------------------------
# Rule 4: battery physics
# ---------------------------------------------------------------------------


def test_round_trip_efficiency_and_soc_recursion():
    # 4 h of 10 MW surplus into an empty 10 MW / 40 MWh battery stores 36 MWh;
    # 4 h of 10 MW deficit get back 10 + 10 + 10 + 2.4 = 32.4 MWh = 40 MWh charged x 0.81.
    fleet = Fleet(solar_mw=20, batt_mw=10, batt_mwh=40, rte=0.81)
    drv = drivers([10] * 8, solar_cf=[1, 1, 1, 1, 0, 0, 0, 0])
    d = dispatch(fleet, drv, initial_soc_frac=0.0)
    np.testing.assert_allclose(d.charge_mw, [10, 10, 10, 10, 0, 0, 0, 0])
    np.testing.assert_allclose(d.soc_mwh[:4], [9, 18, 27, 36])
    np.testing.assert_allclose(d.discharge_mw, [0, 0, 0, 0, 10, 10, 10, 2.4])
    assert d.soc_mwh[-1] == pytest.approx(0, abs=1e-9)
    assert d.discharge_mw.sum() == pytest.approx(d.charge_mw.sum() * 0.81)
    np.testing.assert_allclose(d.unmet_mw, [0, 0, 0, 0, 0, 0, 0, 7.6])
    assert_invariants(fleet, drv, d)


def test_no_simultaneous_charge_and_discharge():
    # Alternating surplus/deficit every hour with a battery that could do either.
    n = 48
    fleet = Fleet(solar_mw=200, batt_mw=50, batt_mwh=200, gas_cc_mw=100)
    drv = drivers(np.full(n, 100.0), solar_cf=np.tile([1.0, 0.0], n // 2))
    d = dispatch(fleet, drv)
    assert (d.charge_mw > 0).any() and (d.discharge_mw > 0).any()
    assert not ((d.charge_mw > 0) & (d.discharge_mw > 0)).any()
    assert_invariants(fleet, drv, d)


def test_soc_stays_within_bounds():
    rng = np.random.default_rng(7)
    n = 300
    fleet = Fleet(solar_mw=500, batt_mw=400, batt_mwh=600, rte=0.9)
    drv = drivers(rng.uniform(0, 400, n), solar_cf=rng.uniform(0, 1, n))
    d = dispatch(fleet, drv)
    assert d.soc_mwh.min() >= -TOL and d.soc_mwh.max() <= 600 + TOL
    assert d.soc_mwh.max() == pytest.approx(600) and d.soc_mwh.min() == pytest.approx(0, abs=1e-6)
    assert_invariants(fleet, drv, d)


# ---------------------------------------------------------------------------
# Rule 5: cyclic year
# ---------------------------------------------------------------------------


def test_cyclic_year_restarts_from_first_pass_end():
    # 30 identical days: sunny 08-16, deficit otherwise. The year should close on itself.
    day_cf = np.where((np.arange(24) >= 8) & (np.arange(24) < 16), 1.0, 0.0)
    fleet = Fleet(solar_mw=300, batt_mw=80, batt_mwh=320, gas_cc_mw=100)
    drv = drivers(np.full(24 * 30, 100.0), solar_cf=np.tile(day_cf, 30))
    first = dispatch(fleet, drv, initial_soc_frac=0.5)
    cyclic = dispatch(fleet, drv)
    assert first.initial_soc_mwh == pytest.approx(160)
    assert cyclic.initial_soc_mwh == pytest.approx(first.soc_mwh[-1])
    assert cyclic.soc_mwh[-1] == pytest.approx(cyclic.initial_soc_mwh, abs=1e-6)
    assert_invariants(fleet, drv, cyclic)


def test_explicit_initial_soc_is_a_single_pass():
    fleet = Fleet(batt_mw=10, batt_mwh=100, gas_cc_mw=100)
    drv = drivers([5, 5])
    d = dispatch(fleet, drv, initial_soc_frac=0.25)
    assert d.initial_soc_mwh == pytest.approx(25)
    np.testing.assert_allclose(d.discharge_mw, [5, 5])
    np.testing.assert_allclose(d.soc_mwh, [25 - 5 / math.sqrt(0.85), 25 - 10 / math.sqrt(0.85)])


# ---------------------------------------------------------------------------
# Degenerate inputs and validation
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "fleet",
    [
        Fleet(),
        Fleet(batt_mw=100, batt_mwh=0),  # batt_mwh = 0 means no storage
        Fleet(batt_mw=0, batt_mwh=400),  # no power: energy can't move
        Fleet(solar_mw=0, wind_mw=0, gas_cc_mw=0, gas_ct_mw=0, import_limit_mw=0),
    ],
    ids=["empty", "no-energy", "no-power", "all-zero"],
)
@pytest.mark.parametrize("demand", [0.0, 100.0], ids=["zero-demand", "demand"])
def test_zero_capacity_and_zero_inputs_work(fleet: Fleet, demand: float):
    drv = drivers(np.full(24, demand), solar_cf=0.0, wind_cf=0.0, import_cost=0.0, export_price=0.0)
    with warnings.catch_warnings(), np.errstate(all="raise"):
        warnings.simplefilter("error")
        d = dispatch(fleet, drv)
    np.testing.assert_allclose(d.unmet_mw, demand)
    np.testing.assert_array_equal(d.charge_mw, 0)
    np.testing.assert_array_equal(d.discharge_mw, 0)
    np.testing.assert_allclose(d.soc_mwh, d.initial_soc_mwh)
    assert_invariants(fleet, drv, d)


def test_empty_horizon():
    d = dispatch(Fleet(batt_mw=10, batt_mwh=40), drivers(np.zeros(0)))
    assert d.soc_mwh.shape == (0,) and d.initial_soc_mwh == pytest.approx(20)


@pytest.mark.parametrize(
    ("fleet", "drv", "frac"),
    [
        (
            Fleet(),
            Drivers(np.ones(2), np.ones(3), np.ones(2), np.ones(2), np.ones(2)),
            None,
        ),  # length mismatch
        (Fleet(), Drivers(np.ones((2, 2)), np.ones(2), np.ones(2), np.ones(2), np.ones(2)), None),  # 2-D demand
        (Fleet(), drivers([1.0, float("nan")]), None),  # NaN demand
        (Fleet(), drivers([1.0, -1.0]), None),  # negative demand
        (Fleet(), drivers([1.0], import_cost=float("inf")), None),  # inf price
        (Fleet(gas_cc_mw=np.array([1.0, 2.0, 3.0])), drivers([1.0, 1.0]), None),  # bad hourly capacity
        (Fleet(gas_ct_mw=-5.0), drivers([1.0]), None),  # negative capacity
        (Fleet(rte=0.0), drivers([1.0]), None),
        (Fleet(rte=1.2), drivers([1.0]), None),
        (Fleet(), drivers([1.0]), 1.5),  # SOC fraction out of range
    ],
)
def test_invalid_inputs_raise(fleet: Fleet, drv: Drivers, frac):
    with pytest.raises(ValueError):
        dispatch(fleet, drv, initial_soc_frac=frac)


# ---------------------------------------------------------------------------
# Randomized properties and performance
# ---------------------------------------------------------------------------


def _random_case(seed: int, n: int = 500, grid_charging: bool = False) -> tuple[Fleet, Drivers, float | None]:
    rng = np.random.default_rng(seed)
    hour = np.arange(n) % 24
    sun = np.clip(np.sin(np.pi * (hour - 6) / 12), 0, None)
    has_batt = rng.uniform() > 0.15
    cc_nameplate = rng.uniform(0, 600)
    fleet = Fleet(
        solar_mw=rng.uniform(0, 2500),
        wind_mw=rng.uniform(0, 800),
        # Odd seeds: hourly CC availability with random forced outages and derates.
        gas_cc_mw=cc_nameplate * (rng.uniform(size=n) > 0.1) * rng.uniform(0.8, 1.0, n) if seed % 2 else cc_nameplate,
        gas_ct_mw=rng.uniform(0, 400) if rng.uniform() > 0.2 else 0.0,
        batt_mw=rng.uniform(0, 800) if has_batt else 0.0,
        batt_mwh=rng.uniform(0, 4000) if has_batt else 0.0,
        rte=rng.uniform(0.7, 1.0),
        import_limit_mw=rng.uniform(0, 500) if rng.uniform() > 0.2 else 0.0,
        export_limit_mw=rng.uniform(0, 500) if rng.uniform() > 0.3 else 0.0,
        grid_charging=grid_charging,
    )
    drv = Drivers(
        demand_mw=rng.uniform(0, 1500, n),
        solar_cf=sun * rng.uniform(0.5, 1.15, n) - rng.uniform(0, 0.05, n),  # strays outside [0, 1]
        wind_cf=rng.uniform(-0.05, 1.05, n),
        import_cost_usd_per_mwh=rng.uniform(-20, 150, n),
        export_price_usd_per_mwh=rng.uniform(-40, 120, n),
        gas_cc_cost_usd_per_mwh=float(rng.uniform(20, 80)),
        gas_ct_cost_usd_per_mwh=float(rng.uniform(20, 100)),
    )
    frac = None if seed % 3 else float(rng.uniform())
    return fleet, drv, frac


@pytest.mark.parametrize("seed", range(60))
def test_random_dispatch_invariants(seed: int):
    fleet, drv, frac = _random_case(seed)
    d = dispatch(fleet, drv, initial_soc_frac=frac)
    assert_invariants(fleet, drv, d)
    if frac is not None:
        assert d.initial_soc_mwh == pytest.approx(frac * fleet.batt_mwh)


@pytest.mark.parametrize("seed", range(60))
def test_random_dispatch_invariants_with_grid_charging(seed: int):
    fleet, drv, frac = _random_case(seed, grid_charging=True)
    d = dispatch(fleet, drv, initial_soc_frac=frac)
    assert_invariants(fleet, drv, d)
    if frac is None:  # rule 6 safety net: grid charging never makes a cyclic year dearer
        off = dispatch(_without_grid_charging(fleet), drv)
        assert _energy_cost(d, drv) <= _energy_cost(off, drv) + 1e-9 * abs(_energy_cost(off, drv))


# ---------------------------------------------------------------------------
# Rule 6: price-aware grid charging
# ---------------------------------------------------------------------------


def _arbitrage_day(**fleet_kw) -> tuple[Fleet, Drivers]:
    """Flat 100 MW load, no renewables, 60 MW of CC at $20. Imports: $25 overnight (CC
    serves first, leaving 60 MW of import capacity spare), $30 by day, $200 at 18-22 h."""
    cost = np.full(24, 30.0)
    cost[:6] = 25.0
    cost[18:22] = 200.0
    fleet = Fleet(gas_cc_mw=60.0, batt_mw=50.0, batt_mwh=100.0, rte=0.81, import_limit_mw=100.0, grid_charging=True)
    for k, v in fleet_kw.items():
        setattr(fleet, k, v)
    return fleet, drivers(np.full(24, 100.0), import_cost=cost, cc_cost=20.0)


def _energy_cost(d: Dispatch, drv: Drivers) -> float:
    """Imports + gas - export revenue + unserved load at VOLL (what the safety net compares)."""
    g = d.generation_mw
    return float(
        d.imports_mw @ drv.import_cost_usd_per_mwh
        + (g["gas_cc"] * drv.gas_cc_cost_usd_per_mwh).sum()
        + (g["gas_ct"] * drv.gas_ct_cost_usd_per_mwh).sum()
        - d.exports_mw @ drv.export_price_usd_per_mwh
        + VOLL_USD_PER_MWH * d.unmet_mw.sum()
    )


def _without_grid_charging(fleet: Fleet) -> Fleet:
    return dataclasses.replace(fleet, grid_charging=False)


def test_grid_charging_buys_cheap_and_displaces_dear_imports():
    fleet, drv = _arbitrage_day()
    d = dispatch(fleet, drv, initial_soc_frac=0.0)
    assert_invariants(fleet, drv, d)
    assert d.grid_charge_mw[:6].sum() > 0  # charged from the 40 MW of spare imports overnight
    assert d.discharge_mw[18:22].sum() > 0  # ... and spent in the $200 hours
    # Stored energy costs $25 / 0.81 = $30.9 delivered: not worth spending on $30 hours.
    assert d.discharge_mw[6:18].sum() == pytest.approx(0, abs=TOL)
    off = dispatch(_without_grid_charging(fleet), drv, initial_soc_frac=0.0)
    assert _energy_cost(d, drv) < _energy_cost(off, drv)


def test_no_grid_charging_without_a_profitable_spread():
    fleet, drv = _arbitrage_day()
    drv.import_cost_usd_per_mwh[18:22] = 30.0  # no dear hours ahead: $25 / 0.81 + spread > $30
    d = dispatch(fleet, drv, initial_soc_frac=0.0)
    assert_invariants(fleet, drv, d)
    assert d.grid_charge_mw.sum() == pytest.approx(0, abs=TOL)


def test_grid_charged_energy_never_displaces_cheaper_gas():
    fleet, drv = _arbitrage_day(gas_cc_mw=100.0)  # CC ($20) can carry the whole load
    d = dispatch(fleet, drv, initial_soc_frac=0.0)
    assert_invariants(fleet, drv, d)
    # Imports never serve load here (CC is cheaper and big enough), so anything the battery
    # discharges would displace $20 gas with ~$31 energy: it must not.
    assert d.discharge_mw.sum() == pytest.approx(0, abs=TOL)


def test_grid_charging_leaves_room_for_free_solar():
    n = 48
    hour = np.arange(n) % 24
    solar = np.where((hour >= 9) & (hour < 15), 1.0, 0.0)
    cost = np.where(hour < 6, 10.0, np.where((hour >= 18) & (hour < 22), 200.0, 40.0))
    fleet = Fleet(solar_mw=200.0, gas_cc_mw=100.0, batt_mw=50.0, batt_mwh=100.0, rte=0.81, import_limit_mw=100.0, grid_charging=True)
    drv = drivers(np.full(n, 100.0), solar_cf=solar, import_cost=cost)
    d = dispatch(fleet, drv, initial_soc_frac=0.0)
    assert_invariants(fleet, drv, d)
    assert d.grid_charge_mw.sum() == pytest.approx(0, abs=TOL)  # 6 h x 100 MW surplus fills it for free
    assert d.curtailed_mw.sum() > 0 and d.charge_mw[9:15].sum() > 0


def test_grid_charging_needs_spare_import_capacity():
    fleet, drv = _arbitrage_day(gas_cc_mw=0.0)  # all 100 MW of import capacity serves the load
    d = dispatch(fleet, drv, initial_soc_frac=0.0)
    assert_invariants(fleet, drv, d)
    assert d.grid_charge_mw.sum() == pytest.approx(0, abs=TOL)
    assert d.imports_mw.max() <= fleet.import_limit_mw + TOL


def _solar_week_with_one_dear_hour() -> tuple[Fleet, Drivers]:
    """Flat 100 MW load, 300 MW of solar at 09-15 h (6 h x 200 MW surplus), a 50 MW /
    200 MWh battery and imports at $40 except $200 at 18 h, for 7 days. The $200 hour is
    always within 24 h, so every other hour looks cheap, yet solar fills the battery every
    day and leaves no room to charge from the grid."""
    n = 24 * 7
    hour = np.arange(n) % 24
    fleet = Fleet(solar_mw=300.0, batt_mw=50.0, batt_mwh=200.0, rte=0.81, import_limit_mw=200.0, grid_charging=True)
    drv = drivers(np.full(n, 100.0), solar_cf=np.where((hour >= 9) & (hour < 15), 1.0, 0.0), import_cost=np.where(hour == 18, 200.0, 40.0))
    return fleet, drv


def test_cheap_hours_release_stored_solar_the_next_surplus_would_spill():
    fleet, drv = _solar_week_with_one_dear_hour()
    d = dispatch(fleet, drv)
    off = dispatch(_without_grid_charging(fleet), drv)
    assert_invariants(fleet, drv, d)
    assert d.grid_charge_mw.sum() == pytest.approx(0, abs=TOL)
    # Holding all 180 deliverable MWh through the cheap hours for the one $200 hour would
    # leave 144 MWh in the battery overnight and curtail tomorrow's solar. Instead it
    # delivers 50 + 50 + 30 MW at 15-17 h, keeps 50 MW for 18 h and is empty by morning.
    np.testing.assert_allclose(d.discharge_mw[18::24], 50.0)
    np.testing.assert_allclose(d.soc_mwh[8::24], 0.0, atol=TOL)
    assert d.curtailed_mw.sum() == pytest.approx(off.curtailed_mw.sum())
    # Per day: imports 2,400 - 600 solar - 180 battery = 1,620 MWh, 50 of them at $200.
    # Without grid charging the battery runs dry at 18 h (70 MWh at $200): $76,000.
    daily = (d.imports_mw * drv.import_cost_usd_per_mwh).reshape(7, 24).sum(axis=1)
    np.testing.assert_allclose(daily, 50 * 200 + 1570 * 40)
    assert _energy_cost(off, drv) == pytest.approx(7 * 76_000)


def test_release_waits_while_unserved_load_lies_ahead():
    # Same week, but CC (100 MW @ $30, carrying the rest of the night) is out at 18 h, when
    # a 150 MW peak meets the 100 MW import limit: without the battery 50 MW go unserved.
    # The cheap hours before it then release nothing, and the battery covers the gap.
    fleet, drv = _solar_week_with_one_dear_hour()
    hour = np.arange(drv.demand_mw.size) % 24
    drv.demand_mw[hour == 18] = 150.0
    fleet.import_limit_mw = 100.0
    fleet.gas_cc_mw = np.where(hour == 18, 0.0, 100.0)
    d = dispatch(fleet, drv)
    assert_invariants(fleet, drv, d)
    assert d.discharge_mw.reshape(7, 24)[:, 15:18].sum() == pytest.approx(0, abs=TOL)
    np.testing.assert_allclose(d.discharge_mw[18::24], 50.0)
    assert d.unmet_mw.sum() == pytest.approx(0, abs=TOL)


def test_grid_energy_never_displaces_ct_priced_below_cc():
    # CC 60 MW @ $60 runs before CT 60 MW @ $40 (brief), so a battery discharge displaces CT,
    # the last tier, first. Grid energy bought at $35 costs $35 / 0.81 = $43.2 delivered:
    # spending it at h1 would displace $40 CT (although $60 CC also runs). It waits for h2,
    # where it displaces $100 imports.
    fleet = Fleet(gas_cc_mw=60.0, gas_ct_mw=60.0, batt_mw=20.0, batt_mwh=20.0, rte=0.81, import_limit_mw=200.0, grid_charging=True)
    drv = drivers([0.0, 100.0, 200.0], import_cost=[35.0, 100.0, 100.0], cc_cost=60.0, ct_cost=40.0)
    d = dispatch(fleet, drv, initial_soc_frac=0.0)
    assert_invariants(fleet, drv, d)
    np.testing.assert_allclose(d.grid_charge_mw, [20.0, 0.0, 0.0])
    np.testing.assert_allclose(d.discharge_mw, [0.0, 0.0, 16.2], atol=TOL)
    np.testing.assert_allclose(d.generation_mw["gas_ct"], [0.0, 40.0, 60.0])
    off = dispatch(_without_grid_charging(fleet), drv, initial_soc_frac=0.0)
    assert _energy_cost(d, drv) == pytest.approx(_energy_cost(off, drv) + 20 * 35 - 16.2 * 100)


def test_safety_net_drops_grid_charging_that_costs_more(monkeypatch):
    # Flat $50 imports never look cheap. Force a bad plan: charge from the grid every even
    # hour and treat that energy as free, so the battery cycles it at a 19% loss. dispatch()
    # must notice the year got dearer and return the dispatch without grid charging.
    n = 48
    fleet = Fleet(batt_mw=50.0, batt_mwh=100.0, rte=0.81, import_limit_mw=200.0, grid_charging=True)
    drv = drivers(np.full(n, 100.0), import_cost=50.0)
    real = dispatch_module._rule6_inputs
    calls = []

    def bad_plan(*args):
        _, _, tiers, surplus_ahead, carry = real(*args)
        calls.append(1)
        return [100.0 * (t % 2 == 0) for t in range(n)], [0.0] * n, tiers, surplus_ahead, carry

    monkeypatch.setattr(dispatch_module, "_rule6_inputs", bad_plan)
    d = dispatch(fleet, drv)
    assert calls, "the grid-charging plan was never tried"
    assert_invariants(fleet, drv, d)
    off = dispatch(_without_grid_charging(fleet), drv)
    assert not d.grid_charging
    np.testing.assert_array_equal(d.grid_charge_mw, 0.0)
    np.testing.assert_array_equal(d.imports_mw, off.imports_mw)
    np.testing.assert_array_equal(d.soc_mwh, off.soc_mwh)
    # A single pass (a window continuing some year) follows the fleet's policy as given.
    window = dispatch(fleet, drv, initial_soc_frac=0.0)
    assert window.grid_charging and window.grid_charge_mw.sum() > 0


@pytest.mark.parametrize("seed", [0, 1, 5])
def test_window_rerun_reproduces_the_year(seed: int):
    # Every rule 6 decision for hour t uses inputs up to t + LOOKAHEAD_H only, so a window
    # that starts where the year's battery is empty (no stored energy, no cost basis) and
    # sees LOOKAHEAD_H hours past its end replays the year exactly (stress reruns rely on it).
    n = 24 * 20
    fleet, drv, _ = _random_case(seed, n=n, grid_charging=True)
    year = dispatch(fleet, drv)
    assert year.grid_charging
    empty = np.flatnonzero(year.soc_mwh[24 : n - 120] == 0.0)
    a = 24 + int(empty[0]) + 1
    b = a + 72
    ext = slice(a, b + dispatch_module.LOOKAHEAD_H)

    def cut(x):
        return np.asarray(x)[ext] if np.ndim(x) else x

    w_fleet = dataclasses.replace(fleet, gas_cc_mw=cut(fleet.gas_cc_mw), gas_ct_mw=cut(fleet.gas_ct_mw), grid_charging=year.grid_charging)
    w_drv = Drivers(**{f.name: cut(getattr(drv, f.name)) for f in dataclasses.fields(drv)})
    w = dispatch(w_fleet, w_drv, initial_soc_frac=0.0)
    assert year.grid_charge_mw[a:b].sum() > 0
    for name in ("charge_mw", "grid_charge_mw", "discharge_mw", "soc_mwh", "imports_mw", "exports_mw", "unmet_mw", "curtailed_mw"):
        np.testing.assert_allclose(getattr(w, name)[: b - a], getattr(year, name)[a:b], atol=1e-6, err_msg=name)


def test_grid_charging_pays_on_every_preset_with_a_battery():
    """Real 2024 inputs: grid charging never raises the energy cost, never curtails more
    than the energy it bought and, with no unserved load either way, curtails no more."""
    from app.builder.service import list_presets
    from app.evaluate.catalog import get_catalog
    from app.simulate.engine import prepare

    catalog = get_catalog()
    checked = []
    for scenario in list_presets():
        prep = prepare(scenario, catalog)
        if not (prep.fleet.grid_charging and prep.fleet.batt_mwh > 0):
            continue
        on = dispatch(prep.fleet, prep.drivers)
        off = dispatch(_without_grid_charging(prep.fleet), prep.drivers)
        assert_invariants(prep.fleet, prep.drivers, on)
        assert _energy_cost(on, prep.drivers) <= _energy_cost(off, prep.drivers), scenario.id
        extra_curtailed = on.curtailed_mw.sum() - off.curtailed_mw.sum()
        assert extra_curtailed <= on.grid_charge_mw.sum() + TOL, scenario.id
        if on.unmet_mw.sum() <= TOL and off.unmet_mw.sum() <= TOL:
            assert extra_curtailed <= 0.005 * off.curtailed_mw.sum() + 1.0, scenario.id
        checked.append(scenario.id)
    assert checked, "no grid-connected preset with a battery"


def test_dispatch_is_deterministic():
    fleet, drv, _ = _random_case(123)
    a, b = dispatch(fleet, drv), dispatch(fleet, drv)
    for k in GENERATION_KEYS:
        np.testing.assert_array_equal(a.generation_mw[k], b.generation_mw[k])
    np.testing.assert_array_equal(a.soc_mwh, b.soc_mwh)


@pytest.mark.parametrize("grid_charging", [False, True], ids=["plain", "grid-charging"])
def test_full_leap_year_runs_fast(grid_charging: bool):
    # Grid charging adds the carry-limit pass and the safety net's second cyclic pair
    # (~15 ms on a laptop); the bound is loose for slow CI machines.
    n = 8784
    fleet, drv, _ = _random_case(2024, n=n, grid_charging=grid_charging)
    fleet.batt_mw, fleet.batt_mwh = 500.0, 2000.0  # make sure the sequential battery loop runs (twice: cyclic)
    fleet.import_limit_mw = 300.0
    best = math.inf
    for _ in range(3):
        t0 = time.perf_counter()
        d = dispatch(fleet, drv)
        best = min(best, time.perf_counter() - t0)
    assert best < 0.25, f"dispatch took {best * 1000:.1f} ms for {n} h"
    assert_invariants(fleet, drv, d)
