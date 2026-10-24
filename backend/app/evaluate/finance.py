"""Discounting, replacement/salvage schedules and NPC/LCOE.  OWNER: workstream C (Evaluate).

Pure functions (no pydantic, no I/O) so the math is unit-testable by hand.

Horizon method (explicit cash flows, real dollars, real discount rate r, horizon N years):
  year 0      all CAPEX
  years 1..N  constant annual OPEX (fixed O&M + variable O&M + fuel + purchased power + carbon - export credit)
  k*L < N     an asset with life L is re-bought at each k*L (cost x projected cost ratio for that year)
  year N      linear salvage of the last installation's remaining life, (t_last + L - N) / L, as a credit
  NPC  = sum_t CF_t / (1+r)^t
  LCOE = NPC / sum_{t=1..N} MWh_served / (1+r)^t
Cross-check: LCOE_crf = (sum_i CAPEX_i * CRF(r, L_i) + OPEX) / MWh_served.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from typing import Any


def _check(rate: float) -> None:
    if rate <= -1:
        raise ValueError(f"discount rate must be > -100%, got {rate}")


def discount_factor(rate: float, year: int) -> float:
    _check(rate)
    return (1 + rate) ** -year


def annuity_factor(rate: float, years: int) -> float:
    """Present value of $1/yr paid at the end of years 1..`years`."""
    _check(rate)
    if years <= 0:
        return 0.0
    if rate == 0:
        return float(years)
    return (1 - (1 + rate) ** -years) / rate


def crf(rate: float, years: int) -> float:
    """Capital recovery factor: the level annual payment per $1 of CAPEX over `years`."""
    if years <= 0:
        raise ValueError("lifetime must be positive")
    return 1.0 / annuity_factor(rate, years)


def replacement_years(lifetime: int, horizon: int) -> list[int]:
    """Years k*L (k >= 1) with k*L < horizon, when an asset is re-bought."""
    if lifetime <= 0:
        raise ValueError("lifetime must be positive")
    return list(range(lifetime, horizon, lifetime))


def last_install_year(lifetime: int, horizon: int) -> int:
    """Largest k*L < horizon with k >= 0 (0 when the first unit outlives the horizon)."""
    years = replacement_years(lifetime, horizon)
    return years[-1] if years else 0


def salvage_fraction(lifetime: int, horizon: int) -> float:
    """Remaining-life share of the last installation at the horizon, linear: (t_last + L - N) / L."""
    if horizon <= 0:
        return 1.0
    t_last = last_install_year(lifetime, horizon)
    return max(0.0, (t_last + lifetime - horizon) / lifetime)


@dataclass(frozen=True)
class CapitalItem:
    """One capital asset. replacement_cost_ratio: constant, or a function of the replacement year."""

    label: str
    category_kind: str  # AssetKind or "interconnection"
    capex_usd: float
    lifetime_years: int
    replacement_cost_ratio: float | Callable[[int], float] = 1.0

    def ratio(self, year: int) -> float:
        r = self.replacement_cost_ratio
        return 1.0 if year == 0 else float(r(year) if callable(r) else r)


@dataclass(frozen=True)
class OpexItem:
    label: str
    category: str  # fixed_om | var_om | fuel | purchased_power | export_revenue | carbon
    usd_per_yr: float


@dataclass
class NpcResult:
    npc_usd: float
    capex_usd: float
    annual_opex_usd: float
    discounted_mwh: float
    lcoe_usd_per_mwh: float
    lcoe_crf_usd_per_mwh: float
    breakdown: list[dict[str, Any]] = field(default_factory=list)  # [{label, category, usd}] PVs summing to npc_usd
    cash_flows: list[dict[str, Any]] = field(default_factory=list)  # one row per year t = 0..N


def net_present_cost(
    items: Sequence[CapitalItem], opex: Sequence[OpexItem], served_mwh_per_yr: float, rate: float, horizon: int
) -> NpcResult:
    """Explicit-cash-flow NPC, LCOE and the CRF cross-check (see module docstring)."""
    _check(rate)
    n = max(1, int(horizon))
    annual = sum(o.usd_per_yr for o in opex)
    capex0 = sum(i.capex_usd for i in items)
    df = [discount_factor(rate, t) for t in range(n + 1)]

    repl = [0.0] * (n + 1)
    breakdown: list[dict[str, Any]] = [{"label": i.label, "category": "capex", "usd": i.capex_usd} for i in items]
    salvage_rows: list[dict[str, Any]] = []
    salvage_total = 0.0
    for i in items:
        years = replacement_years(i.lifetime_years, n)
        if years and i.capex_usd:
            for t in years:
                repl[t] += i.capex_usd * i.ratio(t)
            pv = sum(i.capex_usd * i.ratio(t) * df[t] for t in years)
            when = ", ".join(str(t) for t in years)
            breakdown.append({"label": f"Replacement: {i.label} (year {when})", "category": "replacement", "usd": pv})
        frac = salvage_fraction(i.lifetime_years, n)
        if frac > 0 and i.capex_usd:
            value = i.capex_usd * i.ratio(last_install_year(i.lifetime_years, n)) * frac
            salvage_total += value
            salvage_rows.append(
                {"label": f"Salvage: {i.label} ({frac:.0%} of life left in year {n})", "category": "salvage", "usd": -value * df[n]}
            )
    breakdown += salvage_rows
    af = annuity_factor(rate, n)
    breakdown += [{"label": o.label, "category": o.category, "usd": o.usd_per_yr * af} for o in opex]

    cash_flows = []
    for t in range(n + 1):
        row = {
            "year": t,
            "capex_usd": capex0 if t == 0 else 0.0,
            "opex_usd": annual if t >= 1 else 0.0,
            "replacement_usd": repl[t],
            "salvage_usd": -salvage_total if t == n else 0.0,
        }
        row["net_usd"] = row["capex_usd"] + row["opex_usd"] + row["replacement_usd"] + row["salvage_usd"]
        row["discount_factor"] = df[t]
        row["pv_usd"] = row["net_usd"] * df[t]
        cash_flows.append(row)

    npc = sum(r["pv_usd"] for r in cash_flows)
    mwh = max(0.0, served_mwh_per_yr)
    discounted = mwh * af
    annualized = sum(i.capex_usd * crf(rate, i.lifetime_years) for i in items) + annual
    return NpcResult(
        npc_usd=npc,
        capex_usd=capex0,
        annual_opex_usd=annual,
        discounted_mwh=discounted,
        lcoe_usd_per_mwh=npc / discounted if discounted > 0 else 0.0,
        lcoe_crf_usd_per_mwh=annualized / mwh if mwh > 0 else 0.0,
        breakdown=breakdown,
        cash_flows=cash_flows,
    )
