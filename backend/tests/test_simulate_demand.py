"""Unit tests for demand profiles (app/simulate/demand.py).  OWNER: workstream B."""

from __future__ import annotations

import warnings

import numpy as np
import pytest

from app.contract import DemandSpec, Finding
from app.simulate.demand import PUE_KNEE_C, DemandFitWarning, demand_profile, fit_demand, fit_shape, pue_hourly

N = 8784
PROFILES = ("ai_training", "ai_inference", "community")


def synthetic_temps(n: int = N, seed: int = 0) -> np.ndarray:
    """A Central-Valley-like year in deg C: cool winters, hot summer afternoons (~0-42 C)."""
    h = np.arange(n)
    day = h / 24.0
    season = 17.0 + 10.0 * np.sin(2 * np.pi * (day - 110) / 366)
    diurnal = (5.0 + 3.0 * np.sin(2 * np.pi * (day - 110) / 366)) * np.sin(2 * np.pi * (h % 24 - 9) / 24)
    noise = np.random.default_rng(seed).normal(0, 1.5, n)
    return season + diurnal + noise


TEMPS = synthetic_temps()


def spec(profile: str, peak: float = 1000.0, lf: float = 0.9, pue: float = 1.2) -> DemandSpec:
    return DemandSpec(peak_mw=peak, load_factor=lf, pue=pue, profile=profile)


# ---------------------------------------------------------------------------
# PUE
# ---------------------------------------------------------------------------


def test_pue_flat_below_knee_and_rising_above():
    t = np.linspace(-10, 45, 200)
    p = pue_hourly(1.2, t)
    assert (p >= 1.2).all()
    np.testing.assert_allclose(p[t <= PUE_KNEE_C], 1.2)
    assert (np.diff(p) >= 0).all() and (np.diff(p[t > PUE_KNEE_C]) > 0).all()
    assert pue_hourly(1.2, np.array([40.0]))[0] / 1.2 == pytest.approx(1.13, abs=0.02)  # ~+13% at 40 C


def test_pue_rejects_nan():
    with pytest.raises(ValueError):
        pue_hourly(1.2, np.array([20.0, np.nan]))


# ---------------------------------------------------------------------------
# flat
# ---------------------------------------------------------------------------


def test_flat_is_exactly_constant_and_ignores_temperature():
    d = demand_profile(spec("flat", lf=0.85), TEMPS)
    assert d.shape == (N,)
    assert (d == 850.0).all()
    np.testing.assert_array_equal(d, demand_profile(spec("flat", lf=0.85), TEMPS + 15))


# ---------------------------------------------------------------------------
# Shaped profiles: hit the user's peak and load factor
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("profile", PROFILES)
@pytest.mark.parametrize("lf", [0.3, 0.5, 0.7, 0.9, 0.95])
def test_shaped_profile_hits_peak_and_load_factor(profile: str, lf: float):
    d = demand_profile(spec(profile, peak=1100.0, lf=lf), TEMPS)
    assert d.shape == (N,)
    assert np.isfinite(d).all()
    assert d.min() >= 0
    assert d.max() <= 1100.0 + 1e-9
    assert d.max() == pytest.approx(1100.0, rel=0.005)
    assert d.mean() == pytest.approx(1100.0 * lf, rel=0.005)


@pytest.mark.parametrize("profile", ["ai_training", "ai_inference"])
def test_ai_demand_rises_with_temperature(profile: str):
    d = demand_profile(spec(profile), TEMPS)
    assert np.corrcoef(d, TEMPS)[0, 1] > 0
    # Same IT schedule, hotter year -> more cooling energy (before the affine fit), so
    # hot hours sit higher in the fitted profile than cold hours.
    hot, cold = TEMPS > 30, TEMPS < PUE_KNEE_C
    assert d[hot].mean() > d[cold].mean()


@pytest.mark.parametrize("profile", ["flat", *PROFILES])
def test_profiles_are_deterministic(profile: str):
    a = demand_profile(spec(profile), TEMPS)
    b = demand_profile(spec(profile), TEMPS.copy())
    np.testing.assert_array_equal(a, b)


@pytest.mark.parametrize("profile", ["flat", *PROFILES])
@pytest.mark.parametrize("n", [0, 1, 24, 8760, 8784])
def test_length_follows_temperature(profile: str, n: int):
    d = demand_profile(spec(profile), synthetic_temps(n))
    assert d.shape == (n,)
    assert np.isfinite(d).all() and (d >= 0).all() and (d <= 1000.0 + 1e-9).all()


def test_training_is_mostly_flat_with_short_dips():
    d = demand_profile(spec("ai_training", lf=0.95), np.full(N, 10.0))  # cool year: no PUE swing
    assert np.median(d) > 0.95 * 1000.0
    dips = d < 0.8 * np.median(d)
    assert 0.01 < dips.mean() < 0.10  # a few hours every few days
    starts = np.flatnonzero(dips[1:] & ~dips[:-1])
    assert 50 < starts.size < 250  # roughly every 2-5 days over a year


def test_inference_is_diurnal_with_weekend_dip():
    d = demand_profile(spec("ai_inference", lf=0.8), np.full(N, 10.0))
    by_hour = d.reshape(-1, 24).mean(axis=0)
    assert int(by_hour.argmin()) in (3, 4, 5)
    assert by_hour[10:21].min() > by_hour[0:8].max()
    weekday = (np.arange(N) // 24) % 7  # 2024-01-01 is a Monday
    assert d[weekday >= 5].mean() < d[weekday < 5].mean()


def test_community_uses_given_shape_and_ignores_temperature():
    rng = np.random.default_rng(3)
    shape = 1.0 + 0.2 * np.sin(2 * np.pi * np.arange(N) / 24) + rng.normal(0, 0.02, N)
    d = demand_profile(spec("community", lf=0.8), TEMPS, community_shape=shape)
    assert np.corrcoef(d, shape)[0, 1] > 0.999  # affine map of the given shape
    np.testing.assert_array_equal(d, demand_profile(spec("community", lf=0.8), TEMPS + 20, community_shape=shape))
    fallback = demand_profile(spec("community", lf=0.8), TEMPS)
    np.testing.assert_array_equal(fallback, demand_profile(spec("community", lf=0.8), TEMPS + 20))
    assert fallback.std() > 0


def test_community_shape_length_must_match():
    with pytest.raises(ValueError):
        demand_profile(spec("community"), TEMPS, community_shape=np.ones(N - 1))


# ---------------------------------------------------------------------------
# fit_shape edge cases
# ---------------------------------------------------------------------------


def test_fit_shape_constant_cases():
    raw = np.sin(np.arange(100.0)) + 2
    np.testing.assert_array_equal(fit_shape(raw, 500, 0.9995), np.full(100, 500 * 0.9995))  # LF ~ 1
    np.testing.assert_array_equal(fit_shape(np.full(100, 3.0), 500, 0.6), np.full(100, 300.0))  # flat shape
    np.testing.assert_array_equal(fit_shape(raw, 0, 0.6), np.zeros(100))  # no load
    np.testing.assert_array_equal(fit_shape(raw, 500, 0.0), np.zeros(100))


def test_fit_shape_rescales_after_clipping_at_zero():
    # A spiky shape whose affine map would go far below 0 at LF 0.4.
    raw = np.ones(1000)
    raw[::10] = 0.0
    raw[::7] = 3.0
    d = fit_shape(raw, 1000, 0.4)
    assert d.min() == 0.0
    assert d.max() == pytest.approx(1000.0)
    assert d.mean() == pytest.approx(400.0, rel=0.005)


def test_fit_shape_preserves_ordering():
    raw = synthetic_temps(500, seed=9)
    d = fit_shape(raw, 800, 0.7)
    order = np.argsort(raw, kind="stable")
    assert (np.diff(d[order]) >= -1e-9).all()


def test_fit_shape_unreachable_load_factor_returns_limit_shape():
    # 20% of hours tied at the max: the mean can't go below 0.2 x peak with max = peak.
    raw = np.tile([1.0, 0.5, 0.4, 0.3, 0.2], 200)
    d = fit_shape(raw, 100, 0.1)
    np.testing.assert_array_equal(d, np.where(raw == 1.0, 100.0, 0.0))
    assert d.mean() == pytest.approx(20.0)
    assert fit_shape(raw, 100, 0.21).mean() == pytest.approx(21.0, rel=0.005)  # just above the floor: reachable


# ---------------------------------------------------------------------------
# fit_demand: report when the load factor can't be reached
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("profile", ["flat", *PROFILES])
@pytest.mark.parametrize("lf", [0.3, 0.9, 1.0])
def test_fit_demand_reports_met_for_realistic_inputs(profile: str, lf: float):
    fit = fit_demand(spec(profile, lf=lf), TEMPS)
    assert fit.met and fit.note is None and fit.finding() is None
    assert fit.achieved_load_factor == pytest.approx(lf, rel=0.005)
    np.testing.assert_array_equal(fit.demand_mw, demand_profile(spec(profile, lf=lf), TEMPS))
    with warnings.catch_warnings():
        warnings.simplefilter("error", DemandFitWarning)
        demand_profile(spec(profile, lf=lf), TEMPS)  # no warning when met


def test_fit_demand_flags_unreachable_load_factor():
    # Cool year: ~21% of inference hours sit at the shape's max (11-17 PST weekdays).
    s = DemandSpec(peak_mw=100, load_factor=0.1, profile="ai_inference")
    cool = np.full(N, 10.0)
    fit = fit_demand(s, cool)
    assert not fit.met
    assert fit.target_load_factor == pytest.approx(0.1)
    assert 0.15 < fit.achieved_load_factor < 0.3
    assert fit.achieved_load_factor == pytest.approx(fit.demand_mw.mean() / 100)
    assert fit.demand_mw.max() == pytest.approx(100.0) and fit.demand_mw.min() >= 0
    assert fit.note and "ai_inference" in fit.note and "0.10" in fit.note
    finding = fit.finding()
    assert isinstance(finding, Finding)
    assert finding.module == "simulate" and finding.severity == "warn"
    assert finding.metric == pytest.approx(fit.achieved_load_factor) and finding.threshold == pytest.approx(0.1)
    with pytest.warns(DemandFitWarning, match="ai_inference"):
        d = demand_profile(s, cool)
    np.testing.assert_array_equal(d, fit.demand_mw)


def test_fit_demand_zero_peak_or_length():
    assert fit_demand(spec("ai_training", peak=0.0), TEMPS).met
    fit = fit_demand(spec("ai_inference"), np.array([]))
    assert fit.met and fit.demand_mw.shape == (0,)


def test_rejects_bad_temperature_input():
    with pytest.raises(ValueError):
        demand_profile(spec("ai_training"), np.array([20.0, np.inf]))
    with pytest.raises(ValueError):
        demand_profile(spec("ai_inference"), np.ones((2, 24)))
