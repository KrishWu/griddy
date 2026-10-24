from types import SimpleNamespace

import numpy as np
import pytest

from app.builder.service import list_presets
from app.simulate.dispatch import Drivers, Fleet
from app.simulate.resilience import resilience_metrics


def case(*, soc=0, gas=0, battery=0, critical=1):
    sc = list_presets()[0]
    sc.options["project"] = {"outage_hours": 4, "critical_load_share": critical}
    n = 12
    fleet = Fleet(gas_cc_mw=gas, batt_mw=battery, batt_mwh=battery * 4, rte=1, import_limit_mw=10)
    d = Drivers(np.full(n, 10.0), np.zeros(n), np.zeros(n), np.full(n, 60), np.zeros(n))
    sim = SimpleNamespace(hourly=SimpleNamespace(battery_soc_mwh=[soc] * n))
    return sc, sim, SimpleNamespace(n=n, fleet=fleet, drivers=d)


def test_grid_only_has_no_island_supply():
    r = resilience_metrics(*case())
    assert r["critical_energy_served_share"] == 0
    assert r["unserved_critical_mwh"] == pytest.approx(40)
    assert r["n_minus_1_coverage"] == 0


def test_outage_uses_actual_soc_and_battery_power_limit():
    empty = resilience_metrics(*case(soc=0, battery=10))
    full = resilience_metrics(*case(soc=40, battery=10))
    power_limited = resilience_metrics(*case(soc=40, battery=5))
    assert empty["critical_energy_served_share"] == 0
    assert full["critical_energy_served_share"] == 1
    assert full["hours_before_shortfall"] == 4
    assert power_limited["critical_energy_served_share"] == pytest.approx(0.5)


def test_critical_share_reduces_outage_energy_not_base_demand():
    all_load = resilience_metrics(*case(soc=20, battery=10))
    half_load = resilience_metrics(*case(soc=20, battery=10, critical=0.5))
    assert all_load["critical_energy_served_share"] == pytest.approx(0.5)
    assert half_load["critical_energy_served_share"] == 1
    assert half_load["critical_demand_mwh"] == pytest.approx(20)
