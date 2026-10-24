"""End-to-end checks on simulate() with the real cached profiles.  OWNER: workstream B.

These encode the brief's "Done means": Hybrid meets every hour, solar peaks at noon PST,
SOC stays in bounds, a July day is a duck curve, and simulate() is fast from cache.
Ranges and invariants only; the numbers move as data and presets get re-tuned.
"""

from __future__ import annotations

import time

import numpy as np
import pytest

from app.builder.service import list_presets
from app.contract import Asset, LngLat, Scenario
from app.evaluate.catalog import get_catalog
from app.simulate import profiles
from app.simulate.engine import simulate

CATALOG = get_catalog()
PRESETS = {p.id: p for p in list_presets()}
JUL15 = 196  # day index of Jul 15 in 2024


def _arr(x) -> np.ndarray:
    return np.asarray(x, dtype=float)


def _variant(base: Scenario, **updates) -> Scenario:
    return base.model_copy(update=updates, deep=True)


@pytest.fixture(scope="module")
def hybrid():
    return simulate(PRESETS["hybrid"], CATALOG)


def test_hybrid_meets_demand_with_real_profiles(hybrid):
    s = hybrid.summary
    assert s.hours_unmet == 0 and s.unmet_mwh == 0
    assert 0.20 <= hybrid.extras["capacity_factor"]["solar_pv"] <= 0.30
    assert hybrid.extras["curtailment_share"] < 0.10
    # Brief: >= 150 equivalent cycles/yr. With grid charging on (the default) this includes
    # price arbitrage from imports; solar-only cycling is checked in the grid-charging test.
    assert 150 <= s.battery_cycles <= 400


def test_solar_peaks_at_noon_pst(hybrid):
    """Catches UTC/DST misalignment between Open-Meteo, CAISO and the chart. A tracker's
    output is a flat plateau (~09-14 PST), so use the output-weighted centroid of the
    interval midpoints rather than argmax; a 1 h shift moves it by a full hour."""
    solar = _arr(hybrid.hourly.generation_mw["solar_pv"])
    by_hour = solar.reshape(-1, 24).mean(axis=0)
    centroid = float(((np.arange(24) + 0.5) * by_hour).sum() / by_hour.sum())
    assert abs(centroid - 12) <= 0.5, centroid
    assert abs(int(by_hour.argmax()) - 12) <= 2
    assert by_hour[[0, 1, 2, 3, 22, 23]].max() == 0
    july = solar.reshape(-1, 24)[182:213].mean(axis=0)  # DST months must not drift either
    assert abs(float(((np.arange(24) + 0.5) * july).sum() / july.sum()) - 12) <= 0.5


def test_soc_within_bounds(hybrid):
    soc = _arr(hybrid.hourly.battery_soc_mwh)
    cap = hybrid.extras["battery_energy_mwh"]
    assert soc.min() >= -1e-6 and soc.max() <= cap + 1e-3
    charge, discharge = _arr(hybrid.hourly.battery_charge_mw), _arr(hybrid.hourly.battery_discharge_mw)
    assert not np.any((charge > 1e-6) & (discharge > 1e-6))


def test_july_day_is_a_duck_curve(hybrid):
    h = hybrid.hourly
    day = slice(JUL15 * 24, JUL15 * 24 + 24)
    charge = _arr(h.battery_charge_mw[day])
    discharge = _arr(h.battery_discharge_mw[day])
    firm = _arr(h.imports_mw[day]) + _arr(h.generation_mw["gas_cc"][day])
    assert charge[10:15].sum() > 0  # midday surplus charges the battery
    assert discharge[17:21].sum() > 0  # the battery covers the evening ramp
    assert firm[0:4].min() > 0 and firm[10:15].max() < firm[0:4].min()  # gas + imports carry the night


def test_real_grid_profiles_reach_the_result(hybrid):
    h, n = hybrid.hourly, len(hybrid.hourly.demand_mw)
    price, co2 = _arr(h.price_usd_per_mwh), _arr(h.grid_co2_kg_per_mwh)
    cfe = _arr(hybrid.extras["grid_cfe_share"])
    assert len(cfe) == n and cfe.min() >= 0 and cfe.max() <= 1
    assert 20 <= price.mean() <= 100 and price.std() > 5  # real LMPs, not a stub
    assert 100 <= co2.mean() <= 300
    assert co2.reshape(-1, 24)[:, 11:14].mean() < co2.reshape(-1, 24)[:, 0:5].mean()
    assert hybrid.extras["price_node"] == "DLAP_PGAE-APND"
    assert any(p.kind == "observed" and "CAISO" in p.source for p in hybrid.provenance)


@pytest.mark.parametrize("preset", list(PRESETS))
def test_simulate_is_fast_from_cache(preset):
    simulate(PRESETS[preset], CATALOG)  # warm the profile cache
    t = time.perf_counter()
    simulate(PRESETS[preset], CATALOG)
    assert time.perf_counter() - t < 1.0


@pytest.mark.parametrize("profile", ["flat", "ai_training", "ai_inference", "community"])
def test_demand_profiles_hit_peak_and_load_factor(profile):
    base = PRESETS["hybrid"]
    sc = _variant(base, demand=base.demand.model_copy(update={"profile": profile, "load_factor": 0.85}))
    sim = simulate(sc, CATALOG)
    demand = _arr(sim.hourly.demand_mw)
    assert abs(demand.mean() - sc.demand.peak_mw * 0.85) / (sc.demand.peak_mw * 0.85) < 0.01
    assert demand.max() <= sc.demand.peak_mw + 1e-3


def test_non_leap_weather_year_has_8760_hours():
    base = PRESETS["hybrid"]
    sc = _variant(base, assumptions=base.assumptions.model_copy(update={"weather_year": 2023}))
    sim = simulate(sc, CATALOG)
    assert len(sim.hourly.demand_mw) == 8760
    assert len(sim.extras["grid_cfe_share"]) == 8760
    assert any("reused" in (p.note or "") for p in sim.provenance)


def test_islanded_campus_never_imports():
    base = PRESETS["hybrid"]
    sc = _variant(base, grid=base.grid.model_copy(update={"connected": False}))
    sim = simulate(sc, CATALOG)
    assert max(sim.hourly.imports_mw) == 0 and max(sim.hourly.exports_mw) == 0
    assert sim.summary.hours_unmet > 0  # 600 MW of gas can't carry a 900 MW night alone


def test_grid_charging_pays_for_itself_and_can_be_turned_off(hybrid):
    off = simulate(_variant(PRESETS["hybrid"], options={"grid_charging": False}), CATALOG)
    assert off.extras["battery_grid_charge_mwh"] == 0
    assert hybrid.extras["battery_grid_charge_mwh"] > 0
    assert hybrid.summary.battery_cycles > off.summary.battery_cycles
    assert off.summary.battery_cycles >= 140  # solar shifting alone stays near the brief's 150

    def energy_cost(sim):
        h, mc = sim.hourly, sim.extras["marginal_cost_usd_per_mwh"]
        imports = _arr(h.imports_mw) @ (_arr(h.price_usd_per_mwh) + PRESETS["hybrid"].assumptions.import_adder_usd_per_mwh)
        return imports + mc["gas_cc"] * _arr(h.generation_mw["gas_cc"]).sum()

    assert energy_cost(hybrid) < energy_cost(off)


def test_grid_charging_is_disclosed_hourly_and_in_provenance(hybrid):
    """Grid charging changes the cycles a judge sees, so it needs a Provenance and an hourly series."""
    n, h = len(hybrid.hourly.demand_mw), hybrid.hourly
    gc = _arr(hybrid.extras["battery_grid_charge_mw"])
    assert len(gc) == n and gc.min() >= 0
    assert np.all(gc <= _arr(h.battery_charge_mw)) and np.all(gc <= _arr(h.imports_mw))
    assert np.allclose(gc, np.round(gc, 3))  # 0.01 MW steps, or clipped to a 0.001 MW series
    assert abs(gc.sum() - hybrid.extras["battery_grid_charge_mwh"]) <= 0.01 * n
    gc_prov = [p for p in hybrid.provenance if "grid imports" in p.source and "grid_charging" in p.source]
    assert len(gc_prov) == 1 and gc_prov[0].kind == "assumption"

    off = simulate(_variant(PRESETS["hybrid"], options={"grid_charging": False}), CATALOG)
    assert len(off.extras["battery_grid_charge_mw"]) == n and max(off.extras["battery_grid_charge_mw"]) == 0
    assert not any("grid_charging" in p.source for p in off.provenance)
    no_batt = [a for a in PRESETS["hybrid"].assets if a.kind != "battery"]
    assert not any("grid_charging" in p.source for p in simulate(_variant(PRESETS["hybrid"], assets=no_batt), CATALOG).provenance)


def test_rounding_never_exceeds_caps():
    """Limits with more than 3 decimals (the UI's peak rescaling makes them) must still hold in the payload."""
    base = PRESETS["hybrid"]
    k = 1000 / 1030  # peak 1030 -> 1000 in the builder rescales every capacity and limit by this
    assets = [a.model_copy(update={"capacity_mw": a.capacity_mw * k if a.kind == "battery" else 718.4466019417475 if a.kind == "gas_cc" else a.capacity_mw}) for a in base.assets]
    sc = _variant(base, assets=assets, grid=base.grid.model_copy(update={"import_limit_mw": 300.97087378640776}))
    sim = simulate(sc, CATALOG)
    h = sim.hourly
    assert max(h.generation_mw["gas_cc"]) <= 718.4466019417475
    assert max(h.imports_mw) <= 300.97087378640776
    assert abs(max(h.imports_mw) - sim.summary.peak_import_mw) < 1e-6  # summary and hourly agree
    batt_mw = sum(a.capacity_mw for a in assets if a.kind == "battery")
    assert max(h.battery_charge_mw) <= batt_mw and max(h.battery_discharge_mw) <= batt_mw
    assert max(h.battery_soc_mwh) <= sim.extras["battery_energy_mwh"]
    for kind, series in h.generation_mw.items():
        assert max(series) <= sum(a.capacity_mw for a in assets if a.kind == kind)
    gen = np.sum([_arr(v) for v in h.generation_mw.values()], axis=0)
    supply = gen + _arr(h.battery_discharge_mw) + _arr(h.imports_mw) + _arr(h.unmet_mw)
    sinks = _arr(h.battery_charge_mw) + _arr(h.exports_mw) + _arr(h.curtailed_mw)
    assert np.abs(_arr(h.demand_mw) - (supply - sinks)).max() <= 0.01  # contract allows 0.05


def test_community_fallback_shape_claims_no_cooling(monkeypatch):
    """demand.py applies no PUE to the community shape, so its provenance must not say it does."""
    monkeypatch.setattr(profiles, "community_shape", lambda year: None)
    base = PRESETS["hybrid"]
    sim = simulate(_variant(base, demand=base.demand.model_copy(update={"profile": "community"})), CATALOG)
    demand_prov = [p for p in sim.provenance if p.source.startswith("Demand:")]
    assert len(demand_prov) == 1 and "PUE" not in demand_prov[0].source


def test_weather_provenance_names_the_real_model(hybrid):
    """2024 Open-Meteo best_match data is the ECMWF IFS ~9 km analysis, not ERA5."""
    wx = next(p for p in hybrid.provenance if p.source.startswith("Open-Meteo"))
    assert "IFS" in (wx.note or "") and "ERA5-based" not in (wx.note or "")


def test_synthetic_grid_price_has_one_evening_peak():
    price, _, _ = profiles._synthetic_grid(48)
    day = price[:24]
    assert int(day.argmax()) == 19
    assert day[5:9].max() < day[17:22].min()  # no morning bump (sin() alone peaked at 07:00 too)
    assert np.array_equal(price[:24], price[24:])


def test_flat_price_source():
    base = PRESETS["hybrid"]
    sc = _variant(base, assumptions=base.assumptions.model_copy(update={"price_source": "flat", "flat_price_usd_per_mwh": 55.0}))
    sim = simulate(sc, CATALOG)
    assert set(sim.hourly.price_usd_per_mwh) == {55.0}


def test_wind_asset_uses_its_own_location():
    base = PRESETS["renewable_heavy"]
    tehachapi = LngLat(lon=-118.30, lat=35.05)
    assets = [a.model_copy(update={"location": tehachapi}) if a.kind == "onshore_wind" else a for a in base.assets]
    at_site = simulate(base, CATALOG).extras["capacity_factor"]["onshore_wind"]
    moved = simulate(_variant(base, assets=assets), CATALOG).extras["capacity_factor"]["onshore_wind"]
    assert moved > 3 * at_site  # Kern valley floor is calm; Tehachapi pass is not


def test_unknown_site_falls_back_to_nearest_baked_site(monkeypatch):
    from app.simulate import weather

    real = weather.load_or_fetch

    def offline(lat, lon, year, allow_network=True):
        if profiles.site_key(lat, lon) == "35.50_-119.60":
            raise weather.WeatherUnavailable("network down")
        return real(lat, lon, year, allow_network=False)

    monkeypatch.setattr(weather, "load_or_fetch", offline)
    profiles.clear_weather_cache()
    try:
        base = PRESETS["hybrid"]
        sc = _variant(base, site=base.site.model_copy(update={"location": LngLat(lon=-119.60, lat=35.50)}))
        sim = simulate(sc, CATALOG)
        assert any("nearest pre-baked site" in n for n in sim.extras["notes"])
        assert 0.20 <= sim.extras["capacity_factor"]["solar_pv"] <= 0.30
        assert sim.extras["weather_site"] == "35.40_-119.47"  # the stand-in actually used, not the request
        wx = next(p for p in sim.provenance if p.source.startswith("Open-Meteo"))
        assert "nearest pre-baked site" in (wx.note or "")  # visible in the Sources line too
    finally:
        profiles.clear_weather_cache()


def test_weather_fallback_is_retried_after_backoff(monkeypatch):
    """One failed fetch must not pin a site to its stand-in for the process lifetime, and the
    simulate + stress prepare() calls of one run must not each pay the fetch timeout."""
    from app.simulate import weather

    real = weather.load_or_fetch
    key = "36.30_-119.90"
    attempts = []

    def flaky(lat, lon, year, allow_network=True):
        if profiles.site_key(lat, lon) == key:
            attempts.append(allow_network)
            if len(attempts) == 1:
                raise weather.WeatherUnavailable("timeout")
            return real(37.00, -120.80, year, allow_network=False)  # "fetched" data once the network is back
        return real(lat, lon, year, allow_network=False)

    monkeypatch.setattr(weather, "load_or_fetch", flaky)
    profiles.clear_weather_cache()
    try:
        w1 = profiles.site_weather(36.30, -119.90, 2024)
        assert w1.note and "nearest pre-baked site" in w1.note and w1.source_key != key
        w2 = profiles.site_weather(36.30, -119.90, 2024)  # same run (stress): inside the backoff
        assert len(attempts) == 1 and w2.source_key == w1.source_key
        profiles._weather_failed_at[key] -= profiles.WEATHER_RETRY_S + 1  # backoff over: next run retries
        w3 = profiles.site_weather(36.30, -119.90, 2024)
        assert len(attempts) == 2 and w3.note is None and w3.source_key == key
        assert profiles.site_weather(36.30, -119.90, 2024) is w3 and len(attempts) == 2  # success is cached
        assert profiles.site_weather(36.30, -119.90, 2023).source_key == key
    finally:
        profiles.clear_weather_cache()


def test_extra_asset_kinds_and_zero_battery():
    base = PRESETS["hybrid"]
    assets = [Asset(id="ct", kind="gas_ct", capacity_mw=400), Asset(id="pv", kind="solar_pv", capacity_mw=500)]
    sim = simulate(_variant(base, assets=assets), CATALOG)
    assert sim.summary.battery_cycles == 0 and max(sim.hourly.battery_soc_mwh) == 0
    assert set(sim.hourly.generation_mw) == {"gas_ct", "solar_pv"}
