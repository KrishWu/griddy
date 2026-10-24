"""Workstream C (Evaluate) tests: catalog, finance math, double counting, emissions, CFE, BOM.

Ranges and invariants only (other workstreams' data will move the numbers), except pure math.
"""

from __future__ import annotations

import json
import math
import time

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.builder.service import DEFAULT_SITE, list_presets
from app.contract import (
    Asset,
    Assumptions,
    DemandSpec,
    GridConnection,
    HourlySeries,
    Scenario,
    SimulationResult,
    SimulationSummary,
)
from app.evaluate import finance
from app.evaluate.catalog import (
    KINDS,
    atb_data,
    get_catalog,
    ref_value,
    replacement_cost_ratio,
    transmission_for_voltage,
    transmission_tier,
)
from app.evaluate.economics import evaluate
from app.main import app
from app.simulate.engine import simulate

CAT = get_catalog()
NPC_CATEGORIES = {"capex", "replacement", "salvage", "fixed_om", "var_om", "fuel", "purchased_power", "export_revenue", "carbon"}
EXTRAS_KEYS = {
    "nox_t_per_yr", "pm25_t_per_yr", "nox_t_per_yr_scr", "nox_basis",
    "cfe_score_24_7", "cfe_hourly_energy_share", "cfe_annual_netting_share", "cfe_by_month", "cfe_by_hour_of_day",
    "cfe_grid_share_source", "land_acres_total", "land_acres_direct_total", "land_acres_by_kind", "npc_breakdown",
    "cash_flows", "lcoe_crf_usd_per_mwh", "served_mwh_per_yr", "discounted_mwh_served", "fuel_mmbtu_per_yr",
    "fuel_effective_usd_per_mmbtu", "gas_price_monthly_usd_per_mmbtu", "emissions_import_methods", "emissions_crosscheck",
    "upstream_methane_t_co2e", "upstream_methane_included", "ca_allowance_reference_usd_per_t", "provenance",
    "methodology", "dollar_year",
}  # fmt: skip
PROVENANCE_METRICS = {
    "capex_total_usd", "annual_opex_usd", "npc_usd", "lcoe_usd_per_mwh", "annual_t_co2e", "intensity_kg_per_mwh",
    "cfe_score_24_7", "land_acres_total", "nox_t_per_yr", "pm25_t_per_yr",
}  # fmt: skip
METHODOLOGY_TOPICS = {"boundary", "horizon", "discounting", "dollar_year", "capex", "fuel", "imports", "exports", "carbon", "emissions", "cfe", "bom"}
LB_T = 0.45359237 / 1000


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def scenario(assets: list[Asset] | None = None, **kw) -> Scenario:
    grid = kw.pop("grid", GridConnection(import_limit_mw=200, interconnection_km=10))
    demand = kw.pop("demand", DemandSpec(peak_mw=100, load_factor=1.0))
    assumptions = kw.pop("assumptions", Assumptions(weather_year=2023))
    return Scenario(id="t", name="test", site=DEFAULT_SITE, demand=demand, assets=assets or [], grid=grid, assumptions=assumptions, **kw)


def sim(
    n: int = 8760, demand: float | np.ndarray = 100.0, gen: dict[str, np.ndarray | float] | None = None, extras: dict | None = None, **series
) -> SimulationResult:
    """Synthetic SimulationResult. Unspecified series are zero; price $50, grid CO2 200 kg/MWh."""

    def a(x) -> list[float]:
        return (np.zeros(n) + x).tolist() if x is not None else [0.0] * n

    gen_l = {k: a(v) for k, v in (gen or {}).items()}
    d = a(demand)
    imp = a(series.get("imports"))
    return SimulationResult(
        scenario_id="t",
        hourly=HourlySeries(
            start="2023-01-01T00:00:00-08:00",
            demand_mw=d,
            generation_mw=gen_l,
            battery_charge_mw=a(series.get("charge")),
            battery_discharge_mw=a(series.get("discharge")),
            battery_soc_mwh=a(series.get("soc")),
            imports_mw=imp,
            exports_mw=a(series.get("exports")),
            unmet_mw=a(series.get("unmet")),
            curtailed_mw=a(series.get("curtailed")),
            price_usd_per_mwh=a(series.get("price", 50.0)),
            grid_co2_kg_per_mwh=a(series.get("co2", 200.0)),
        ),
        summary=SimulationSummary(
            demand_mwh=sum(d), generation_mwh={k: sum(v) for k, v in gen_l.items()}, imports_mwh=sum(imp), exports_mwh=0,
            unmet_mwh=0, curtailed_mwh=0, peak_import_mw=max(imp), hours_unmet=0, onsite_clean_share=0, battery_cycles=0,
        ),
        extras=extras or {},
    )  # fmt: skip


def line_sum(result, category: str) -> float:
    return sum(x.usd for x in result.economics.lines if x.category == category)


def solar_shape(n: int) -> np.ndarray:
    h = np.arange(n) % 24
    return np.clip(np.sin(np.pi * (h - 6) / 12), 0, None)


@pytest.fixture(scope="module")
def preset_results():
    out = []
    for p in list_presets():
        s = simulate(p, CAT)
        out.append((p, s, evaluate(p, s, CAT)))
    return out


# ---------------------------------------------------------------------------
# Catalog
# ---------------------------------------------------------------------------


def test_catalog_has_every_kind_and_is_a_copy():
    assert {t.kind for t in CAT.techs} == set(KINDS)
    c = get_catalog()
    c.spec("solar_pv").capex_usd_per_kw = 1.0
    assert get_catalog().spec("solar_pv").capex_usd_per_kw > 1000


def test_catalog_ranges():
    pv = CAT.spec("solar_pv")
    assert 1.2e6 <= pv.capex_usd_per_kw * 1000 <= 1.8e6  # $/MWac
    assert 0.25 <= pv.typical_capacity_factor <= 0.35
    wind = CAT.spec("onshore_wind")
    assert 1200 <= wind.capex_usd_per_kw <= 2500
    batt = CAT.spec("battery")
    assert 0.8 <= batt.round_trip_efficiency <= 0.9
    assert 200 <= batt.capex_usd_per_kw <= 600 and 150 <= batt.capex_usd_per_kwh <= 350
    assert 5.5 <= CAT.spec("gas_cc").heat_rate_mmbtu_per_mwh <= 7.5
    assert 8.5 <= CAT.spec("gas_ct").heat_rate_mmbtu_per_mwh <= 11.5
    for k in ("gas_cc", "gas_ct"):
        assert CAT.spec(k).co2_kg_per_mmbtu == pytest.approx(53.06)
        assert CAT.spec(k).var_om_usd_per_mwh > 0
    for t in CAT.techs:
        assert t.fixed_om_usd_per_kw_yr > 0 and t.land_acres_per_mw > 0
    assert 1e6 <= CAT.transmission.line_usd_per_km <= 6e6
    assert 1e7 <= CAT.transmission.substation_usd <= 1e8


def test_catalog_values_trace_to_atb_and_deflator():
    atb, d = atb_data()["techs"], ref_value("deflator_2023_to_2024")
    pv = atb["solar_pv"]["derived"]
    p = atb["solar_pv"]["parameters"]
    occ, gcc, cfc = p["OCC"]["value"], p["GCC"]["value"], p["CFC"]["value"]
    assert pv["capex_ex_gcc_usd_per_kw"] == pytest.approx(occ + cfc * occ / (occ + gcc), rel=1e-6)
    assert CAT.spec("solar_pv").capex_usd_per_kw == pytest.approx(pv["capex_ex_gcc_usd_per_kw"] * d)
    b = atb["battery"]["derived"]
    batt = CAT.spec("battery")
    assert batt.capex_usd_per_kw + 4 * batt.capex_usd_per_kwh == pytest.approx(b["capex_ex_gcc_usd_per_kw"] * d, rel=1e-4)
    assert batt.fixed_om_usd_per_kw_yr == pytest.approx(atb["battery"]["parameters"]["Fixed O&M"]["value"] * d, rel=1e-4)


def test_catalog_provenance_is_specific():
    provs = [t.provenance for t in CAT.techs] + [CAT.transmission.provenance]
    for p in provs:
        text = f"{p.source} {p.note}".lower()
        assert "placeholder" not in text and "stub" not in text
        assert p.url and p.url.startswith("https://")
        assert p.note and len(p.note) > 100
    for t in CAT.techs:
        assert "ATB 2025" in t.provenance.source
        assert "Technical Lifetimes for Technologies" in t.provenance.note
        assert "2023" in t.provenance.note and "1.029494" in t.provenance.note
    assert "0.974362" in CAT.transmission.provenance.note


def test_lifetimes_match_atb_json():
    atb = atb_data()["techs"]
    for t in CAT.techs:
        assert t.lifetime_years == atb[t.kind]["lifetime_years"]
        assert "Technical Lifetimes" in atb[t.kind]["lifetime_source"]["source"]
    assert CAT.spec("battery").lifetime_years == 15 and CAT.spec("solar_pv").lifetime_years == 30
    assert ref_value("interconnection_lifetime_years") == 47


def test_transmission_tiers():
    assert transmission_tier(None)["kv"] == 230
    assert transmission_tier(69)["kv"] == transmission_tier(115)["kv"] == 115
    assert transmission_tier(230)["kv"] == 230
    assert transmission_tier(345)["kv"] == transmission_tier(500)["kv"] == 500
    t230, t500 = transmission_for_voltage(230), transmission_for_voltage(500)
    assert t230 == CAT.transmission
    assert t500.line_usd_per_km > t230.line_usd_per_km and t500.substation_usd > t230.substation_usd
    assert t230.line_usd_per_km == pytest.approx(ref_value("transmission_line_230kv_usd_per_km") * ref_value("deflator_2025_to_2024"))
    assert "SCE" in t500.provenance.source


def test_replacement_cost_ratio():
    assert replacement_cost_ratio("battery", 0) == pytest.approx(1.0)
    assert 0.4 < replacement_cost_ratio("battery", 15) < 1.0
    assert replacement_cost_ratio("battery", 500) == replacement_cost_ratio("battery", 2060 - 2027)
    assert replacement_cost_ratio("interconnection", 10) == 1.0


# ---------------------------------------------------------------------------
# Finance (pure math: exact)
# ---------------------------------------------------------------------------


def test_annuity_and_crf_identities():
    r, n = 0.07, 20
    assert finance.annuity_factor(r, n) == pytest.approx(sum((1 + r) ** -t for t in range(1, n + 1)), rel=1e-12)
    assert finance.annuity_factor(0.0, n) == n
    assert finance.crf(0.0, 10) == pytest.approx(0.1)
    for life in (10, 15, 30, 47):
        assert finance.crf(r, life) * finance.annuity_factor(r, life) == pytest.approx(1.0)
        assert finance.crf(r, life) == pytest.approx(r * (1 + r) ** life / ((1 + r) ** life - 1))
    assert finance.crf(0.07, 30) == pytest.approx(0.080586, abs=1e-6)
    with pytest.raises(ValueError):
        finance.annuity_factor(-1.0, 5)


@pytest.mark.parametrize(
    "life, horizon, years, salvage",
    [
        (15, 20, [15], 10 / 15),
        (30, 20, [], 1 / 3),
        (10, 20, [10], 0.0),
        (20, 20, [], 0.0),
        (5, 20, [5, 10, 15], 0.0),
        (47, 20, [], 27 / 47),
        (7, 20, [7, 14], 1 / 7),
    ],
)
def test_replacement_and_salvage_schedules(life, horizon, years, salvage):
    assert finance.replacement_years(life, horizon) == years
    assert finance.salvage_fraction(life, horizon) == pytest.approx(salvage)


def test_npc_hand_checked_100mw_pv():
    """100 MW PV, $1,235/kW, $23/kW-yr, 200 GWh/yr, 7%, 20 years, 30-year life."""
    capex, opex, mwh, r, n = 100_000 * 1235.0, 100_000 * 23.0, 200_000.0, 0.07, 20
    res = finance.net_present_cost([finance.CapitalItem("PV", "solar_pv", capex, 30)], [finance.OpexItem("FOM", "fixed_om", opex)], mwh, r, n)
    af = (1 - 1.07**-20) / 0.07
    npc = capex + opex * af - capex * (1 / 3) * 1.07**-20
    assert res.npc_usd == pytest.approx(npc, rel=1e-12)
    assert res.lcoe_usd_per_mwh == pytest.approx(npc / (mwh * af), rel=1e-12)
    assert res.lcoe_crf_usd_per_mwh == pytest.approx((capex * finance.crf(r, 30) + opex) / mwh, rel=1e-12)
    assert 40 < res.lcoe_usd_per_mwh < 90  # sanity: ~$66/MWh before land, interconnection, imports
    assert sum(b["usd"] for b in res.breakdown) == pytest.approx(res.npc_usd, abs=1e-3)
    assert len(res.cash_flows) == n + 1 and res.cash_flows[0]["capex_usd"] == capex
    assert sum(c["pv_usd"] for c in res.cash_flows) == pytest.approx(res.npc_usd, rel=1e-12)
    assert res.cash_flows[-1]["salvage_usd"] == pytest.approx(-capex / 3)


def test_npc_battery_replacement_uses_cost_ratio():
    item = finance.CapitalItem("Battery", "battery", 1e8, 15, lambda year: 0.7)
    res = finance.net_present_cost([item], [], 1.0, 0.07, 20)
    expected = 1e8 + 0.7e8 * 1.07**-15 - 0.7e8 * (2 / 3) * 1.07**-20
    assert res.npc_usd == pytest.approx(expected, rel=1e-12)
    assert res.cash_flows[15]["replacement_usd"] == pytest.approx(0.7e8)
    cats = {b["category"]: b["usd"] for b in res.breakdown}
    assert cats["replacement"] == pytest.approx(0.7e8 * 1.07**-15) and cats["salvage"] < 0


def test_npc_zero_rate_and_no_energy():
    res = finance.net_present_cost([finance.CapitalItem("X", "solar_pv", 300.0, 30)], [finance.OpexItem("o", "fuel", 10.0)], 0.0, 0.0, 20)
    assert res.npc_usd == pytest.approx(300 + 200 - 100)
    assert res.lcoe_usd_per_mwh == 0.0 and res.lcoe_crf_usd_per_mwh == 0.0


# ---------------------------------------------------------------------------
# Every preset
# ---------------------------------------------------------------------------


def test_presets_headline_ranges(preset_results):
    for p, _, r in preset_results:
        e = r.economics
        assert 40 <= e.lcoe_usd_per_mwh <= 150, p.id
        assert 0.75 < r.extras["lcoe_crf_usd_per_mwh"] / e.lcoe_usd_per_mwh < 1.25, p.id
        assert e.capex_total_usd == pytest.approx(line_sum(r, "capex"))
        assert e.annual_opex_usd == pytest.approx(sum(x.usd for x in e.lines if x.category != "capex"))
        assert e.npc_usd >= e.capex_total_usd > 0
        assert r.extras["dollar_year"] == 2024
        assert 0 <= r.emissions.intensity_kg_per_mwh < 600


def test_presets_extras_complete_and_json_safe(preset_results):
    for p, _, r in preset_results:
        x = r.extras
        assert EXTRAS_KEYS <= set(x), (p.id, EXTRAS_KEYS - set(x))
        json.dumps(x, allow_nan=False)
        assert json.loads(json.dumps(x)) == x  # plain JSON types only
        assert set(x["provenance"]) >= PROVENANCE_METRICS
        for prov in x["provenance"].values():
            assert prov["kind"] in ("observed", "assumption", "simulated", "inferred") and prov["source"] and prov["note"]
        assert set(x["methodology"]) >= METHODOLOGY_TOPICS and all(x["methodology"].values())
        assert len(x["cfe_by_month"]) == 12 and len(x["cfe_by_hour_of_day"]) == 24
        assert x["cfe_grid_share_source"] in ("simulate", "inferred_from_grid_co2")
        for k in ("nox_t_per_yr", "pm25_t_per_yr", "nox_t_per_yr_scr", "land_acres_total", "lcoe_crf_usd_per_mwh"):
            assert type(x[k]) is float, k


def test_presets_npc_breakdown_sums(preset_results):
    for p, _, r in preset_results:
        bd = r.extras["npc_breakdown"]
        assert {b["category"] for b in bd} <= NPC_CATEGORIES
        assert sum(b["usd"] for b in bd) == pytest.approx(r.economics.npc_usd, abs=1.0)
        assert all(b["usd"] <= 0 for b in bd if b["category"] in ("salvage", "export_revenue"))
        cf = r.extras["cash_flows"]
        assert [c["year"] for c in cf] == list(range(p.assumptions.analysis_years + 1))
        assert sum(c["pv_usd"] for c in cf) == pytest.approx(r.economics.npc_usd, abs=1.0)


def test_presets_cost_lines_have_specific_provenance(preset_results):
    for _, _, r in preset_results:
        for line in r.economics.lines:
            p = line.provenance
            assert p.source and p.note, line.item
            assert "placeholder" not in f"{p.source} {p.note}".lower()


def test_presets_bom(preset_results):
    groups = ("Generation: ", "Land: ", "Interconnection: ", "Electrical: ")
    for p, _, r in preset_results:
        bom = r.economics.bom
        assert bom
        for b in bom:
            assert b.basis.strip() and b.item.startswith(groups) and b.quantity >= 0, b
        items = {b.item.split(" (")[0]: b for b in bom}
        has_dc_items = "Electrical: Data-center service transformers" in items
        assert has_dc_items == (p.demand.kind == "data_center")
        if any(a.kind == "solar_pv" for a in p.assets):
            mwac = sum(a.capacity_mw for a in p.assets if a.kind == "solar_pv")
            mods = next(b for b in bom if b.item.startswith("Generation: PV modules"))
            assert mods.quantity == math.ceil(mwac * 1.32 * 1000 / 0.55 - 1e-9)


def test_presets_land(preset_results):
    for p, _, r in preset_results:
        x = r.extras
        assert x["land_acres_total"] == pytest.approx(sum(x["land_acres_by_kind"].values()))
        assert x["land_acres_direct_total"] <= x["land_acres_total"] + 1e-9
        wind = sum(a.capacity_mw for a in p.assets if a.kind == "onshore_wind")
        if wind:
            assert x["land_acres_by_kind"]["onshore_wind"] == pytest.approx(wind * 85.25)
            assert x["land_acres_total"] - x["land_acres_direct_total"] == pytest.approx(wind * (85.25 - 2.47))


def test_evaluate_is_fast_on_8760_hours():
    p = list_presets()[2]
    p = p.model_copy(update={"assumptions": p.assumptions.model_copy(update={"weather_year": 2023})})
    s = simulate(p, CAT)
    assert len(s.hourly.demand_mw) == 8760
    evaluate(p, s, CAT)
    t0 = time.perf_counter()
    evaluate(p, s, CAT)
    assert time.perf_counter() - t0 < 0.5  # target ~150 ms; measured ~3 ms


# ---------------------------------------------------------------------------
# Double counting
# ---------------------------------------------------------------------------


def test_purchased_power_is_imports_times_price_plus_adder():
    n = 8760
    rng = np.random.default_rng(0)
    imports, price = rng.uniform(0, 80, n), rng.uniform(-10, 200, n)
    sc = scenario([Asset(id="pv", kind="solar_pv", capacity_mw=100)])
    s1 = sim(n, gen={"solar_pv": 100 * solar_shape(n)}, imports=imports, price=price)
    r1 = evaluate(sc, s1, CAT)
    adder = sc.assumptions.import_adder_usd_per_mwh
    expected = float(np.dot(imports, price + adder))
    assert line_sum(r1, "purchased_power") == pytest.approx(expected, rel=1e-9)
    # On-site generation never shows up in purchased power.
    s2 = sim(n, gen={"solar_pv": 200 * solar_shape(n)}, imports=imports, price=price)
    assert line_sum(evaluate(sc, s2, CAT), "purchased_power") == pytest.approx(line_sum(r1, "purchased_power"), rel=1e-12)


def test_carbon_priced_on_direct_co2_only():
    n = 8760
    a = Assumptions(weather_year=2023, carbon_price_usd_per_t=30.0)
    sc = scenario([Asset(id="cc", kind="gas_cc", capacity_mw=50)], assumptions=a)
    r1 = evaluate(sc, sim(n, gen={"gas_cc": 50.0}, imports=50.0), CAT)
    direct_t = 50.0 * n * CAT.spec("gas_cc").heat_rate_mmbtu_per_mwh * 53.06 / 1000
    assert r1.emissions.by_source_t_co2e["gas_cc"] == pytest.approx(direct_t)
    assert line_sum(r1, "carbon") == pytest.approx(direct_t * 30.0)
    r2 = evaluate(sc, sim(n, gen={"gas_cc": 50.0}, imports=90.0), CAT)
    assert line_sum(r2, "carbon") == pytest.approx(line_sum(r1, "carbon"))  # imports never priced
    assert r2.emissions.by_source_t_co2e["grid_imports"] > r1.emissions.by_source_t_co2e["grid_imports"]
    sc3 = scenario([Asset(id="cc", kind="gas_cc", capacity_mw=50)], assumptions=a, options={"include_upstream_methane": True})
    assert line_sum(evaluate(sc3, sim(n, gen={"gas_cc": 50.0}, imports=50.0), CAT), "carbon") == pytest.approx(line_sum(r1, "carbon"))
    assert not any(x.category == "carbon" for x in evaluate(scenario(), sim(n, imports=100.0), CAT).economics.lines)


def test_exports_credit_defaults_to_zero():
    n = 8760
    sc = scenario([Asset(id="pv", kind="solar_pv", capacity_mw=300)])
    s = sim(n, gen={"solar_pv": 300 * solar_shape(n)}, exports=20 * solar_shape(n), price=40.0)
    r = evaluate(sc, s, CAT)
    exp = [x for x in r.economics.lines if x.category == "export_revenue"]
    assert len(exp) == 1 and exp[0].usd == 0.0
    sc2 = scenario([Asset(id="pv", kind="solar_pv", capacity_mw=300)], options={"export_credit_fraction": 0.5})
    r2 = evaluate(sc2, s, CAT)
    assert line_sum(r2, "export_revenue") == pytest.approx(-0.5 * float(np.dot(20 * solar_shape(n), np.full(n, 40.0))))
    assert r2.emissions.annual_t_co2e == pytest.approx(r.emissions.annual_t_co2e)  # no emission credit for exports


# ---------------------------------------------------------------------------
# Fuel: the scenario gas price is authoritative
# ---------------------------------------------------------------------------


def _fuel(price: float, year: int = 2024, **opts) -> tuple[float, dict]:
    n = 8784 if year == 2024 else 8760
    gen = 40 + 20 * np.sin(np.arange(n) / 500)
    sc = scenario([Asset(id="cc", kind="gas_cc", capacity_mw=60)], assumptions=Assumptions(weather_year=year, gas_price_usd_per_mmbtu=price), options=opts)
    r = evaluate(sc, sim(n, gen={"gas_cc": gen}), CAT)
    return line_sum(r, "fuel"), r.extras


def test_fuel_is_linear_in_the_scalar():
    f1, x1 = _fuel(3.0)
    f2, x2 = _fuel(6.0)
    assert f2 == pytest.approx(2 * f1, rel=1e-12)
    monthly = x1["gas_price_monthly_usd_per_mmbtu"]
    assert len(monthly) == 12 and np.mean(monthly) == pytest.approx(3.0)
    assert x2["fuel_effective_usd_per_mmbtu"] == pytest.approx(2 * x1["fuel_effective_usd_per_mmbtu"])


@pytest.mark.parametrize("year, opts", [(2024, {"gas_price_shape": "flat"}), (2023, {})])
def test_fuel_flat_option_is_exact(year, opts):
    f, x = _fuel(4.25, year, **opts)
    assert x["gas_price_monthly_usd_per_mmbtu"] is None
    assert f == pytest.approx(x["fuel_mmbtu_per_yr"] * 4.25, rel=1e-12)
    assert x["fuel_effective_usd_per_mmbtu"] == pytest.approx(4.25)


# ---------------------------------------------------------------------------
# Emissions, NOx, PM2.5
# ---------------------------------------------------------------------------


def test_no_gas_means_zero_float_criteria_pollutants(preset_results):
    _, _, r = next(t for t in preset_results if t[0].id == "grid_connected")
    for k in ("nox_t_per_yr", "pm25_t_per_yr", "nox_t_per_yr_scr", "upstream_methane_t_co2e"):
        assert r.extras[k] == 0.0 and type(r.extras[k]) is float
    assert set(r.emissions.by_source_t_co2e) == {"grid_imports"}


def test_emission_factors_applied():
    n = 8760
    sc = scenario([Asset(id="cc", kind="gas_cc", capacity_mw=50), Asset(id="ct", kind="gas_ct", capacity_mw=50)])
    r = evaluate(sc, sim(n, gen={"gas_cc": 30.0, "gas_ct": 10.0}, imports=60.0, co2=250.0), CAT)
    cc_mmbtu = 30.0 * n * CAT.spec("gas_cc").heat_rate_mmbtu_per_mwh
    ct_mmbtu = 10.0 * n * CAT.spec("gas_ct").heat_rate_mmbtu_per_mwh
    x = r.extras
    assert x["fuel_mmbtu_per_yr"] == pytest.approx(cc_mmbtu + ct_mmbtu)
    assert x["nox_t_per_yr"] == pytest.approx((cc_mmbtu + ct_mmbtu) * 0.099 * LB_T)
    assert x["nox_t_per_yr_scr"] == pytest.approx((cc_mmbtu * 0.00737 + ct_mmbtu * 0.00921) * LB_T)
    assert x["pm25_t_per_yr"] == pytest.approx((cc_mmbtu + ct_mmbtu) * 0.0066 * LB_T)
    imp = 60.0 * n
    assert r.emissions.by_source_t_co2e["grid_imports"] == pytest.approx(imp * 250 / 1000)
    carb = x["emissions_import_methods"]["carb_unspecified"]
    assert carb["grid_imports_t"] == pytest.approx(imp * 0.428 * 1.02)
    assert x["emissions_crosscheck"]["sim_import_weighted_kg_per_mwh"] == pytest.approx(250.0)
    assert x["emissions_crosscheck"]["egrid_camx_kg_per_mwh"] == pytest.approx(428.464 * 0.45359237)
    total = sum(r.emissions.by_source_t_co2e.values())
    assert r.emissions.annual_t_co2e == pytest.approx(total)
    assert x["emissions_import_methods"]["caiso_hourly_average"]["annual_t_co2e"] == pytest.approx(total)
    assert r.emissions.intensity_kg_per_mwh == pytest.approx(total * 1000 / (100 * n))
    # Upstream methane: reported always, added only when asked.
    assert x["upstream_methane_included"] is False and "upstream_methane" not in r.emissions.by_source_t_co2e
    assert x["upstream_methane_t_co2e"] == pytest.approx((cc_mmbtu + ct_mmbtu) * 12.47 / 1000)
    sc2 = scenario(sc.assets, options={"include_upstream_methane": True})
    r2 = evaluate(sc2, sim(n, gen={"gas_cc": 30.0, "gas_ct": 10.0}, imports=60.0, co2=250.0), CAT)
    assert r2.emissions.annual_t_co2e == pytest.approx(r.emissions.annual_t_co2e + x["upstream_methane_t_co2e"])


def test_gas_cc_can_be_dirtier_than_average_imports():
    """Honest ordering: no factor is tuned; on-site CC intensity is ~0.32 t/MWh."""
    cc = CAT.spec("gas_cc")
    assert 300 < cc.heat_rate_mmbtu_per_mwh * cc.co2_kg_per_mmbtu < 360
    assert ref_value("egrid_camx_co2_lb_per_mwh") * 0.45359237 < 250


# ---------------------------------------------------------------------------
# 24/7 CFE
# ---------------------------------------------------------------------------


def test_cfe_bounds_on_presets(preset_results):
    for _, _, r in preset_results:
        x = r.extras
        for k in ("cfe_score_24_7", "cfe_hourly_energy_share", "cfe_annual_netting_share"):
            assert 0.0 <= x[k] <= 1.0
        assert all(0.0 <= v <= 1.0 for v in x["cfe_by_month"] + x["cfe_by_hour_of_day"])


def test_cfe_grid_share_from_simulate():
    n = 8760
    full = evaluate(scenario(), sim(n, imports=100.0, extras={"grid_cfe_share": 1.0}), CAT).extras
    assert full["cfe_score_24_7"] == 1.0 and full["cfe_grid_share_source"] == "simulate"
    none = evaluate(scenario(), sim(n, imports=100.0, extras={"grid_cfe_share": 0.0}), CAT).extras
    assert none["cfe_score_24_7"] == 0.0 and none["cfe_hourly_energy_share"] == 0.0
    half = np.where(np.arange(n) % 2 == 0, 1.0, 0.5).tolist()
    x = evaluate(scenario(), sim(n, imports=100.0, extras={"grid_cfe_share": half}), CAT).extras
    assert x["cfe_score_24_7"] == pytest.approx(0.5) and x["cfe_hourly_energy_share"] == pytest.approx(0.75)
    assert x["cfe_annual_netting_share"] == pytest.approx(0.75)
    bad = evaluate(scenario(), sim(n, imports=100.0, co2=0.0, extras={"grid_cfe_share": [1.0, 0.0]}), CAT).extras
    assert bad["cfe_grid_share_source"] == "inferred_from_grid_co2" and bad["cfe_score_24_7"] == 1.0
    dirty = evaluate(scenario(), sim(n, imports=100.0, co2=900.0), CAT).extras
    assert dirty["cfe_grid_share_source"] == "inferred_from_grid_co2" and dirty["cfe_score_24_7"] == 0.0


def test_cfe_battery_carries_clean_energy_to_night():
    """Solar charges the battery by day; the battery covers the whole night load: every hour is clean."""
    n = 8760
    h = np.arange(n) % 24
    day = (h >= 8) & (h < 16)  # 8 sun hours
    demand = np.full(n, 10.0)
    solar = np.where(day, 30.0, 0.0)  # 10 to load + 20 to charge
    charge = np.where(day, 20.0, 0.0)
    discharge = np.where(day, 0.0, 10.0)
    soc = np.zeros(n)
    sc = scenario([Asset(id="pv", kind="solar_pv", capacity_mw=30), Asset(id="b", kind="battery", capacity_mw=20, duration_h=8)])
    x = evaluate(sc, sim(n, demand=demand, gen={"solar_pv": solar}, charge=charge, discharge=discharge, soc=soc), CAT).extras
    assert x["cfe_score_24_7"] == 1.0 and x["cfe_by_hour_of_day"] == [1.0] * 24
    # Same battery charged from dirty imports instead: night hours are no longer clean.
    imports = np.where(day, 20.0, 0.0)
    x2 = evaluate(sc, sim(n, demand=demand, gen={"solar_pv": np.where(day, 10.0, 0.0)}, imports=imports, charge=charge,
                          discharge=discharge, soc=soc, extras={"grid_cfe_share": 0.0}), CAT).extras  # fmt: skip
    assert x2["cfe_score_24_7"] == pytest.approx(8 / 24)


# ---------------------------------------------------------------------------
# Robustness to simulate's future changes and scenario variants
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("year", [2023, 2024])
def test_leap_and_normal_years(year):
    n = 8784 if year == 2024 else 8760
    sc = scenario([Asset(id="cc", kind="gas_cc", capacity_mw=60)], assumptions=Assumptions(weather_year=year))
    r = evaluate(sc, sim(n, gen={"gas_cc": 50.0}, imports=50.0), CAT)
    assert r.extras["served_mwh_per_yr"] == pytest.approx(100.0 * n)
    json.dumps(r.extras, allow_nan=False)


def test_generation_kinds_missing_or_zero():
    n = 8760
    sc = scenario([Asset(id="pv", kind="solar_pv", capacity_mw=100), Asset(id="ct", kind="gas_ct", capacity_mw=0)])
    r = evaluate(sc, sim(n, gen={"gas_ct": 0.0, "onshore_wind": 0.0}, imports=100.0), CAT)  # no solar_pv series at all
    assert not any(x.category in ("fuel", "var_om") for x in r.economics.lines)
    assert r.extras["nox_t_per_yr"] == 0.0
    assert any("Solar PV" in x.item for x in r.economics.lines if x.category == "capex")
    assert not any("Gas combustion" in x.item for x in r.economics.lines)  # zero-capacity asset costs nothing


def test_flat_price_disconnected_and_no_assets():
    n = 8760
    a = Assumptions(weather_year=2023, price_source="flat", flat_price_usd_per_mwh=60.0)
    r = evaluate(scenario(assumptions=a), sim(n, imports=100.0, price=35.0), CAT)  # flat price wins over the series
    assert line_sum(r, "purchased_power") == pytest.approx(100.0 * n * (60.0 + 20.0))
    assert r.economics.lcoe_usd_per_mwh > 80  # imports + interconnection
    off = scenario(
        [Asset(id="pv", kind="solar_pv", capacity_mw=200), Asset(id="b", kind="battery", capacity_mw=100)],
        grid=GridConnection(connected=False, import_limit_mw=0),
    )
    r2 = evaluate(off, sim(n, gen={"solar_pv": 200 * solar_shape(n)}, unmet=50.0), CAT)
    lines = r2.economics.lines
    assert not any(x.category == "purchased_power" for x in lines)
    assert not any(x.item.startswith("Interconnection") for x in lines)
    assert not any(b.item.startswith("Interconnection") for b in r2.economics.bom)
    assert r2.extras["served_mwh_per_yr"] == pytest.approx(50.0 * n)
    empty = evaluate(scenario(grid=GridConnection(connected=False, import_limit_mw=0)), sim(n, unmet=100.0), CAT)
    assert empty.economics.capex_total_usd == 0.0 and empty.economics.lcoe_usd_per_mwh == 0.0
    json.dumps(empty.extras, allow_nan=False)


def test_community_demand_has_no_data_center_equipment():
    n = 8760
    sc = scenario([Asset(id="pv", kind="solar_pv", capacity_mw=50)], demand=DemandSpec(kind="community", peak_mw=80, profile="community"))
    bom = evaluate(sc, sim(n, demand=50.0, gen={"solar_pv": 50 * solar_shape(n)}, imports=50.0), CAT).economics.bom
    names = " ".join(b.item for b in bom)
    assert "UPS" not in names and "unit substations" not in names and "Data-center" not in names
    assert "Main power transformers" in names


def test_asset_overrides():
    n = 8760
    base = [Asset(id="pv", kind="solar_pv", capacity_mw=100), Asset(id="b", kind="battery", capacity_mw=50, duration_h=4)]
    r0 = evaluate(scenario(base), sim(n, imports=100.0), CAT)
    over = [
        Asset(id="pv", kind="solar_pv", capacity_mw=100, overrides={"capex_usd_per_kw": 1000.0, "lifetime_years": 10.0}),
        Asset(id="b", kind="battery", capacity_mw=50, duration_h=4, overrides={"fixed_om_usd_per_kw_yr": 10.0}),
    ]
    r1 = evaluate(scenario(over), sim(n, imports=100.0), CAT)
    pv_capex = next(x.usd for x in r1.economics.lines if x.category == "capex" and "Solar PV" in x.item)
    assert pv_capex == pytest.approx(100_000 * 1000.0)
    assert "override" in next(x.provenance.note for x in r1.economics.lines if x.category == "capex" and "Solar PV" in x.item)
    batt_fom = next(x.usd for x in r1.economics.lines if x.category == "fixed_om" and "Battery" in x.item)
    assert batt_fom == pytest.approx(50_000 * 10.0)
    assert any(b["category"] == "replacement" and "Solar PV" in b["label"] for b in r1.extras["npc_breakdown"])
    assert not any(b["category"] == "replacement" and "Solar PV" in b["label"] for b in r0.extras["npc_breakdown"])
    # Default battery fixed O&M uses ATB's exact $/kW + $/kWh split.
    fk = atb_data()["techs"]["battery"]["derived"]["fixed_om_power_usd_per_kw_yr"] * ref_value("deflator_2023_to_2024")
    fe = atb_data()["techs"]["battery"]["derived"]["fixed_om_energy_usd_per_kwh_yr"] * ref_value("deflator_2023_to_2024")
    r8 = evaluate(scenario([Asset(id="b", kind="battery", capacity_mw=50, duration_h=8)]), sim(n, imports=100.0), CAT)
    assert line_sum(r8, "fixed_om") == pytest.approx(50_000 * fk + 400_000 * fe)


def test_horizon_and_voltage_variants():
    n = 8760
    assets = [Asset(id="b", kind="battery", capacity_mw=50)]
    for years in (10, 15, 30):
        sc = scenario(assets, assumptions=Assumptions(weather_year=2023, analysis_years=years))
        r = evaluate(sc, sim(n, imports=100.0), CAT)
        assert len(r.extras["cash_flows"]) == years + 1
        assert sum(b["usd"] for b in r.extras["npc_breakdown"]) == pytest.approx(r.economics.npc_usd, abs=1.0)
        has_repl = any(b["category"] == "replacement" for b in r.extras["npc_breakdown"])
        assert has_repl == (years > 15)
    hv = scenario(grid=GridConnection(import_limit_mw=200, interconnection_km=10, poi_voltage_kv=500))
    r500 = evaluate(hv, sim(n, imports=100.0), CAT)
    r230 = evaluate(scenario(), sim(n, imports=100.0), CAT)
    assert r500.extras["interconnection_tier_kv"] == 500
    assert r500.economics.capex_total_usd > r230.economics.capex_total_usd


def test_assumptions_endpoint():
    client = TestClient(app)
    body = client.get("/api/evaluate/assumptions").json()
    assert {"ref_emissions", "ref_costs", "bom_basis", "atb"} <= set(body)
    assert "carb_transmission_loss_factor" in body["ref_emissions"] and "deflator_2025_to_2024" in body["ref_costs"]
    assert set(body["atb"]["techs"]) == set(KINDS)
    assert all("capex_ex_gcc_trajectory_usd_per_kw" not in t for t in body["atb"]["techs"].values())
    assert client.get("/api/catalog").json()["techs"][0]["provenance"]["source"].startswith("NLR ATB 2025")
