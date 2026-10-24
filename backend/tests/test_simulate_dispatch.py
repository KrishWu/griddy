"""Unit tests for the dispatch core (app/simulate/dispatch.py).  OWNER: workstream B.

One test per dispatch rule on small hand-computed cases, then a randomized property
test over many seeds and a performance check on a full leap year.
"""

from __future__ import annotations

import math
import time
import warnings

import numpy as np
import pytest

from app.simulate.dispatch import GENERATION_KEYS, Dispatch, Drivers, Fleet, dispatch

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
        assert (s >= -TOL).all()
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
    firm = g["gas_cc"] + g["gas_ct"] + d.imports_mw
    assert (d.charge_mw[net >= 0] <= TOL).all(), "battery charges only from renewable surplus"
    assert (firm[net <= 0] <= TOL).all(), "no gas or imports in a surplus hour"
    assert (d.exports_mw[drv.export_price_usd_per_mwh < 0] <= TOL).all(), "never export at a negative price"
    if storage:
        max_charge = np.minimum(fleet.batt_mw, (fleet.batt_mwh - prev) / eta)
        max_discharge = np.minimum(fleet.batt_mw, prev * eta)
        spilled = d.exports_mw + d.curtailed_mw > TOL
        assert (d.charge_mw[spilled] >= max_charge[spilled] - TOL).all(), "charge before export/curtail"
        short = firm + d.unmet_mw > TOL
        assert (d.discharge_mw[short] >= max_discharge[short] - TOL).all(), "discharge before firm"
    curtail_ok = (d.curtailed_mw > TOL) & (drv.export_price_usd_per_mwh >= 0)
    assert (d.exports_mw[curtail_ok] >= fleet.export_limit_mw - TOL).all(), "export before curtail"

    cc_full = g["gas_cc"] >= cc_avail - TOL
    ct_full = g["gas_ct"] >= ct_avail - TOL
    imp_full = d.imports_mw >= fleet.import_limit_mw - TOL
    assert cc_full[g["gas_ct"] > TOL].all(), "gas CC before gas CT"
    unmet = d.unmet_mw > TOL
    assert (cc_full & ct_full & imp_full)[unmet].all(), "unmet only once everything is exhausted"
    cc_cost = np.broadcast_to(np.asarray(drv.gas_cc_cost_usd_per_mwh, dtype=float), (n,))
    ct_cost = np.maximum(cc_cost, drv.gas_ct_cost_usd_per_mwh)
    imp_cost = drv.import_cost_usd_per_mwh
    assert imp_full[(g["gas_cc"] > TOL) & (imp_cost < cc_cost)].all(), "cheaper imports before CC"
    assert imp_full[(g["gas_ct"] > TOL) & (imp_cost < ct_cost)].all(), "cheaper imports before CT"
    assert cc_full[(d.imports_mw > TOL) & (imp_cost >= cc_cost)].all(), "CC before dearer imports"
    assert ct_full[(d.imports_mw > TOL) & (imp_cost >= ct_cost)].all(), "CT before dearer imports"


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


def _random_case(seed: int, n: int = 500) -> tuple[Fleet, Drivers, float | None]:
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


def test_dispatch_is_deterministic():
    fleet, drv, _ = _random_case(123)
    a, b = dispatch(fleet, drv), dispatch(fleet, drv)
    for k in GENERATION_KEYS:
        np.testing.assert_array_equal(a.generation_mw[k], b.generation_mw[k])
    np.testing.assert_array_equal(a.soc_mwh, b.soc_mwh)


def test_full_leap_year_runs_fast():
    n = 8784
    fleet, drv, _ = _random_case(2024, n=n)
    fleet.batt_mw, fleet.batt_mwh = 500.0, 2000.0  # make sure the sequential battery loop runs (twice: cyclic)
    best = math.inf
    for _ in range(3):
        t0 = time.perf_counter()
        d = dispatch(fleet, drv)
        best = min(best, time.perf_counter() - t0)
    assert best < 0.25, f"dispatch took {best * 1000:.1f} ms for {n} h"
    assert_invariants(fleet, drv, d)
