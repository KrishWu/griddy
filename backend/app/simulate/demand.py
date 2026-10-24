"""Hourly demand profiles.  OWNER: workstream B (Simulate + Stress Test).

Pure numpy, no I/O. demand_profile() turns the user's DemandSpec plus the site's
hourly dry-bulb temperature into hourly demand at the meter (MW). Index i is the hour
beginning Jan 1 00:00 PST + i (fixed UTC-8); n = len(temp_c).

Profiles (ESTIMATES, labelled as such by the engine's provenance):
- flat:         exactly peak_mw x load_factor every hour (the simple preset baseline).
- ai_training:  IT load ~flat at high utilisation with short checkpoint/maintenance
                dips (2-6 h at -30..-50% every 2-5 days, fixed-seed RNG so runs are
                reproducible), x PUE(temperature).
- ai_inference: diurnal IT shape (trough 03-05 PST, high 10-20 PST) with a mild
                weekend dip, x PUE(temperature).
- community:    the given community shape (EIA-930 PG&E, mean ~1) or a synthetic
                diurnal + seasonal fallback; no PUE.

Every non-flat raw shape r is mapped onto the user's numbers by fit_shape(): an
affine transform so that mean(demand) = peak_mw x load_factor and max(demand) =
peak_mw (DemandSpec.peak_mw is the facility peak INCLUDING cooling).

A shape cannot go below the share of hours tied at its own maximum (those hours all
sit at peak), e.g. ~0.21 for ai_inference in a cool year. fit_demand() reports when the
requested load factor is below that floor (met=False, a note, and a ready-made Finding);
demand_profile() returns the closest achievable shape and emits a DemandFitWarning.
"""

from __future__ import annotations

import warnings
from dataclasses import dataclass

import numpy as np

from app.contract import DemandSpec, Finding

# PUE vs outdoor temperature: free cooling up to the knee, then chillers/evaporative
# cooling add load roughly linearly. +0.6% of base per deg C -> ~+13% at 40 C.
PUE_KNEE_C = 18.0
PUE_SLOPE_PER_C = 0.006

# ai_training: IT utilisation and dip schedule (checkpointing, node maintenance).
TRAINING_SEED = 20240101
TRAINING_UTILISATION = 0.97
TRAINING_JITTER = 0.01  # std dev of hour-to-hour utilisation noise
TRAINING_DIP_HOURS = (2, 6)  # inclusive range of dip lengths
TRAINING_DIP_DEPTH = (0.30, 0.50)  # fraction of IT load lost during a dip
TRAINING_DIP_GAP_HOURS = (48, 120)  # inclusive range of hours between dips

# ai_inference: relative IT utilisation by hour of day (PST). Requests follow US users:
# overnight trough 03-05, ramp through the morning, plateau 10-20, evening decline.
INFERENCE_BY_HOUR = (
    0.74, 0.68, 0.63, 0.60, 0.60, 0.62, 0.67, 0.75,  # 00-07
    0.84, 0.92, 0.97, 1.00, 1.00, 1.00, 1.00, 1.00,  # 08-15
    1.00, 1.00, 0.99, 0.97, 0.95, 0.90, 0.85, 0.79,  # 16-23
)
INFERENCE_WEEKEND_FACTOR = 0.92
FIRST_WEEKDAY = 0  # 2024-01-01 is a Monday (0 = Mon ... 5 = Sat, 6 = Sun)

# community fallback (no EIA-930 shape supplied): evening-peaking residential/commercial
# load by hour of day (PST) and a summer-peaking season with a small winter bump.
COMMUNITY_BY_HOUR = (
    0.84, 0.80, 0.78, 0.77, 0.77, 0.80, 0.86, 0.92,  # 00-07
    0.95, 0.96, 0.97, 0.98, 0.99, 1.00, 1.02, 1.05,  # 08-15
    1.09, 1.14, 1.18, 1.18, 1.14, 1.06, 0.97, 0.89,  # 16-23
)
COMMUNITY_SUMMER_PEAK_DAY = 213  # ~Aug 1
COMMUNITY_SEASONAL_AMPLITUDE = 0.10
COMMUNITY_WINTER_BUMP = 0.04

FLAT_LF = 0.999  # load factors at or above this give a constant profile
FIT_MEAN_REL_TOL = 1e-4  # fit_shape() bisects until the mean is within 0.01% of target
LF_MET_REL_TOL = 0.005  # fit_demand() counts the load factor as met within 0.5%


class DemandFitWarning(UserWarning):
    """The requested load factor is below what the profile's shape can reach."""


@dataclass(frozen=True)
class DemandFit:
    """Hourly demand plus how well it matched the user's DemandSpec."""

    demand_mw: np.ndarray
    profile: str
    target_load_factor: float
    achieved_load_factor: float  # mean(demand) / peak_mw
    met: bool  # achieved within LF_MET_REL_TOL of target
    note: str | None = None  # why the target was missed (None when met)

    def finding(self) -> Finding | None:
        """A 'warn' Finding the engine can attach when the target was missed."""
        if self.met:
            return None
        return Finding(
            id="demand_load_factor_unreachable",
            module="simulate",
            severity="warn",
            title=f"Load factor {self.target_load_factor:.2f} is too low for the {self.profile} profile",
            detail=self.note or "",
            metric=self.achieved_load_factor,
            threshold=self.target_load_factor,
        )


def _as_1d(x: np.ndarray, name: str) -> np.ndarray:
    a = np.asarray(x, dtype=float)
    if a.ndim != 1:
        raise ValueError(f"{name}: expected a 1-D hourly array, got shape {a.shape}")
    if not np.isfinite(a).all():
        raise ValueError(f"{name}: contains NaN or inf")
    return a


def pue_hourly(base_pue: float, temp_c: np.ndarray) -> np.ndarray:
    """Hourly PUE: base_pue at or below PUE_KNEE_C dry-bulb, rising linearly above it."""
    base = float(base_pue)
    if not np.isfinite(base) or base <= 0:
        raise ValueError(f"base_pue: must be a finite number > 0, got {base_pue!r}")
    t = _as_1d(temp_c, "temp_c")
    return base * (1.0 + PUE_SLOPE_PER_C * np.maximum(t - PUE_KNEE_C, 0.0))


def fit_shape(raw: np.ndarray, peak_mw: float, load_factor: float) -> np.ndarray:
    """Map a raw hourly shape onto mean = peak_mw x load_factor and max = peak_mw.

    d = peak x (LF + (1 - LF) x z), z = (r - mean r) / (max r - mean r), which equals
    peak x (1 + b x (z - 1)) with b = 1 - LF. Clipping a deep trough at 0 raises the
    mean; we then increase the slope b (the max stays at peak because z <= 1 and the
    mean falls monotonically in b) by bisection until the mean is back within
    FIT_MEAN_REL_TOL of target. The mean can never drop below peak x (share of hours
    tied at the raw max); if load_factor is at or below that floor, the limiting shape
    (peak in those hours, 0 elsewhere) is returned and the mean misses the target: use
    fit_demand() to detect that. LF >= FLAT_LF or a constant shape -> constant peak x LF.
    """
    r = _as_1d(raw, "raw")
    n = r.size
    peak = max(float(peak_mw), 0.0)
    lf = min(max(float(load_factor), 0.0), 1.0)
    target = peak * lf
    if n == 0 or target <= 0.0:
        return np.zeros(n)
    mean, top = float(r.mean()), float(r.max())
    spread = top - mean
    if lf >= FLAT_LF or spread <= 1e-9 * max(abs(top), 1.0):
        return np.full(n, target)

    z = (r - mean) / spread  # mean 0, max exactly 1

    def shaped(b: float) -> np.ndarray:
        return peak * np.clip(1.0 + b * (z - 1.0), 0.0, 1.0)

    lo = 1.0 - lf
    d = shaped(lo)
    if d.mean() - target <= FIT_MEAN_REL_TOL * target:
        return d
    at_max = z >= 1.0
    if lf <= float(at_max.mean()):  # unreachable: return the infimum shape (b -> inf)
        return np.where(at_max, peak, 0.0)
    hi = 2.0 * lo
    while shaped(hi).mean() > target and hi < 1e9:
        lo, hi = hi, 2.0 * hi
    for _ in range(200):
        mid = 0.5 * (lo + hi)
        d = shaped(mid)
        gap = d.mean() - target
        if abs(gap) <= FIT_MEAN_REL_TOL * target:
            return d
        lo, hi = (mid, hi) if gap > 0 else (lo, mid)
    return shaped(hi)


def _training_it(n: int) -> np.ndarray:
    """IT utilisation of a training cluster: high and steady with seeded dips."""
    rng = np.random.default_rng(TRAINING_SEED)
    it = TRAINING_UTILISATION + TRAINING_JITTER * rng.standard_normal(n)
    t = int(rng.integers(24, 97))  # first dip during the first few days
    while t < n:
        hours = int(rng.integers(TRAINING_DIP_HOURS[0], TRAINING_DIP_HOURS[1] + 1))
        depth = float(rng.uniform(*TRAINING_DIP_DEPTH))
        it[t : t + hours] *= 1.0 - depth
        t += hours + int(rng.integers(TRAINING_DIP_GAP_HOURS[0], TRAINING_DIP_GAP_HOURS[1] + 1))
    return np.clip(it, 0.0, 1.0)


def _inference_it(n: int) -> np.ndarray:
    """IT utilisation of an inference fleet: diurnal with a mild weekend dip."""
    h = np.arange(n)
    shape = np.asarray(INFERENCE_BY_HOUR)[h % 24]
    weekday = (h // 24 + FIRST_WEEKDAY) % 7
    return shape * np.where(weekday >= 5, INFERENCE_WEEKEND_FACTOR, 1.0)


def _community_fallback(n: int) -> np.ndarray:
    """Synthetic community load shape (mean ~1) when no EIA-930 shape is supplied."""
    h = np.arange(n)
    days = max(n / 24.0, 1.0)
    phase = 2.0 * np.pi * (h / 24.0 - COMMUNITY_SUMMER_PEAK_DAY) / days
    season = 1.0 + COMMUNITY_SEASONAL_AMPLITUDE * np.cos(phase) + COMMUNITY_WINTER_BUMP * np.cos(2.0 * phase)
    raw = np.asarray(COMMUNITY_BY_HOUR)[h % 24] * season
    return raw / raw.mean() if n else raw


def demand_profile(spec: DemandSpec, temp_c: np.ndarray, community_shape: np.ndarray | None = None) -> np.ndarray:
    """Hourly demand at the meter (MW), length len(temp_c), within [0, peak_mw].

    Emits a DemandFitWarning when spec.load_factor is below what the shape can reach;
    call fit_demand() instead to get that as data (and a Finding).
    """
    fit = fit_demand(spec, temp_c, community_shape)
    if not fit.met:
        warnings.warn(fit.note or "load factor not met", DemandFitWarning, stacklevel=2)
    return fit.demand_mw


def fit_demand(spec: DemandSpec, temp_c: np.ndarray, community_shape: np.ndarray | None = None) -> DemandFit:
    """demand_profile() plus a report of whether the requested load factor was reached."""
    demand = _shaped_demand(spec, temp_c, community_shape)
    peak, lf = max(float(spec.peak_mw), 0.0), min(max(float(spec.load_factor), 0.0), 1.0)
    if peak <= 0.0 or demand.size == 0:
        return DemandFit(demand, spec.profile, lf, lf, True)
    achieved = float(demand.mean()) / peak
    met = abs(achieved - lf) <= LF_MET_REL_TOL * max(lf, 1e-9)
    note = None
    if not met:
        note = (
            f"The {spec.profile} profile cannot reach load factor {lf:.2f} at a {peak:,.0f} MW peak: too many "
            f"hours sit at the shape's maximum, so the lowest achievable is {achieved:.2f} (average "
            f"{achieved * peak:,.0f} MW). This run uses that shape, with {achieved / max(lf, 1e-9):.1f}x the "
            f"requested annual energy. Raise the load factor or use the flat profile."
        )
    return DemandFit(demand, spec.profile, lf, achieved, met, note)


def _shaped_demand(spec: DemandSpec, temp_c: np.ndarray, community_shape: np.ndarray | None) -> np.ndarray:
    """Build the profile's raw shape and fit it to the spec's peak and load factor."""
    if np.ndim(temp_c) != 1:
        raise ValueError(f"temp_c: expected a 1-D hourly array, got shape {np.shape(temp_c)}")
    n = int(np.shape(temp_c)[0])
    peak, lf = max(float(spec.peak_mw), 0.0), float(spec.load_factor)

    if spec.profile == "flat":
        return np.full(n, peak * lf)
    if spec.profile == "ai_training":
        raw = _training_it(n) * pue_hourly(spec.pue, temp_c)
    elif spec.profile == "ai_inference":
        raw = _inference_it(n) * pue_hourly(spec.pue, temp_c)
    elif spec.profile == "community":
        if community_shape is None:
            raw = _community_fallback(n)
        else:
            raw = _as_1d(community_shape, "community_shape")
            if raw.size != n:
                raise ValueError(f"community_shape: expected {n} hourly values, got {raw.size}")
    else:
        raise ValueError(f"unknown demand profile {spec.profile!r}")
    return fit_shape(raw, peak, lf)
