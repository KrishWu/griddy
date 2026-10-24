"""Workstream D: presets tell their stories and the report exports.  OWNER: workstream D.

Assert stories and invariants, not exact numbers: B's and C's real data will move them.
"""

import csv
import io

import pytest

from app.builder.service import DEFAULT_SITE, list_presets, report_csv
from app.contract import LngLat, Site
from app.pipeline import run_scenario

PRESETS = {p.id: p for p in list_presets()}


def test_preset_ids_unique_and_modes_covered():
    presets = list_presets()
    assert len({p.id for p in presets}) == len(presets)
    assert {p.mode for p in presets} == {"industrial", "community"}
    for p in presets:
        assert p.preset == p.id
        assert len({a.id for a in p.assets}) == len(p.assets), p.id
        assert all(a.capacity_mw > 0 for a in p.assets), p.id


def test_industrial_presets_share_demand_and_site():
    industrial = [p for p in list_presets() if p.mode == "industrial"]
    assert {p.demand.model_dump_json() for p in industrial} == {industrial[0].demand.model_dump_json()}
    assert all(p.site == DEFAULT_SITE for p in industrial)


def test_presets_follow_a_given_site():
    site = Site(id="x", name="Elsewhere", location=LngLat(lon=-121.4, lat=37.7))
    assert all(p.site == site for p in list_presets(site))


def test_hybrid_meets_demand_and_cycles_its_battery():
    """The demo's core moment: midday solar charges the battery, nothing goes unserved."""
    s = run_scenario(PRESETS["hybrid"]).simulation.summary
    assert s.hours_unmet == 0
    assert s.battery_cycles >= 100
    assert s.onsite_clean_share > 0.2


def test_renewable_heavy_is_cleaner_than_grid_only():
    rh = run_scenario(PRESETS["renewable_heavy"]).evaluation.emissions.annual_t_co2e
    grid = run_scenario(PRESETS["grid_connected"]).evaluation.emissions.annual_t_co2e
    assert rh < grid


@pytest.mark.parametrize("preset_id", list(PRESETS))
def test_report_csv_has_headline_rows(preset_id):
    result = run_scenario(PRESETS[preset_id])
    rows = list(csv.reader(io.StringIO(report_csv(result))))
    assert rows[0] == ["section", "item", "value", "unit", "source"]
    items = {(r[0], r[1]) for r in rows[1:]}
    for key in [("summary", "capex_total"), ("summary", "lcoe"), ("summary", "emissions"), ("summary", "unmet_hours")]:
        assert key in items, key
    assert any(r[0] == "capex" for r in rows) or preset_id == "grid_connected"


def test_hybrid_firm_capacity_covers_peak():
    """Gas + import limit must cover PEAK demand, so real (non-flat) load can't break the story."""
    h = PRESETS["hybrid"]
    firm = sum(a.capacity_mw for a in h.assets if a.kind in ("gas_cc", "gas_ct")) + h.grid.import_limit_mw
    assert firm >= h.demand.peak_mw


def test_flat_grid_price_option_reaches_every_hour_and_the_bill():
    """The builder's 'Flat price (what-if)' option must change what imports cost."""
    base = PRESETS["hybrid"]
    flat = base.model_copy(update={"assumptions": base.assumptions.model_copy(update={"price_source": "flat", "flat_price_usd_per_mwh": 120.0})})
    r_base, r_flat = run_scenario(base), run_scenario(flat)
    assert set(r_flat.simulation.hourly.price_usd_per_mwh) == {120.0}

    def purchased(r):
        return sum(line.usd for line in r.evaluation.economics.lines if line.category == "purchased_power")

    assert purchased(r_flat) > purchased(r_base)



def test_report_csv_shows_it_load_as_peak_over_pue():
    sc = PRESETS["hybrid"]
    rows = {(r[0], r[1]): r for r in csv.reader(io.StringIO(report_csv(run_scenario(sc))))}
    assert float(rows[("design", "it_load")][2]) == pytest.approx(sc.demand.peak_mw / sc.demand.pue, abs=0.1)


def test_better_pue_at_the_same_it_load_cuts_energy_and_co2():
    """The builder holds IT load fixed when PUE moves (facility peak = IT x PUE)."""
    base = PRESETS["hybrid"]
    it = base.demand.peak_mw / base.demand.pue
    better = base.model_copy(update={"demand": base.demand.model_copy(update={"pue": 1.1, "peak_mw": it * 1.1})})
    r0, r1 = run_scenario(base), run_scenario(better)
    assert r1.simulation.summary.demand_mwh < r0.simulation.summary.demand_mwh
    assert r1.evaluation.emissions.annual_t_co2e < r0.evaluation.emissions.annual_t_co2e
