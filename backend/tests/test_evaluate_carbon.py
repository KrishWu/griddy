import csv
import io

import numpy as np
import pytest

from app.builder.service import list_presets, report_csv
from app.contract import Asset, ScenarioResult
from app.evaluate.catalog import atb_data, get_catalog
from app.evaluate.economics import evaluate
from app.evaluate.emissions import compute_emissions
from app.simulate.engine import simulate


def test_operational_emissions_separate_grid_and_gas_without_export_credit():
    em, _ = compute_emissions({}, {}, np.array([1., 2.]), np.array([100., 300.]), 3, False)
    assert em.annual_t_co2e == pytest.approx(0.7)
    assert em.by_source_t_co2e == {"grid_imports": pytest.approx(0.7)}
    em, _ = compute_emissions({"gas_cc": 100}, {"gas_cc": 53.06}, np.zeros(2), np.ones(2) * 300, 10, False)
    assert em.annual_t_co2e == pytest.approx(5.306)


@pytest.fixture(scope="module")
def solar_run():
    sc = list_presets()[-1]
    sc.assets = [Asset(id="pv", kind="solar_pv", capacity_mw=30),
                 Asset(id="storage", kind="battery", capacity_mw=8, duration_h=4)]
    catalog = get_catalog()
    return sc, simulate(sc, catalog), catalog


def test_solar_has_zero_direct_carbon_but_grid_imports_and_upfront_carbon(solar_run):
    sc, sim, cat = solar_run
    e = evaluate(sc, sim, cat)
    c = e.extras["project"]["carbon"]
    assert c["annual_direct_t_co2e"] == 0
    assert c["annual_imports_t_co2e"] > 0
    assert c["annual_operational_t_co2e"] == e.emissions.annual_t_co2e
    assert c["annual_operational_t_co2e"] == c["annual_imports_t_co2e"]
    pv, battery = c["assets"]
    ilr = atb_data()["techs"]["solar_pv"]["pv_ilr"]["value"]
    assert pv["upfront_t_co2e"] == pytest.approx(30 * ilr * 1007)
    assert battery["quantity"] == 32
    assert battery["replacement_count"] == 1  # 15-year battery within 20 years
    assert c["modeled_total_t_co2e"] == pytest.approx(c["upfront_t_co2e"] + c["replacement_t_co2e"] + 20 * e.emissions.annual_t_co2e)
    assert c["inventory_complete"] is False


def test_carbon_edits_change_inventory_but_never_book_extra_costs(solar_run):
    sc, sim, cat = solar_run
    before = evaluate(sc, sim, cat)
    edited = sc.model_copy(deep=True)
    edited.options["project"] = {"solar_upfront_kg_per_kwdc": 500, "battery_upfront_kg_per_kwh": 0, "other_upfront_t_co2e": 100}
    after = evaluate(edited, sim, cat)
    assert before.economics == after.economics
    assert before.emissions == after.emissions
    c = after.extras["project"]["carbon"]
    assert c["upfront_t_co2e"] == pytest.approx(30 * 1.32 * 500 + 100)
    assert c["assets"][1]["upfront_t_co2e"] == 0
    assert "User-edited" in c["assets"][0]["provenance"]["source"]
    edited.assumptions.carbon_price_usd_per_t = 50
    priced = evaluate(edited, sim, cat)
    assert priced.economics.annual_opex_usd == before.economics.annual_opex_usd  # no combustion
    assert priced.extras["project"]["carbon"]["upfront_exposure_usd"] == pytest.approx(c["upfront_t_co2e"] * 50)


def test_upfront_does_not_follow_weather_and_replacements_stop_at_horizon(solar_run):
    sc, sim, cat = solar_run
    baseline = evaluate(sc, sim, cat).extras["project"]["carbon"]
    edited = sc.model_copy(deep=True)
    edited.assumptions.analysis_years = 15
    changed_sim = sim.model_copy(deep=True)
    changed_sim.hourly.grid_co2_kg_per_mwh = [0] * len(sim.hourly.demand_mw)
    c = evaluate(edited, changed_sim, cat).extras["project"]["carbon"]
    assert c["annual_operational_t_co2e"] == 0
    assert c["upfront_t_co2e"] == baseline["upfront_t_co2e"]
    assert c["replacement_t_co2e"] == 0
    assert c["modeled_total_t_co2e"] == c["upfront_t_co2e"]


def test_csv_has_carbon_boundary_units_and_reference_sources(solar_run):
    sc, sim, cat = solar_run
    r = ScenarioResult(scenario=sc, simulation=sim, evaluation=evaluate(sc, sim, cat), findings=[])
    rows = list(csv.reader(io.StringIO(report_csv(r))))
    assert any(row[:2] == ["carbon", "upfront_t_co2e"] and row[3] == "t CO2e" for row in rows)
    assert any(row[:2] == ["carbon_asset", "pv.upfront_t_co2e"] and "87372" in row[4] for row in rows)
    assert any(row[:2] == ["carbon", "inventory_complete"] and row[2] == "False" for row in rows)
