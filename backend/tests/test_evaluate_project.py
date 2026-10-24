import pytest

from app.builder.service import list_presets
from app.evaluate.catalog import get_catalog
from app.evaluate.economics import evaluate
from app.simulate.engine import simulate


def test_jobs_scale_with_labor_and_distinguish_years_from_headcount():
    sc = list_presets()[1]
    catalog = get_catalog()
    sim = simulate(sc, catalog)
    sc.options["project"] = {"construction_years": 4, "construction_labor_share": 0.3,
        "annual_compensation_usd": 100000, "operations_labor_share": 0.5}
    e = evaluate(sc, sim, catalog)
    jobs = e.extras["project"]["jobs"]
    assert jobs["construction_fte_years"] == pytest.approx(e.economics.capex_total_usd * 0.3 / 100000)
    assert jobs["average_construction_fte"] * 4 == pytest.approx(jobs["construction_fte_years"])
    om = sum(line.usd for line in e.economics.lines if line.category in ("fixed_om", "var_om"))
    assert jobs["operations_fte"] == pytest.approx(om * 0.5 / 100000)
    assert jobs["operations_fte"] < e.economics.annual_opex_usd * 0.5 / 100000  # fuel/imports aren't payroll


def test_offtake_is_illustrative_and_does_not_change_owner_costs():
    sc = list_presets()[1]
    catalog = get_catalog()
    sim = simulate(sc, catalog)
    e0 = evaluate(sc, sim, catalog)
    sc.options["project"] = {"contracted_share": 0.8, "contract_price_usd_per_mwh": 100}
    e1 = evaluate(sc, sim, catalog)
    assert e0.economics == e1.economics
    p = e1.extras["project"]
    assert p["contracts"]["annual_volume_mwh"] == pytest.approx(p["production"]["usable_generation_mwh"] * 0.8)
    gross = sum(v for k, v in sim.summary.generation_mwh.items() if k != "battery")
    assert p["production"]["gross_generation_mwh"] == pytest.approx(gross)


def test_carbon_exposure_is_not_double_counted_in_cashflow():
    sc = list_presets()[1]
    sc.assumptions.carbon_price_usd_per_t = 50
    catalog = get_catalog()
    sim = simulate(sc, catalog)
    e = evaluate(sc, sim, catalog)
    carbon = e.extras["project"]["carbon"]
    assert carbon["all_emissions_exposure_usd"] == pytest.approx(e.emissions.annual_t_co2e * 50)
    assert carbon["booked_annual_cost_usd"] == pytest.approx(sum(x.usd for x in e.economics.lines if x.category == "carbon"))


def test_invalid_experimental_options_fall_back_with_disclosure():
    sc = list_presets()[0]
    sc.options["project"] = {"critical_load_share": -2}
    catalog = get_catalog()
    e = evaluate(sc, simulate(sc, catalog), catalog)
    assert e.extras["project"]["warnings"]
    assert e.extras["project"]["assumptions"]["critical_load_share"] == 1
