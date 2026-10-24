"""Hourly (24/7) carbon-free energy score.  OWNER: workstream C (Evaluate).

Per hour h, with demand D:
  R_used      = max(solar + wind - curtailed - exports, 0)      on-site renewables kept on site
  R_to_load   = min(R_used, D);  R_to_charge = min(charge, R_used - R_to_load)
  the rest of the charge comes from imports and gas pro rata to their output that hour;
  imports are clean at the grid's clean share g_h
  battery discharge is clean at the pool's clean fraction f (energy-pool mixing; f0 = clean share
  of the year's charging energy; charge losses split evenly, as in B's dispatch)
  CL = R_to_load + discharge * f + (imports - imports_to_charge) * g_h
An hour is matched when CL >= D (1e-6 tolerance). Score = matched hours / hours with demand > 0.
g_h comes from sim.extras["grid_cfe_share"] (per hour or scalar); otherwise it is inferred as
1 - grid CO2_h / CAISO gas-fleet CO2 rate (eGRID CAMX gas output rate), clipped to [0, 1].
"""

from __future__ import annotations

from functools import lru_cache
from typing import Any

import numpy as np

from app.evaluate.catalog import LB_TO_KG, ref_value


@lru_cache(maxsize=8)
def month_index(year: int, n: int) -> np.ndarray:
    """Calendar month (0-11) of hour i, counted from Jan 1 00:00 of `year` (fixed UTC-8, no DST)."""
    t = np.datetime64(f"{year:04d}-01-01T00", "h") + np.arange(n).astype("timedelta64[h]")
    m = t.astype("datetime64[M]").astype(np.int64) % 12
    m.setflags(write=False)
    return m


def grid_clean_share(sim_extras: dict[str, Any], grid_co2: np.ndarray) -> tuple[np.ndarray, str]:
    """Hourly clean share of imports, from simulate if it sent a valid one, else inferred from grid CO2."""
    n = grid_co2.size
    v = sim_extras.get("grid_cfe_share") if isinstance(sim_extras, dict) else None
    g = None
    try:
        if v is not None and not isinstance(v, (bool, str)):
            a = np.asarray(v, dtype=float)
            if a.ndim == 0:
                g = np.full(n, float(a))
            elif a.ndim == 1 and a.size == n:
                g = a
    except (TypeError, ValueError):
        g = None
    if g is not None and np.all(np.isfinite(g)):
        return np.clip(g, 0.0, 1.0), "simulate"
    gas_fleet_kg = ref_value("egrid_camx_gas_co2_lb_per_mwh") * LB_TO_KG
    return np.clip(1.0 - grid_co2 / gas_fleet_kg, 0.0, 1.0), "inferred_from_grid_co2"


def _pool_fraction(charge: np.ndarray, discharge: np.ndarray, soc: np.ndarray, clean_in: np.ndarray, eta: float) -> np.ndarray:
    """Clean fraction of the battery's stored energy at the start of each hour (well-mixed pool)."""
    n = charge.size
    total = float(charge.sum())
    f = clean_in.sum() / total if total > 0 else 0.0
    if not discharge.any():
        return np.full(n, f)
    added, clean, s = (charge * eta).tolist(), (clean_in * eta).tolist(), soc.tolist()
    out = [0.0] * n
    for t in range(n):
        out[t] = f
        a = added[t]
        if a > 0:
            kept = max(s[t] - a, 0.0)
            f = (f * kept + clean[t]) / (kept + a)
    return np.asarray(out)


def cfe_metrics(
    demand: np.ndarray,
    renewables: np.ndarray,
    curtailed: np.ndarray,
    exports: np.ndarray,
    charge: np.ndarray,
    discharge: np.ndarray,
    soc: np.ndarray,
    imports: np.ndarray,
    gas: np.ndarray,
    g: np.ndarray,
    rte: float,
    year: int,
) -> dict[str, Any]:
    """24/7 CFE extras: score, energy share, annual-netting share, by month and by hour of day."""
    n = demand.size
    r_used = np.maximum(renewables - curtailed - exports, 0.0)
    r_load = np.minimum(r_used, demand)
    r_charge = np.clip(np.minimum(charge, r_used - r_load), 0.0, None)
    rest = np.maximum(charge - r_charge, 0.0)
    other = imports + gas
    imp_share = np.divide(imports, other, out=np.zeros(n), where=other > 0)
    imp_charge = np.minimum(rest * imp_share, imports)
    clean_in = r_charge + imp_charge * g
    f = _pool_fraction(charge, discharge, soc, clean_in, max(rte, 1e-6) ** 0.5)
    clean = r_load + discharge * f + np.maximum(imports - imp_charge, 0.0) * g

    has_d = demand > 0
    matched = has_d & (clean >= demand * (1 - 1e-6) - 1e-6)
    d_sum = float(demand.sum())

    def share(idx: np.ndarray, bins: int) -> list[float]:
        hit = np.bincount(idx, weights=matched, minlength=bins)[:bins]
        tot = np.bincount(idx, weights=has_d, minlength=bins)[:bins]
        return [float(x) for x in np.divide(hit, tot, out=np.zeros(bins), where=tot > 0)]

    hours = int(has_d.sum())
    netting = (float((renewables - curtailed).sum()) + float(imports @ g)) / d_sum if d_sum > 0 else 0.0
    return {
        "cfe_score_24_7": float(matched.sum() / hours) if hours else 0.0,
        "cfe_hourly_energy_share": float(np.minimum(clean, demand).clip(0).sum() / d_sum) if d_sum > 0 else 0.0,
        "cfe_annual_netting_share": float(min(1.0, max(0.0, netting))),
        "cfe_by_month": share(month_index(year, n), 12),
        "cfe_by_hour_of_day": share(np.arange(n) % 24, 24),
    }
