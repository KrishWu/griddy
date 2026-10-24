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
