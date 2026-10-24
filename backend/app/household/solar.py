"""Rooftop PV + home battery: hourly self-consumption, battery dispatch, Net Billing Tariff, costs.
OWNER: household (backend).

PV kWh_h = kW_DC x PVWatts v8 hourly AC per kW_DC (TMY, nearest city; Feb 29 reuses Feb 28).
Battery: charges only from PV surplus (stored = charge x RTE), discharges only to serve the home in the plan's
peak/part-peak hours; no grid charging, no battery export. Exports are credited at PG&E NBT export rates.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

from app.evaluate.finance import annuity_factor
from app.household.data import HOURS, PVProfile, pv_profiles


@dataclass
class Flows:
    grid_import: np.ndarray
    export: np.ndarray
    pv: np.ndarray
    direct: np.ndarray  # PV used directly by the home
    charge: np.ndarray  # PV into the battery
    discharge: np.ndarray  # battery to the home

    @property
    def self_consumed_kwh(self) -> float:
        """PV that did not go to the grid (direct use + into the battery)."""
        return float(self.direct.sum() + self.charge.sum())


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 6371.0 * 2 * math.asin(min(1.0, math.sqrt(a)))


def nearest_profile(lat: float, lon: float) -> PVProfile | None:
    profs = pv_profiles()
    if not profs:
        return None
    return min(profs.values(), key=lambda p: haversine_km(lat, lon, p.lat, p.lon))


def dispatch(load: np.ndarray, pv: np.ndarray, battery_kwh: float = 0.0, power_kw: float = 0.0, rte: float = 0.9,
             discharge_mask: np.ndarray | None = None) -> Flows:
    load = np.asarray(load, float)
    pv = np.asarray(pv, float)
    direct = np.minimum(load, pv)
    surplus = pv - direct
    deficit = load - direct
    charge = np.zeros(HOURS)
    discharge = np.zeros(HOURS)
    if battery_kwh > 0 and power_kw > 0 and surplus.sum() > 0:
        mask = np.ones(HOURS, bool) if discharge_mask is None else np.asarray(discharge_mask, bool)
        sur, dfc, msk = surplus.tolist(), deficit.tolist(), mask.tolist()
        ch, dis = [0.0] * HOURS, [0.0] * HOURS
        soc, cap, pw, eff = 0.0, float(battery_kwh), float(power_kw), float(rte)
        for h in range(HOURS):
            s = sur[h]
            if s > 0:
                c = min(s, pw, (cap - soc) / eff)
                if c > 0:
                    soc += c * eff
                    ch[h] = c
            elif msk[h]:
                d = dfc[h]
                if d > 0 and soc > 0:
                    x = min(d, pw, soc)
                    soc -= x
                    dis[h] = x
        charge = np.asarray(ch)
        discharge = np.asarray(dis)
    return Flows(grid_import=deficit - discharge, export=surplus - charge, pv=pv, direct=direct, charge=charge, discharge=discharge)


def npv(upfront_net: float, year1_savings: float, years: int, discount: float, escalation: float, degradation: float,
        extra_costs: dict[int, float] | None = None) -> float:
    """-upfront + sum_{t=1..N} S (1+e)^(t-1) (1-d)^(t-1) / (1+r)^t (- discounted extra costs)."""
    g = (1 + escalation) * (1 - degradation)
    r_eff = (1 + discount) / g - 1
    pv = year1_savings / g * annuity_factor(r_eff, years) if g > 0 else 0.0
    for t, c in (extra_costs or {}).items():
        if 0 < t <= years:
            pv -= c / (1 + discount) ** t
    return float(pv - upfront_net)


def savings_path(year1_savings: float, export_credit: float, bonus_credit: float, years: int,
                 escalation: float, degradation: float) -> np.ndarray:
    """Retail savings grow; export values stay flat, and the ACC Plus bonus ends after year 9.

    Export vintages for future years are unavailable. Holding them flat is a stated
    scenario, rather than escalating export credits with retail electricity prices.
    """
    t = np.arange(years)
    export = export_credit - bonus_credit + np.where(t < 9, bonus_credit, 0)
    return ((year1_savings - export_credit) * (1 + escalation) ** t + export) * (1 - degradation) ** t
