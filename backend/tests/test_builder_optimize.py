"""Optimizer: the screen agrees with simulate(), and what it recommends really passes.

Ranges and invariants only (other workstreams' data keeps moving the dollars). Tests that don't
need the full search use small max_finalists, no wind and no refinement to stay quick; test 8 runs
the default demo request.
"""
import json
import math
import time
from collections import Counter

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.builder import optimizer as opt
from app.builder import placement
from app.builder.optimizer import Mix, OptimizeRequest, SiteOption, context, optimize, scenario_for, screen
from app.builder.planner import PlanRequest, plan_project
from app.builder.service import list_presets
from app.contract import Asset, LngLat, SiteCandidate, SiteRecommendation, SiteRequest
from app.evaluate.catalog import get_catalog
from app.evaluate.economics import evaluate
from app.evaluate.project import ProjectOptions
from app.main import app
from app.simulate import profiles, weather
from app.simulate.engine import simulate
from app.simulate.stress import stress_test

HYBRID = list_presets()[1]
QUICK = {"include_wind": False, "max_finalists": 6, "refine": False, "placement": "campus_only"}


@pytest.fixture(scope="module", autouse=True)
def offline_weather():
    """No live Open-Meteo here: a site-model cell that isn't pre-baked or in the runtime cache gets profiles'
    stand-in (the nearest pre-baked site), exactly as an offline server would."""
    def offline(*args, **kwargs):
        raise weather.WeatherUnavailable("network disabled in tests")

    mp = pytest.MonkeyPatch()
    mp.setattr(weather, "build_site_frame", offline)
    profiles.clear_weather_cache()
    yield
    mp.undo()
    profiles.clear_weather_cache()


def _hybrid(**options) -> object:
    sc = HYBRID.model_copy(deep=True)
    sc.options.update(options)
    return sc


@pytest.fixture(scope="module")
def demo():
    """The default demo request (Kern hybrid preset site, 80% on-site clean), computed live once."""
    opt.clear_cache()
    started = time.perf_counter()
    result = opt.optimize(OptimizeRequest(scenario=HYBRID, min_clean_share=0.8), use_precomputed=False)
    return result, time.perf_counter() - started


@pytest.fixture(scope="module")
def mid():
    """A quick 50% target run (no wind, few finalists)."""
    return optimize(OptimizeRequest(scenario=HYBRID, min_clean_share=0.5, **QUICK), use_precomputed=False)


# 1 ---------------------------------------------------------------------------------------------
def test_screen_matches_simulate_for_a_preset_mix():
    sc = _hybrid(grid_charging=False)
    ctx = context(OptimizeRequest(scenario=sc, project=ProjectOptions(projection_years=0), placement="campus_only"))
    mw = {a.kind: a.capacity_mw for a in sc.assets}
    batt = next(a for a in sc.assets if a.kind == "battery")
    mix = Mix.of(ctx.peak_mw, mw["solar_pv"], 0.0, mw["battery"], batt.duration_h, gas_cc_mw=mw["gas_cc"])
    s = screen(ctx, mix, size_gas=False)
    catalog = get_catalog()
    for scenario in (sc, scenario_for(ctx, mix)):  # the preset itself, and the optimizer's own assets
        sim = simulate(scenario, catalog)
        assert s.summary.unmet_mwh == pytest.approx(sim.summary.unmet_mwh, abs=1e-6)
        assert s.summary.hours_unmet == sim.summary.hours_unmet
        assert s.summary.onsite_clean_share == pytest.approx(sim.summary.onsite_clean_share, rel=1e-9)
        assert s.summary.imports_mwh == pytest.approx(sim.summary.imports_mwh, rel=1e-9)
    ev = evaluate(sc, simulate(sc, catalog), catalog)
    assert s.est_t_co2e == pytest.approx(ev.emissions.annual_t_co2e, rel=0.01)
    assert s.est_capex_usd == pytest.approx(ev.economics.capex_total_usd, rel=0.01)

    # Gas sized by the screen (no firm floor, so the worst-unmet-hour passes run) matches the engine too.
    ctx = context(OptimizeRequest(scenario=sc, project=ProjectOptions(projection_years=0), require_reserve_margin=False, placement="campus_only"))
    sized = screen(ctx, Mix.of(ctx.peak_mw, mw["solar_pv"], 0.0, mw["battery"], batt.duration_h))
    sim = simulate(scenario_for(ctx, sized.mix), catalog)
    assert sized.mix.gas_cc_mw > 0
    assert sized.summary.hours_unmet == sim.summary.hours_unmet == 0
    for key in ("imports_mwh", "onsite_clean_share", "curtailed_mwh"):
        assert getattr(sized.summary, key) == pytest.approx(getattr(sim.summary, key), rel=1e-9, abs=1e-6)
    assert sized.summary.generation_mwh["gas_cc"] == pytest.approx(sim.summary.generation_mwh["gas_cc"], rel=1e-9)


def test_screen_sizes_gas_to_serve_every_hour_and_the_firm_floor():
    ctx = context(OptimizeRequest(scenario=HYBRID, placement="campus_only"))
    s = screen(ctx, Mix.of(ctx.peak_mw, 0.5 * ctx.peak_mw, 0.0, 0.25 * ctx.peak_mw, 4.0))
    assert s.summary.hours_unmet == 0
    assert s.mix.gas_cc_mw > 0
    sim = simulate(scenario_for(ctx, s.mix), get_catalog())
    firm = next(f for f in stress_test(scenario_for(ctx, s.mix), sim) if f.id == "firm_capacity")
    assert firm.metric >= 15.0


# 2 ---------------------------------------------------------------------------------------------
def test_recommended_is_feasible(demo):
    result, _ = demo
    rec = result["recommended"]
    assert rec is not None, result.get("message")
    catalog = get_catalog()
    for key in ("projected_scenario", "scenario"):
        sc = type(HYBRID).model_validate(rec[key])
        sim = simulate(sc, catalog)
        findings = stress_test(sc, sim)
        assert sim.summary.hours_unmet <= 0
        assert not [f.id for f in findings if f.severity == "fail" and f.id not in opt.SITE_LEVEL_FINDINGS]
    sc = type(HYBRID).model_validate(rec["projected_scenario"])
    sim = simulate(sc, catalog)
    ev = evaluate(sc, sim, catalog)
    assert sim.summary.onsite_clean_share >= 0.8 - 1e-9
    assert rec["onsite_clean_share"] == pytest.approx(sim.summary.onsite_clean_share, rel=1e-6)
    assert rec["npc_usd"] == pytest.approx(ev.economics.npc_usd, rel=1e-6)
    assert rec["passes_checks"] and not rec["failed_checks"]
    assert rec["findings_count"]["fail"] == 0
    assert rec["scenario"]["demand"]["peak_mw"] == HYBRID.demand.peak_mw  # current demand, like the planner
    assert rec["projected_scenario"]["demand"]["peak_mw"] == pytest.approx(result["projection"]["peak_mw"])


# 3 ---------------------------------------------------------------------------------------------
@pytest.mark.parametrize("target", [0.0, 0.5])
def test_beats_the_rule_based_plan_when_it_passes(target):
    req = OptimizeRequest(scenario=HYBRID, min_clean_share=target, **QUICK)
    result = optimize(req, use_precomputed=False)
    base = result["baseline"]
    assert base["label"] == "Rule-based plan"
    plan = plan_project(PlanRequest(scenario=HYBRID, renewable_energy_share=target))
    assert base["lcoe_usd_per_mwh"] == pytest.approx(plan["projection"]["lcoe_usd_per_mwh"], rel=1e-6)
    if base["passes_checks"]:
        assert result["recommended"]["npc_usd"] <= base["npc_usd"] * (1 + 1e-9)
    if result["recommended"]:
        assert result["vs_baseline"]["npc_usd"] == pytest.approx(result["recommended"]["npc_usd"] - base["npc_usd"])


# 4 ---------------------------------------------------------------------------------------------
def test_frontier_is_sorted_and_non_dominated(demo, mid):
    for result in (demo[0], mid):
        front = result["frontier"]
        assert front
        cost = [p["lcoe_usd_per_mwh"] for p in front]
        co2 = [p["annual_t_co2e"] for p in front]
        assert cost == sorted(cost)
        for i, p in enumerate(front):
            for j, q in enumerate(front):
                if i != j:
                    assert not (q["lcoe_usd_per_mwh"] <= p["lcoe_usd_per_mwh"] and q["annual_t_co2e"] <= p["annual_t_co2e"]
                                and (q["lcoe_usd_per_mwh"], q["annual_t_co2e"]) != (p["lcoe_usd_per_mwh"], p["annual_t_co2e"]))
        rec = result["recommended"]
        assert any(p["candidate_id"] == rec["candidate_id"] and p["recommended"] for p in front)  # the cheapest passing design is on it
        assert all(p["exact"] is True and p["scenario"]["assets"] for p in front)  # each point loads into the builder


# 5 ---------------------------------------------------------------------------------------------
def test_raising_the_target_raises_clean_share_and_cost(demo, mid):
    low, high = mid["recommended"], demo[0]["recommended"]
    assert low["onsite_clean_share"] >= 0.5 - 1e-9
    assert high["onsite_clean_share"] >= 0.8 - 1e-9
    assert high["npc_usd"] >= low["npc_usd"]
    assert high["annual_t_co2e"] <= low["annual_t_co2e"]


# 6 ---------------------------------------------------------------------------------------------
def test_impossible_targets_fail_softly():
    sc = HYBRID.model_copy(deep=True)
    sc.grid.connected = False
    payload = OptimizeRequest(scenario=sc, min_clean_share=1.0, include_wind=False, max_finalists=4, placement="campus_only").model_dump(mode="json")
    response = TestClient(app).post("/api/projects/optimize", json=payload)
    assert response.status_code == 200
    body = response.json()
    assert body["available"] is True
    assert body["recommended"] is None
    assert body["main_reason"] == "clean_share_below_target"
    assert body["message"] and body["rejected_by_reason"]["clean_share_below_target"] == body["tested"]
    assert body["search"]["widened"]  # the wider grid was tried before giving up


# 7 ---------------------------------------------------------------------------------------------
def _ranks(x):
    return np.argsort(np.argsort(np.asarray(x)))


def test_estimate_ranks_like_exact_cost(demo):
    judged = [c for c in demo[0]["candidates"] if c["exact"] and c["exact"]["npc_usd"] is not None]
    assert len(judged) >= 5
    est = _ranks([c["est_cost_usd_per_yr"] for c in judged])
    exact = _ranks([c["exact"]["npc_usd"] for c in judged])
    rho = np.corrcoef(est, exact)[0, 1]
    assert rho > 0.8


# 8 ---------------------------------------------------------------------------------------------
def test_default_demo_request_runtime_budget(demo):
    result, seconds = demo
    assert seconds < 15
    assert result["runtime_ms"] < 15000
    assert result["tested"] >= 189
    assert "Least-cost among" in result["basis"] and "Not a certified design." in result["basis"]


# API, caching and validation -----------------------------------------------------------------
def test_response_is_json_safe_and_complete(mid):
    import json

    text = json.dumps(mid, allow_nan=False)  # raises on NaN / inf
    assert len(text) < 2_000_000
    for key in ("available", "basis", "tested", "finalists", "recommended", "alternatives", "frontier", "candidates",
                "rejected_by_reason", "baseline", "vs_baseline", "presets", "runtime_ms", "provenance", "projection", "targets",
                "search", "placement"):
        assert key in mid
    assert {p["id"] for p in mid["presets"]} == {"grid_connected", "hybrid", "renewable_heavy"}
    hybrid = next(p for p in mid["presets"] if p["id"] == "hybrid")
    assert 20 < hybrid["lcoe_usd_per_mwh"] < 300 and hybrid["hours_unmet"] == 0
    assert mid["tested"] == len(mid["candidates"])
    statuses = {c["status"] for c in mid["candidates"]}
    assert statuses <= {"rejected", "screened", "failed", "passed", "recommended"}
    assert sum(c["status"] == "recommended" for c in mid["candidates"]) == 1
    assert all(c["reason"] in mid["reasons"] for c in mid["candidates"] if c["reason"])
    assert mid["provenance"] and all("kind" in p and "source" in p for p in mid["provenance"])


def test_in_process_cache_returns_a_copy():
    req = OptimizeRequest(scenario=HYBRID, min_clean_share=0.3, **QUICK)
    first = optimize(req, use_precomputed=False)
    started = time.perf_counter()
    second = optimize(req, use_precomputed=False)
    assert time.perf_counter() - started < 0.5
    assert second == first and second is not first
    second["recommended"]["npc_usd"] = -1
    assert optimize(req, use_precomputed=False)["recommended"]["npc_usd"] != -1


def test_committed_cache_is_served_when_the_request_matches(tmp_path, monkeypatch):
    req = OptimizeRequest(scenario=HYBRID, min_clean_share=0.2, **QUICK)
    path = opt.write_cache("unit_test", req, out_dir=tmp_path)
    monkeypatch.setattr(opt, "CACHE_DIR", tmp_path)
    opt.clear_cache()
    # Assets, name and preset are ignored by the search, so they don't change the hash.
    other = req.model_copy(deep=True)
    other.scenario.assets = []
    other.scenario.name = "Edited"
    hit = optimize(other)
    assert hit["precomputed"] is True and "precomputed" in hit["basis"]
    assert path.exists()
    miss = optimize(OptimizeRequest(scenario=HYBRID, min_clean_share=0.25, **QUICK))
    assert miss["precomputed"] is False


def test_committed_demo_response_still_matches_the_demo_request():
    """optimize_cache/kern_80.json is what the demo plays. After bumping OPTIMIZER_VERSION or changing the
    preset, its hash no longer matches and the demo would silently search live: rewrite it then."""
    path = opt.CACHE_DIR / "kern_80.json"
    assert path.exists(), "missing demo response: python -m app.builder.optimizer --write-cache kern_80"
    stored = json.loads(path.read_text(encoding="utf-8"))
    req = opt.demo_requests()["kern_80"]
    assert stored["request_hash"] == opt.request_hash(req), "stale demo response: python -m app.builder.optimizer --write-cache kern_80"
    rec = stored["response"]["recommended"]
    assert rec["passes_checks"] and rec["onsite_clean_share"] >= 0.8 and rec["hours_unmet"] == 0
    json.dumps(stored["response"], allow_nan=False)
    opt.clear_cache()
    try:
        started = time.perf_counter()
        hit = optimize(req)
        assert hit["precomputed"] is True and hit["recommended"]["npc_usd"] == rec["npc_usd"]
        assert time.perf_counter() - started < 2
    finally:
        opt.clear_cache()


@pytest.mark.parametrize("patch", [
    {"min_clean_share": 1.5}, {"max_finalists": 0}, {"battery_durations_h": [0]}, {"clean_metric": "annual"},
    {"placement": "anywhere"}, {"project": {"annual_demand_growth": -1}},
])
def test_invalid_inputs_return_422(patch):
    payload = {"scenario": HYBRID.model_dump(mode="json"), **patch}
    assert TestClient(app).post("/api/projects/optimize", json=payload).status_code == 422


def test_planner_limits_return_422_with_the_planner_messages():
    sc = HYBRID.model_dump(mode="json")
    sc["demand"]["peak_mw"] = 0
    response = TestClient(app).post("/api/projects/optimize", json={"scenario": sc})
    assert response.status_code == 422 and "Peak demand" in response.text
    sc["demand"]["peak_mw"] = 20000
    response = TestClient(app).post("/api/projects/optimize", json={"scenario": sc, "project": {"annual_demand_growth": 0.3, "projection_years": 10}})
    assert response.status_code == 422 and "50,000 MW" in response.text


def test_cfe_target_is_judged_on_the_exact_24_7_score():
    req = OptimizeRequest(scenario=HYBRID, min_clean_share=0.3, clean_metric="cfe_24_7", **QUICK)
    result = optimize(req, use_precomputed=False)
    rec = result["recommended"]
    assert rec is not None
    assert rec["cfe_score_24_7"] >= 0.3
    assert all(c["cfe_score_24_7"] is not None for c in result["candidates"])  # screened on the hourly score too


# Site-model placement (plan: "Using the ML site recommendations") -------------------------------
@pytest.fixture(scope="module")
def demo_campus():
    """The demo request with every MW at the campus."""
    return optimize(OptimizeRequest(scenario=HYBRID, min_clean_share=0.8, placement="campus_only"), use_precomputed=False)


def _scenarios(result):
    rec = result["recommended"]
    yield from (rec["scenario"], rec["projected_scenario"])
    yield from (a["scenario"] for a in result["alternatives"])
    yield from (p["scenario"] for p in result["frontier"])
    yield from (c["scenario"] for c in result["candidates"] if c["scenario"])


def test_placement_never_costs_more(demo, demo_campus):
    site, campus = demo[0], demo_campus
    assert site["placement"]["requested"] == "site_model" and campus["placement"]["used"] == "campus_only"
    rec, base = site["recommended"], campus["recommended"]
    assert rec and base
    assert rec["npc_usd"] <= base["npc_usd"] * (1 + 1e-9)
    if site["placement"]["used"] == "campus_only":  # fell back: the same search, so the same answer
        assert rec["npc_usd"] == pytest.approx(base["npc_usd"], rel=1e-9)
    # campus_only: the winning mix judged once more with every MW at the campus.
    c = site["campus_only"]
    assert c is not None and campus["campus_only"] is None
    for kind in ("solar_pv", "onshore_wind", "battery"):
        assert c["assets_mw"][kind] == pytest.approx(rec["assets_mw"][kind])
    if c["same_as_recommended"]:
        assert c["npc_usd"] == pytest.approx(rec["npc_usd"], rel=1e-9)
    else:  # kept the remote placement: the campus version costs more or fails a check
        assert rec["npc_usd"] <= c["npc_usd"] or not c["passes_checks"]
        assert c["recommended_minus_campus"]["npc_usd"] == pytest.approx(rec["npc_usd"] - c["npc_usd"])
    assert site["placement"]["weather_consistent"] is True  # the exact run used the screen's profiles
    json.dumps(site, allow_nan=False)


def test_no_candidate_is_overfilled(demo):
    result = demo[0]
    caps = {(k, o["id"]): o["max_mw"] for k, opts in result["placement"]["options"].items() for o in opts if o["max_mw"] is not None}
    for sc in _scenarios(result):
        placed = Counter()
        for a in sc["assets"]:
            if a["kind"] not in opt.RENEWABLE:
                assert a["location"] is None  # gas and batteries stay at the campus
                continue
            if a["location"] is None:
                continue
            key = (a["kind"], a["id"].removeprefix(f"opt-{a['kind']}-"))
            assert key in caps, a["id"]
            placed[key] += a["capacity_mw"]
        assert all(mw <= caps[key] + 1e-6 for key, mw in placed.items())
    rec = result["recommended"]
    for row in rec["placement"]:
        if row["candidate_id"]:
            assert row["location"] and row["mw"] <= row["candidate"]["candidate_mw"] + 1e-6 and row["gen_tie_usd"] >= 0
    if any(row["location"] for row in rec["placement"]):  # remote assets carry the needs_utility_study finding
        f = next(f for f in rec["findings"] if f["id"] == "remote_generation_delivery")
        assert f["needs_utility_study"] and f["severity"] == "warn"


def _option(kind, cf, mw=math.inf, oid="campus", location=None, fixed_usd=0.0):
    return SiteOption(oid, kind, np.asarray(cf, float), mw, location, fixed_usd=fixed_usd, label=oid)


def test_rank_fills_cheapest_first_and_never_overfills():
    spec, n = get_catalog().spec("onshore_wind"), 8784
    home = _option("onshore_wind", np.full(n, 0.10))
    good = _option("onshore_wind", np.full(n, 0.30), 70.0, "good", LngLat(lon=-118.3, lat=35.05), fixed_usd=2e6)
    better = _option("onshore_wind", np.full(n, 0.35), 50.0, "better", LngLat(lon=-118.2, lat=35.1), fixed_usd=9e6)
    poor = _option("onshore_wind", np.full(n, 0.08), 90.0, "poor", LngLat(lon=-118.1, lat=35.2))
    order, rows = placement.rank("onshore_wind", spec, 0.07, home, [poor, good, better])
    assert [o.id for o in order] == ["better", "good", "campus"]  # dearer than the campus: reported, never filled
    assert {r["id"]: r["used"] for r in rows} == {"better": True, "good": True, "poor": False, "campus": True}
    crf = opt._crf(0.07, spec.lifetime_years)
    by_hand = (crf * (1000 * spec.capex_usd_per_kw + 2e6 / 70.0) + 1000 * spec.fixed_om_usd_per_kw_yr) / (0.30 * n) + spec.var_om_usd_per_mwh
    assert good.info["cost_usd_per_mwh"] == pytest.approx(by_hand, rel=1e-12)
    for mw in (0.0, 30.0, 50.0, 100.0, 500.0):
        parts = opt.allocate(order, mw)
        assert sum(p for _, p in parts) == pytest.approx(mw)
        assert all(p <= o.max_mw + 1e-9 for o, p in parts)
        assert [o.id for o, _ in parts] == [o.id for o in order][: len(parts)]  # cheapest first, the campus takes the rest
    assert [(o.id, p) for o, p in opt.allocate(order, 100.0)] == [("better", 50.0), ("good", 50.0)]


def test_placed_assets_blend_in_the_screen_and_fold_the_gen_tie_into_evaluate():
    """A remote cell (the pre-baked Tehachapi site): the screen's blend is what simulate() produces, and
    evaluate() counts the gen-tie through overrides["capex_usd_per_kw"]."""
    ctx = context(OptimizeRequest(scenario=_hybrid(grid_charging=False), project=ProjectOptions(projection_years=0), placement="campus_only"))
    w = profiles.site_weather(35.05, -118.30, ctx.projected.assumptions.weather_year)
    cell = SiteOption("t1", "onshore_wind", w.wind_cf, 150.0, LngLat(lon=-118.30, lat=35.05), fixed_usd=6e6, label="Tehachapi",
                      info={"candidate_id": "site-onshore_wind-t1"})
    ctx.place = opt.Placement("site_model", {"solar_pv": opt._campus(ctx.prep)["solar_pv"],
                                             "onshore_wind": [cell, *opt._campus(ctx.prep)["onshore_wind"]]})
    p = ctx.peak_mw
    mix = Mix.of(p, 0.5 * p, 200.0, 0.25 * p, 4.0, gas_cc_mw=0.9 * p)
    blend = opt._blend(ctx, "onshore_wind", 200.0)
    assert blend == pytest.approx((150 * w.wind_cf + 50 * ctx.prep.drivers.wind_cf) / 200)
    s = screen(ctx, mix, size_gas=False)
    sc = scenario_for(ctx, mix)
    wind = [a for a in sc.assets if a.kind == "onshore_wind"]
    assert [(a.id, a.capacity_mw, a.location is not None) for a in wind] == [("opt-onshore_wind-t1", 150.0, True), ("opt-onshore_wind", 50.0, False)]
    base = get_catalog().spec("onshore_wind").capex_usd_per_kw
    assert wind[0].overrides["capex_usd_per_kw"] == pytest.approx(base + 6e6 / 150_000)
    catalog = get_catalog()
    sim = simulate(sc, catalog)
    assert s.summary.hours_unmet == sim.summary.hours_unmet
    assert s.summary.onsite_clean_share == pytest.approx(sim.summary.onsite_clean_share, rel=1e-9)
    assert s.summary.imports_mwh == pytest.approx(sim.summary.imports_mwh, rel=1e-9)
    assert opt._weather_matches(ctx, opt.Judged(mix, sc, sim, None, [], [], place=ctx.place))
    ev = evaluate(sc, sim, catalog)
    plain = sc.model_copy(deep=True)
    plain.assets[[a.id for a in plain.assets].index("opt-onshore_wind-t1")].overrides = {}
    assert ev.economics.capex_total_usd - evaluate(plain, sim, catalog).economics.capex_total_usd == pytest.approx(6e6, rel=1e-9)
    assert opt._capital(ctx, sc.assets)[0] - opt._capital(ctx, plain.assets)[0] == pytest.approx(6e6, rel=1e-9)  # the screen counts it too
    assert s.est_capex_usd == pytest.approx(ev.economics.capex_total_usd, rel=0.01)
    f = placement.delivery_finding(sc)
    assert f.needs_utility_study and f.metric > 0 and "150 MW of wind" in f.detail


def test_a_dearer_remote_placement_is_replaced_by_the_campus_version():
    """Placement never costs more for the winning mix: a cell with the campus's own weather but a $500M
    gen-tie loses to the same mix at the campus, which then becomes the recommendation."""
    ctx = context(OptimizeRequest(scenario=HYBRID, project=ProjectOptions(projection_years=0), placement="campus_only"))
    campus = opt._campus(ctx.prep)
    pricey = SiteOption("x", "solar_pv", ctx.prep.drivers.solar_cf, 200.0, LngLat(lon=-119.47, lat=35.40), fixed_usd=5e8, label="pricey",
                        info={"candidate_id": "site-solar_pv-x", "candidate_mw": 200.0})
    ctx.place = opt.Placement("site_model", {"solar_pv": [pricey, *campus["solar_pv"]], "onshore_wind": campus["onshore_wind"]})
    s = screen(ctx, Mix.of(ctx.peak_mw, 0.5 * ctx.peak_mw, 0.0, 0.25 * ctx.peak_mw, 4.0))
    s.judged = remote = opt.judge(ctx, s.mix)
    assert remote.passes and opt._has_remote(remote.scenario)
    judged, passing = [remote], [remote]
    best, block = opt._vs_campus(ctx, remote, judged, passing, {s.mix.key: s})
    assert best is not remote and not opt._has_remote(best.scenario) and best.passes
    assert judged == [best] and passing == [best] and s.judged is best
    assert block["same_as_recommended"] and block["npc_usd"] == best.evaluation.economics.npc_usd
    assert 0.8 * 5e8 < block["site_model_placement"]["npc_usd"] - block["npc_usd"] <= 5e8 * (1 + 1e-9)  # less the gen-tie's salvage value
    assert any("keeps every MW at the campus" in n for n in ctx.notes)


def _cell(cid, kind, region, suitability, lat, lon, mw=100.0, gen_tie=1e6, county="Kern"):
    return SiteCandidate(id=f"site-{kind}-{cid}", kind=kind, mw=mw, location=LngLat(lon=lon, lat=lat), county=county, region=region,
                         suitability=suitability, d_line_hv_km=1.0, gen_tie_usd=gen_tie, reason="test cell")


def test_campus_region_and_top_cells():
    campus = HYBRID.site.location
    near = [_cell(i, "solar_pv", "SCE" if i < 3 else "PGAE", 0.9, campus.lat + 0.01 * i, campus.lon) for i in range(6)]
    rec = SiteRecommendation(available=True, mode="model", scenario="mid", year=2035, sites=near)
    no_county = HYBRID.model_copy(deep=True)
    no_county.site.county = None
    region, rule = placement.campus_region(no_county, rec, SiteRequest())
    assert region == "SCE" and "nearest" in rule  # 3 of the 5 nearest cells
    region, rule = placement.campus_region(HYBRID, rec, SiteRequest())
    if "County" in rule:  # the forecast's county mapping decides when it's available
        assert region == "PGAE"
    cells = [_cell("a", "onshore_wind", "PGAE", 0.991, 35.0, -118.3, gen_tie=5e6),
             _cell("b", "onshore_wind", "PGAE", 0.994, 35.1, -118.3, gen_tie=1e6),
             _cell("c", "onshore_wind", "PGAE", 0.95, 35.2, -118.3), _cell("d", "onshore_wind", "PGAE", 0.4, 35.3, -118.3),
             _cell("e", "onshore_wind", "SCE", 0.999, 35.4, -118.3), _cell("f", "solar_pv", "PGAE", 0.999, 35.5, -118.3),
             _cell("g", "onshore_wind", "PGAE", 0.90, 35.6, -118.3)]
    top = placement.pick(cells, "onshore_wind", "PGAE", 0.5, campus)
    assert [c.id.rsplit("-", 1)[1] for c in top] == ["b", "a", "c"]  # 0.99 (cheaper gen-tie first), then 0.95; d < 0.5, e elsewhere


def test_weather_is_bounded_and_stand_ins_match_the_exact_run(monkeypatch):
    real = profiles.site_weather
    slow_key = profiles.site_key(36.73, -119.25)

    def slow(lat, lon, year):
        if profiles.site_key(lat, lon) == slow_key:
            time.sleep(1.0)
        return real(lat, lon, year)

    monkeypatch.setattr(profiles, "site_weather", slow)
    cells = [_cell("slow", "solar_pv", "PGAE", 0.9, 36.73, -119.25), _cell("far", "solar_pv", "PGAE", 0.9, 36.61, -119.71)]
    started = time.perf_counter()
    weather, notes = placement.load_weather(cells, 2024, budget_s=0.2)
    assert time.perf_counter() - started < 0.9
    assert set(weather) == {"site-solar_pv-far"} and any("didn't arrive" in n for n in notes)
    monkeypatch.setattr(profiles, "site_weather", real)
    # Offline here (see offline_weather), so the uncached cell gets profiles' stand-in: the nearest pre-baked site.
    w = weather["site-solar_pv-far"]
    if w.source_key != w.key:
        assert any("stand-in" in n for n in notes)
    sc = _hybrid()
    sc.assets = [Asset(id="opt-solar_pv-far", kind="solar_pv", capacity_mw=400.0, location=cells[1].location)]
    sim = simulate(sc, get_catalog())
    assert np.allclose(sim.hourly.generation_mw["solar_pv"], 400.0 * np.clip(w.solar_cf, 0, 1), atol=2e-3)


@pytest.mark.parametrize("broken", ["unavailable", "raises"])
def test_site_service_problems_fall_back_to_the_campus(monkeypatch, mid, broken):
    from app.sites import service

    def recommend(req):
        if broken == "raises":
            raise RuntimeError("site artifact missing")
        return SiteRecommendation(available=False, mode="unavailable", scenario="mid", year=2035)

    monkeypatch.setattr(service, "recommend", recommend)
    opt.clear_cache()  # the same request runs per parametrization; don't serve the other one's memo
    result = optimize(OptimizeRequest(scenario=HYBRID, min_clean_share=0.5, **{**QUICK, "placement": "site_model"}), use_precomputed=False)
    opt.clear_cache()
    assert result["placement"]["requested"] == "site_model" and result["placement"]["used"] == "campus_only"
    assert result["placement"]["notes"] and result["placement"]["weather_consistent"] is True
    assert result["recommended"]["npc_usd"] == pytest.approx(mid["recommended"]["npc_usd"], rel=1e-9)
    assert result["campus_only"]["same_as_recommended"] is True
    assert all(row["location"] is None for row in result["recommended"]["placement"])
