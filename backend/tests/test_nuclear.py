"""Nuclear (large reactors and SMRs) end to end: dispatch rule 0, simulation, stress, costs, BOM, planner.

Assertions check invariants and ranges, not exact dollars, so updated catalog values don't break them.
"""

from __future__ import annotations

import numpy as np
import pytest

from app.builder.planner import PlanRequest, plan_project
from app.builder.service import list_presets
from app.contract import Asset, Scenario
from app.evaluate.catalog import NUCLEAR_EFOR, NUCLEAR_UNIT_MW, get_catalog
from app.evaluate.economics import evaluate
from app.simulate.dispatch import GENERATION_KEYS, Drivers, Fleet, dispatch
from app.simulate.engine import simulate
from app.simulate.stress import stress_test

KINDS = ("nuclear", "nuclear_smr")


def _drivers(demand, solar_cf=0.0):
    d = np.asarray(demand, dtype=float)
    z = np.zeros_like(d)
    return Drivers(demand_mw=d, solar_cf=z + solar_cf, wind_cf=z, import_cost_usd_per_mwh=z + 50, export_price_usd_per_mwh=z + 20)


def _balance(d, demand):
    gen = sum(d.generation_mw[k] for k in GENERATION_KEYS)
    rhs = gen + d.discharge_mw + d.imports_mw + d.unmet_mw - d.charge_mw - d.exports_mw - d.curtailed_mw
    return np.abs(np.asarray(demand) - rhs).max()


def test_rule0_nuclear_serves_load_first_and_never_more_than_load():
    demand = [800.0, 1200.0, 500.0]
    f = Fleet(solar_mw=400.0, import_limit_mw=1000.0, export_limit_mw=1000.0, nuclear_mw=700.0, nuclear_smr_mw=300.0)
    d = dispatch(f, _drivers(demand, solar_cf=1.0))
    served = d.generation_mw["nuclear"] + d.generation_mw["nuclear_smr"]
    assert np.allclose(served, [800.0, 1000.0, 500.0])  # min(available 1,000, demand)
    assert np.allclose(d.generation_mw["nuclear"] / served, 0.7)  # split by available output
    assert d.exports_mw[0] == pytest.approx(400.0)  # the surplus is solar's; nuclear never exports
    assert _balance(d, demand) < 1e-6
    assert set(GENERATION_KEYS) <= set(d.generation_mw)


def _scenario(*assets: Asset) -> Scenario:
    sc = list_presets()[0].model_copy(deep=True)  # grid-connected preset, demo site
    sc.assets = list(assets)
    return sc


@pytest.mark.parametrize("kind", KINDS)
def test_catalog_has_cited_nuclear_specs(kind):
    spec = get_catalog().spec(kind)
    assert spec.capex_usd_per_kw > 2000 and spec.fixed_om_usd_per_kw_yr > 50
    assert 0.85 <= (spec.typical_capacity_factor or 0) <= 0.98
    assert spec.heat_rate_mmbtu_per_mwh is None and spec.lifetime_years >= 30
    assert spec.provenance.url and "ATB" in spec.provenance.source
    assert 0 < NUCLEAR_EFOR[kind] < 0.2 and NUCLEAR_UNIT_MW[kind] > 0


@pytest.mark.parametrize("kind", KINDS)
def test_nuclear_campus_simulates_evaluates_and_stresses(kind):
    sc = _scenario(Asset(id="n", kind=kind, capacity_mw=1100))
    cat = get_catalog()
    sim = simulate(sc, cat)
    h = sim.hourly
    gen = sum(np.asarray(v) for v in h.generation_mw.values()) + np.asarray(h.battery_discharge_mw) + np.asarray(h.imports_mw) + np.asarray(h.unmet_mw)
    out = np.asarray(h.battery_charge_mw) + np.asarray(h.exports_mw) + np.asarray(h.curtailed_mw)
    assert np.abs(np.asarray(h.demand_mw) - (gen - out)).max() < 0.05  # balanced every hour (rounded payload)
    assert sim.summary.generation_mwh[kind] > 0
    assert sim.summary.onsite_clean_share > 0.7  # nuclear is carbon-free and served in full
    ev = evaluate(sc, sim, cat)
    items = [line.item for line in ev.economics.lines]
    assert any(i.startswith("Nuclear fuel") for i in items)
    assert ev.emissions.by_source_t_co2e.get(kind, 0.0) == 0.0  # no combustion on site
    assert any(b.item.startswith("Nuclear:") and b.quantity >= 1 for b in ev.economics.bom)
    ids = {f.id: f for f in stress_test(sc, sim)}
    assert "nuclear_policy_ca" in ids  # California law on new nuclear plants
    n1 = ids.get("n_minus_1")
    assert n1 is not None and ("reactor" in n1.title or "SMR" in n1.title)


def test_clean_share_rises_when_gas_is_swapped_for_nuclear():
    cat = get_catalog()
    gas = simulate(_scenario(Asset(id="g", kind="gas_cc", capacity_mw=900)), cat).summary.onsite_clean_share
    nuc = simulate(_scenario(Asset(id="n", kind="nuclear_smr", capacity_mw=900)), cat).summary.onsite_clean_share
    assert nuc > gas + 0.5


@pytest.mark.parametrize("kind", KINDS)
def test_planner_sizes_whole_reactors(kind):
    sc = list_presets()[0].model_copy(deep=True)
    out = plan_project(PlanRequest(scenario=sc, plant_type=kind))
    assets = [a for a in out["scenario"].assets if a.kind == kind]
    assert assets
    units = assets[0].capacity_mw / NUCLEAR_UNIT_MW[kind]
    assert units == pytest.approx(round(units)) and units >= 1
