"""Least-cost mix search on Griddy's own hourly dispatch.  OWNER: workstream D.

POST /api/projects/optimize. planner.py sizes one plant with fixed rules; this tests ~190 solar, wind,
battery and gas mixes and returns the cheapest that meets the entered reliability and clean targets,
with the cost-versus-CO2 tradeoff so judges see why the others lost.

1. Project demand like plan_project() and prepare() the projected scenario once (weather, prices, load).
2. Screen a grid of multiples of the sizing peak P: solar 0-3 P, wind 0-1 P, battery 0-1 P x 4/8 h
   (plus a remote-capacity level per kind with site-model placement, below).
   Gas CC is sized per mix: the 15% firm-margin floor (stress.py's own credits), then the worst unmet
   hour, re-dispatched until unmet < 1 kW (at most 3 passes; grid charging off, so 1-2 dispatches).
   If nothing on that grid meets the clean or CO2 target, a wider grid (to 4 P solar, 1.5 P x 12 h
   battery) is screened before giving up.
3. Finalists: the 12 cheapest by estimate plus the estimated cost-vs-CO2 frontier, <= max_finalists.
   Each is judged exactly: simulate(), stress_test(), one gas bump if the firm margin is short,
   evaluate(). The recommendation is the lowest exact NPC among finalists passing every check.
4. Refine: half-steps of solar and battery around the winner (9 mixes), judged the same way.

Screening estimate, annual $:  sum_k [CRF_k x CAPEX_k + FOM_k] + sum_t [g_t c_gas + m_t c_imp_t - x_t p_t]
  CRF_k = r / (1 - (1 + r)^-L_k), r = assumptions.discount_rate, L_k = catalog lifetime_years.
  CAPEX = capex_usd_per_kw x kW (+ capex_usd_per_kwh x kWh for batteries); FOM = fixed O&M, with the
  battery's ATB power/energy split exactly as evaluate() applies it. Gas, import and export prices are
  prep.drivers'; exports earn options.export_credit_fraction (default 0) of p_t, as in evaluate().
  The interconnection is the same for every mix, so it is left out of the ranking (it is added back
  for est_lcoe_usd_per_mwh and the budget screen).
  CO2 = gas MWh x heat rate x co2_kg_per_mmbtu / 1000 + sum_t imports_t x grid_co2_kg_per_mwh_t / 1000.
24/7 CFE target (clean_metric="cfe_24_7"): cfe_metrics() costs ~3 ms per mix (measured on the Kern
preset; a dispatch is ~7 ms), so the screen scores every mix on its own dispatch, and finalists are
judged on evaluate()'s exact extras["cfe_score_24_7"].

Placement (placement="site_model", the default; app/builder/placement.py picks the locations):
  1. Placement.options[kind] lists where solar / wind MW can go, cheapest per MWh first, each SiteOption
     with its own hourly per-MW profile (cf): B's site-model cells near the campus, then the campus
     (unbounded). allocate() fills them in order; the screen blends the profiles by MW, exactly as
     engine._renewable_cf() does for located assets. When a kind's cells have a much better resource
     than the campus (mean CF >= 1.25x; Kern wind: ~20% at Tehachapi vs 1.4%), their total MW is added
     as one more grid level (remote_levels()), so the search can stop there instead of spilling MW
     onto the campus at the next 0.5 P step.
  2. assets_for() turns a mix into Assets: one per (kind, location), with the option's overrides and its
     one-time fixed_usd (the gen-tie) folded into overrides["capex_usd_per_kw"], so evaluate() and the
     screen cost the same assets. placement.site_options(req, scenario, prep, catalog, campus) returns
     the Placement; a missing module or any failure falls back to the campus with a note.
  3. The winning mix is judged once more with every MW at the campus (campus_only in the response). If
     that is cheaper and passes, it is recommended instead, so placement never costs more for the mix.
     Remote assets add a needs_utility_study finding (placement.delivery_finding), and the winner's
     exact run is checked to have used the same weather profiles as the screen (_weather_matches).

Least-cost among the designs tested on Griddy's simulator, not a proven optimum or a certified design.
Write a committed demo response with:  python -m app.builder.optimizer --write-cache kern_80
"""
from __future__ import annotations

import argparse
import copy
import dataclasses
import hashlib
import json
import logging
import math
import threading
import time
from collections import Counter, OrderedDict
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated, Any, Literal

import numpy as np
from pydantic import Field

from app.builder.planner import PlanRequest, plan_project
from app.contract import (
    Asset, Catalog, EvaluationResult, Finding, LngLat, Model, Provenance, Scenario, SimulationResult,
    SimulationSummary, SiteRequest,
)
from app.evaluate.catalog import battery_fom_split, get_catalog, ref_value, transmission_for_voltage, transmission_tier
from app.evaluate.cfe import cfe_metrics
from app.evaluate.economics import evaluate
from app.evaluate.project import ProjectOptions
from app.simulate.dispatch import Dispatch, dispatch
from app.simulate.engine import Prepared, prepare, simulate, summarize
from app.simulate.stress import (
    BATTERY_CREDIT_MAX, CAPACITY_VALUE_HOURS, EFOR, MIN_DEFICIT_HOURS, RESERVE_MARGIN_TARGET, UNIT_SIZE_MW, stress_test,
)

log = logging.getLogger(__name__)

OPTIMIZER_VERSION = "2"  # bump when the search changes: it is part of every cache key (2: site-model placement)
CACHE_DIR = Path(__file__).resolve().parent / "optimize_cache"
MEMO_SIZE = 16
RENEWABLE = ("solar_pv", "onshore_wind")
SOLAR_X = (0.0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0)  # multiples of the sizing peak P
WIND_X = (0.0, 0.5, 1.0)
BATTERY_X = (0.0, 0.25, 0.5, 0.75, 1.0)
# Wider grid, screened only when nothing above meets the clean or CO2 target.
SOLAR_X_WIDE = (3.0, 3.5, 4.0)
BATTERY_X_WIDE = (0.75, 1.0, 1.25, 1.5)
DURATION_H_WIDE = 12.0
SOLAR_HALF_STEP, BATTERY_HALF_STEP = 0.25, 0.125  # refinement around the winner
REMOTE_LEVEL_CF_RATIO = 1.25  # a kind's remote-capacity level is searched when its cells beat the campus CF by 25%+
REMOTE_LEVEL_GAP = 0.05  # ... and it isn't within 0.05 P of a grid level already
CHEAPEST_FINALISTS = 12
JUDGE_ROUNDS = 2  # if no finalist passes, judge the next-cheapest screened designs once more
GAS_PASSES = 3
UNMET_TOL_MW = 1e-3  # "unmet under 1 kW"
MARGIN_PAD = 0.001  # floor sized 0.1% of peak above the target: the finding rounds the margin to 0.1%
BUMP_PAD_PCT = 0.05  # same reason, for the exact run's one gas bump
NEAR_COST = 0.10  # alternatives within +10% of the recommended NPC
PEAK_LIMIT_MW, PROJECTED_LIMIT_MW = 20000, 50000  # the planner's input limits and messages
PEAK_MESSAGE = "Peak demand must be greater than zero and at most 20,000 MW."
PROJECTED_MESSAGE = "Projected peak exceeds the 50,000 MW planning limit."
# Set by the grid tie, not the mix: reported, but they don't rule out one mix against another.
SITE_LEVEL_FINDINGS = frozenset({"poi_voltage"})

REASONS = {
    "unmet_demand": "Leaves demand unserved for more hours than allowed",
    "clean_share_below_target": "On-site clean share below the target",
    "cfe_below_target": "24/7 carbon-free score below the target",
    "co2_above_cap": "Emissions above the CO2 cap",
    "over_budget": "Capital cost above the budget",
    "over_footprint": "Needs more land than the selected footprint",
    "stress_fail": "A stress-test check fails",
    "firm_margin_short": "Firm capacity margin below 15%",
    "n_minus_1_fail": "Doesn't survive losing the largest gas unit",
}
BASIS = "Least-cost among {n} tested designs on Griddy's hourly dispatch. Not a certified design."

Duration = Annotated[float, Field(ge=0.5, le=48)]


class OptimizeRequest(Model):
    scenario: Scenario  # site, demand, grid and assumptions; its assets are ignored
    project: ProjectOptions = Field(default_factory=ProjectOptions)
    min_clean_share: float = Field(default=0.0, ge=0, le=1)
    clean_metric: Literal["onsite_share", "cfe_24_7"] = "onsite_share"
    max_unmet_hours: int = Field(default=0, ge=0, le=8784)
    max_co2_t_per_yr: float | None = Field(default=None, ge=0)
    require_reserve_margin: bool = True
    require_n_minus_1: bool = False
    include_wind: bool = True
    battery_durations_h: list[Duration] = Field(default_factory=lambda: [4.0, 8.0], min_length=1, max_length=6)
    max_finalists: int = Field(default=20, ge=1, le=40)
    refine: bool = True
    placement: Literal["site_model", "campus_only"] = "site_model"
    site_request: SiteRequest | None = None
    min_suitability: float = Field(default=0.5, ge=0, le=1)


# ---------------------------------------------------------------------------
# Designs and where their MW go
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Mix:
    """One design. x_* are multiples of the sizing peak P; gas CC is sized by the screen."""

    solar_x: float
    wind_x: float
    battery_x: float
    duration_h: float
    solar_mw: float
    wind_mw: float
    battery_mw: float
    gas_cc_mw: float = 0.0
    stage: str = "grid"  # grid | wide | refine

    @classmethod
    def of(cls, peak: float, solar_mw: float, wind_mw: float, battery_mw: float, duration_h: float | None,
           gas_cc_mw: float = 0.0, stage: str = "grid") -> Mix:
        h = float(duration_h or 0.0) if battery_mw > 0 else 0.0
        return cls(solar_mw / peak, wind_mw / peak, battery_mw / peak, h, solar_mw, wind_mw, battery_mw, gas_cc_mw, stage)

    @property
    def battery_mwh(self) -> float:
        return self.battery_mw * self.duration_h

    @property
    def key(self) -> tuple[float, ...]:
        return tuple(round(v, 4) for v in (self.solar_x, self.wind_x, self.battery_x, self.duration_h))

    @property
    def id(self) -> str:
        battery = f"b{self.battery_x:g}x{self.duration_h:g}h" if self.battery_mw else "b0"
        return f"s{self.solar_x:g}-w{self.wind_x:g}-{battery}"

    def assets_mw(self) -> dict[str, float]:
        return {"solar_pv": self.solar_mw, "onshore_wind": self.wind_mw, "gas_cc": self.gas_cc_mw, "battery": self.battery_mw}


@dataclass
class SiteOption:
    """One place a kind's MW can go. The campus (location None) is always one, unbounded."""

    id: str
    kind: str
    cf: np.ndarray  # hourly per-MW output at this location
    max_mw: float = math.inf
    location: LngLat | None = None
    overrides: dict[str, float] = field(default_factory=dict)  # per-kW TechSpec overrides for its assets
    fixed_usd: float = 0.0  # one-time cost if anything is built here (gen-tie), folded into capex_usd_per_kw
    label: str = "campus"
    info: dict[str, Any] = field(default_factory=dict)  # suitability, gen_tie_usd, ... for the response


@dataclass
class Placement:
    mode: str  # what was actually used: "campus_only" | "site_model"
    options: dict[str, list[SiteOption]]  # kind -> fill order; ends with an unbounded option
    notes: list[str] = field(default_factory=list)
    provenance: list[Provenance] = field(default_factory=list)
    info: dict[str, Any] = field(default_factory=dict)  # region, site request, options considered: for the response


def allocate(options: list[SiteOption], mw: float) -> list[tuple[SiteOption, float]]:
    """Fill options in order, each up to its max_mw; the remainder goes to the last (unbounded) one."""
    out, left = [], float(mw)
    for i, o in enumerate(options):
        if left <= 1e-9:
            break
        take = left if i == len(options) - 1 else min(left, o.max_mw)
        if take > 1e-9:
            out.append((o, take))
            left -= take
    return out


def _campus(prep: Prepared) -> dict[str, list[SiteOption]]:
    # prepare() ran on a scenario without assets, so these are the site's own weather profiles.
    return {"solar_pv": [SiteOption("campus", "solar_pv", prep.drivers.solar_cf)],
            "onshore_wind": [SiteOption("campus", "onshore_wind", prep.drivers.wind_cf)]}


def campus_placement(ctx: Context) -> Placement:
    """Every MW at the campus: for the campus-only comparison of a site-model winner (judge(..., place=))."""
    return Placement("campus_only", _campus(ctx.prep))


def _placement(req: OptimizeRequest, scenario: Scenario, prep: Prepared, catalog: Catalog) -> Placement:
    campus = _campus(prep)
    if req.placement == "campus_only":
        return Placement("campus_only", campus)
    try:
        from app.builder.placement import site_options
    except ModuleNotFoundError as exc:
        if exc.name != "app.builder.placement":
            raise
        return Placement("campus_only", campus, ["Site-model placement isn't available yet, so every MW is placed at the campus."])
    try:
        place = site_options(req, scenario, prep, catalog, campus)
    except Exception as exc:  # noqa: BLE001 - remote placement (live weather, site model) must never break a run
        log.exception("site-model placement failed")
        return Placement("campus_only", campus, [f"Site-model placement failed ({type(exc).__name__}), so every MW is placed at the campus."])
    for kind in RENEWABLE:  # every kind must end with an unbounded option, or allocate() would overfill
        opts = place.options.get(kind) or []
        if not opts or math.isfinite(opts[-1].max_mw):
            place.options[kind] = [*opts, *campus[kind]]
    return place


# ---------------------------------------------------------------------------
# Request context: everything every candidate reuses
# ---------------------------------------------------------------------------


@dataclass
class Context:
    req: OptimizeRequest
    base: Scenario  # current demand, no assets, options.project = req.project (what the store gets)
    projected: Scenario  # projected peak: what every design is judged on
    factor: float
    catalog: Catalog
    prep: Prepared
    peak_mw: float  # P = max(projected peak, simulated peak), as plan_project() and stress.py use
    place: Placement
    interconnection_usd: float
    footprint_acres: float | None
    export_credit: float
    notes: list[str] = field(default_factory=list)
    blends: dict = field(default_factory=dict)
    placement_ms: float = 0.0
    credits: dict = field(default_factory=dict)


def _crf(r: float, years: float) -> float:
    return 1 / years if abs(r) < 1e-12 else r / (1 - (1 + r) ** -years)


def _interconnection_usd(sc: Scenario, catalog: Catalog) -> float:
    """Line + substation CAPEX for the POI's voltage tier, as evaluate() books it (same for every mix)."""
    g = sc.grid
    if not g.connected:
        return 0.0
    tier = transmission_tier(g.poi_voltage_kv)
    tx = catalog.transmission if tier["kv"] == 230 else transmission_for_voltage(g.poi_voltage_kv)
    return (g.interconnection_km * tx.line_usd_per_km if g.interconnection_km > 0 else 0.0) + (tx.substation_usd if g.new_substation else 0.0)


def _footprint_acres(sc: Scenario) -> float | None:
    if not sc.site.footprint:
        return None
    try:
        from app.explore.area import area_geometry

        return area_geometry(sc.site.footprint)[1] * 247.105381
    except ValueError:
        return None  # evaluate() reports the bad area; the screen just doesn't check land


def context(req: OptimizeRequest, catalog: Catalog | None = None) -> Context:
    base = req.scenario.model_copy(deep=True)
    if not 0 < base.demand.peak_mw <= PEAK_LIMIT_MW:
        raise ValueError(PEAK_MESSAGE)
    factor = (1 + req.project.annual_demand_growth) ** req.project.projection_years
    if base.demand.peak_mw * factor > PROJECTED_LIMIT_MW:
        raise ValueError(PROJECTED_MESSAGE)
    base.preset = None
    base.name = "Optimized design"
    base.assets = []
    base.options = {k: v for k, v in base.options.items() if k not in ("sizing", "optimizer")}
    base.options["project"] = req.project.model_dump()
    notes = []
    if req.clean_metric == "cfe_24_7" and "grid_charging" not in base.options:
        # Charging from imports dilutes the stored energy's clean share: on the Kern preset it cost 3 points
        # of 24/7 CFE for $3M of NPC. So these designs charge from on-site surplus only (and screen = exact).
        base.options["grid_charging"] = False
        notes.append("For the 24/7 CFE target the battery charges only from on-site surplus (scenario option grid_charging = false).")
    projected = base.model_copy(deep=True)
    projected.demand.peak_mw *= factor
    catalog = catalog or get_catalog()
    prep = prepare(projected, catalog)
    peak = max(projected.demand.peak_mw, float(prep.drivers.demand_mw.max()))
    try:
        credit = float(base.options.get("export_credit_fraction", 0.0))
    except (TypeError, ValueError):
        credit = 0.0
    started = time.perf_counter()
    place = _placement(req, projected, prep, catalog)
    ctx = Context(req, base, projected, factor, catalog, prep, peak, place, _interconnection_usd(projected, catalog),
                  _footprint_acres(projected), credit if math.isfinite(credit) else 0.0, notes)
    ctx.placement_ms = round(1000 * (time.perf_counter() - started), 1)
    return ctx


def remote_levels(ctx: Context) -> dict[str, float]:
    """Kind -> its site-model cells' total MW as a multiple of P (floored to 0.001), when stopping there is a
    real choice: their mean capacity factor is >= REMOTE_LEVEL_CF_RATIO x the campus's, which takes any MW
    beyond them (Kern: Tehachapi wind at ~20% vs 1.4% at the campus). Added to that kind's grid levels."""
    out = {}
    for kind in RENEWABLE:
        opts = ctx.place.options.get(kind, [])
        remote = [o for o in opts if o.location is not None and math.isfinite(o.max_mw) and o.max_mw > 0]
        mw = sum(o.max_mw for o in remote)
        if not remote or (kind == "onshore_wind" and not ctx.req.include_wind):
            continue
        remote_cf = sum(o.max_mw * float(np.clip(o.cf, 0, 1).mean()) for o in remote) / mw
        if remote_cf >= REMOTE_LEVEL_CF_RATIO * float(np.clip(opts[-1].cf, 0, 1).mean()):
            x = math.floor(1000 * mw / ctx.peak_mw) / 1000
            if x > 0:
                out[kind] = x
    return out


def _with_level(levels: tuple[float, ...], x: float | None) -> tuple[float, ...]:
    if x is None or x >= max(levels) or min(abs(x - v) for v in levels) < REMOTE_LEVEL_GAP:
        return levels
    return tuple(sorted({*levels, x}))


def _grid(ctx: Context) -> list[Mix]:
    """The plan's search grid: 7 solar x 3 wind x (no battery + 4 battery sizes x durations) = 189,
    plus a remote-capacity level per kind from remote_levels() when site-model placement has one."""
    req, p, extra = ctx.req, ctx.peak_mw, remote_levels(ctx)
    wind = _with_level(WIND_X, extra.get("onshore_wind")) if req.include_wind else (0.0,)
    durations = sorted(set(req.battery_durations_h))
    return _cross(p, _with_level(SOLAR_X, extra.get("solar_pv")), wind, BATTERY_X, durations, "grid")


def _wide(ctx: Context) -> list[Mix]:
    req, p = ctx.req, ctx.peak_mw
    wind = _with_level(WIND_X, remote_levels(ctx).get("onshore_wind")) if req.include_wind else (0.0,)
    durations = sorted({*req.battery_durations_h, DURATION_H_WIDE})
    return _cross(p, SOLAR_X_WIDE, wind, BATTERY_X_WIDE, durations, "wide")


def _cross(p: float, solar, wind, battery, durations, stage: str) -> list[Mix]:
    out = []
    for s in solar:
        for w in wind:
            for b in battery:
                for h in (durations if b > 0 else (0.0,)):
                    out.append(Mix.of(p, s * p, w * p, b * p, h, stage=stage))
    return out


# ---------------------------------------------------------------------------
# Screening
# ---------------------------------------------------------------------------


@dataclass
class Judged:
    mix: Mix  # after any firm-margin gas bump
    scenario: Scenario  # as judged (projected demand)
    sim: SimulationResult  # hourly arrays dropped once scored (see _slim): summary and provenance only
    evaluation: EvaluationResult
    findings: list[Finding]
    failed: list[str]
    bumped_mw: float = 0.0
    place: Placement | None = None  # where its solar / wind went (None: the request's placement)
    weather_ok: bool | None = None  # _weather_matches(), taken while the hourly arrays still exist

    @property
    def passes(self) -> bool:
        return not self.failed


@dataclass
class Screened:
    mix: Mix
    summary: SimulationSummary
    est_cost_usd_per_yr: float
    est_capex_usd: float  # incl. the interconnection, comparable with evaluate()'s capex_total_usd
    est_lcoe_usd_per_mwh: float
    est_t_co2e: float
    land_acres: float
    cfe_score_24_7: float | None
    campus_land_acres: float | None = None  # what the footprint check counts: remote cells use their own land
    reason: str | None = None
    status: str = "screened"
    judged: Judged | None = None


def _blend(ctx: Context, kind: str, mw: float) -> np.ndarray:
    """Capacity-weighted per-MW profile of a kind's MW across its locations (engine._renewable_cf)."""
    key = (kind, round(mw, 6))
    if key not in ctx.blends:
        parts = allocate(ctx.place.options[kind], mw)
        if len(parts) <= 1:
            cf = (parts[0][0] if parts else ctx.place.options[kind][-1]).cf
        else:
            cf = sum(part * o.cf for o, part in parts) / sum(part for _, part in parts)
        ctx.blends[key] = cf
    return ctx.blends[key]


def _daily_deficit_hours(net_load: np.ndarray) -> float:
    days = len(net_load) // 24
    per_day = (net_load[: days * 24].reshape(days, 24) > 1e-6).sum(axis=1)
    return float(np.median(per_day)) if days else 24.0


def _credits(ctx: Context, mix: Mix, solar_cf: np.ndarray, wind_cf: np.ndarray) -> tuple[float, float, float]:
    """(solar credit, wind credit, daily deficit hours) exactly as stress._firm_capacity() counts them."""
    key = (round(mix.solar_mw, 6), round(mix.wind_mw, 6))
    if key not in ctx.credits:
        net = ctx.prep.drivers.demand_mw - mix.solar_mw * np.clip(solar_cf, 0, 1) - mix.wind_mw * np.clip(wind_cf, 0, 1)
        top = np.argsort(net)[-CAPACITY_VALUE_HOURS:]
        ctx.credits[key] = (float(np.clip(solar_cf[top], 0, 1).mean()), float(np.clip(wind_cf[top], 0, 1).mean()),
                            max(MIN_DEFICIT_HOURS, _daily_deficit_hours(net)))
    return ctx.credits[key]


def _firm_floor(ctx: Context, mix: Mix, credits: tuple[float, float, float]) -> float:
    """Gas CC MW for the 15% firm margin stress_test() checks (0 when the margin isn't required)."""
    if not ctx.req.require_reserve_margin:
        return 0.0
    solar_credit, wind_credit, deficit_h = credits
    battery = mix.battery_mw * min(BATTERY_CREDIT_MAX, mix.duration_h / deficit_h) if mix.battery_mw else 0.0
    firm = battery + mix.solar_mw * solar_credit + mix.wind_mw * wind_credit + ctx.prep.fleet.import_limit_mw
    return max(0.0, (1 + RESERVE_MARGIN_TARGET + MARGIN_PAD) * ctx.peak_mw - firm) / (1 - EFOR["gas_cc"])


def _n1_ok(cap: float, need: float, unit: float) -> bool:
    k = max(1, math.ceil(cap / unit - 1e-9))  # stress._units(): equal units of at most `unit` MW
    return cap - cap / k >= need - 1e-6


def _n1_capacity(need: float) -> float:
    """Smallest gas CC capacity that still covers `need` MW without its largest unit (stress.py's units)."""
    if need <= 0:
        return 0.0
    unit = UNIT_SIZE_MW["gas_cc"]
    options = [need * k / (k - 1) for k in range(2, math.ceil(need / unit) + 3)] + [need + unit]
    return min(c for c in options if _n1_ok(c, need, unit))


def _shortfall(unmet: np.ndarray, allowed_hours: int) -> float:
    """MW of gas that leaves at most `allowed_hours` unmet: the (allowed + 1)-th largest unmet hour."""
    if allowed_hours >= unmet.size:
        return 0.0
    return float(np.partition(unmet, unmet.size - allowed_hours - 1)[unmet.size - allowed_hours - 1])


def assets_for(ctx: Context, mix: Mix, place: Placement | None = None) -> list[Asset]:
    """A mix as Assets: one per (kind, location); gas and battery stay at the campus."""
    place = place or ctx.place
    assets: list[Asset] = []
    for kind, mw, label in (("solar_pv", mix.solar_mw, "Solar PV"), ("onshore_wind", mix.wind_mw, "Onshore wind")):
        for o, part in allocate(place.options[kind], mw):
            overrides = {k: float(v) for k, v in o.overrides.items()}
            if o.fixed_usd:
                base = overrides.get("capex_usd_per_kw", ctx.catalog.spec(kind).capex_usd_per_kw)
                overrides["capex_usd_per_kw"] = base + o.fixed_usd / (part * 1000)
            suffix = "" if o.id == "campus" else f"-{o.id}"
            assets.append(Asset(id=f"opt-{kind}{suffix}", kind=kind, name=f"{label} ({o.label})", capacity_mw=part,
                                location=o.location, overrides=overrides))
    if mix.battery_mw > 0:
        assets.append(Asset(id="opt-battery", kind="battery", name="Battery (campus)", capacity_mw=mix.battery_mw, duration_h=mix.duration_h))
    if mix.gas_cc_mw > 0:
        assets.append(Asset(id="opt-gas_cc", kind="gas_cc", name="Gas combined cycle (campus)", capacity_mw=mix.gas_cc_mw))
    return assets


def _capital(ctx: Context, assets: list[Asset]) -> tuple[float, float, float, float]:
    """(CAPEX $, annualized CAPEX + fixed O&M $/yr, land acres, land acres at the campus) for the assets,
    as evaluate() costs them. Assets with a location sit on their own site-model cell."""
    r = ctx.projected.assumptions.discount_rate
    fk, fe = battery_fom_split()
    capex = annual = land = campus = 0.0
    for a in assets:
        spec, o = ctx.catalog.spec(a.kind), a.overrides
        kw = a.capacity_mw * 1000
        life = max(1, int(round(o.get("lifetime_years", spec.lifetime_years))))
        fom_rate = o.get("fixed_om_usd_per_kw_yr", spec.fixed_om_usd_per_kw_yr)
        acres = a.capacity_mw * o.get("land_acres_per_mw", spec.land_acres_per_mw)
        usd = kw * o.get("capex_usd_per_kw", spec.capex_usd_per_kw)
        fom = kw * fom_rate
        if a.kind == "battery":
            h = 4.0 if a.duration_h is None else a.duration_h
            usd += kw * h * o.get("capex_usd_per_kwh", spec.capex_usd_per_kwh or 0.0)
            if "fixed_om_usd_per_kw_yr" not in o and abs(fom_rate - (fk + fe * 4.0)) < 1e-6:  # ATB split, as evaluate()
                fom = kw * fk + kw * h * fe
            acres *= h / 4.0
        capex += usd
        annual += _crf(r, life) * usd + fom
        land += acres
        campus += acres if a.location is None else 0.0
    return capex, annual, land, campus


def screen(ctx: Context, mix: Mix, size_gas: bool = True) -> Screened:
    """Dispatch one mix with grid charging off, size its gas, and estimate its cost and CO2."""
    prep, req = ctx.prep, ctx.req
    solar_cf, wind_cf = _blend(ctx, "solar_pv", mix.solar_mw), _blend(ctx, "onshore_wind", mix.wind_mw)
    drivers = prep.drivers
    if solar_cf is not drivers.solar_cf or wind_cf is not drivers.wind_cf:
        drivers = dataclasses.replace(drivers, solar_cf=solar_cf, wind_cf=wind_cf)
    fleet = dataclasses.replace(prep.fleet, solar_mw=mix.solar_mw, wind_mw=mix.wind_mw, batt_mw=mix.battery_mw,
                                batt_mwh=mix.battery_mwh, gas_cc_mw=mix.gas_cc_mw, gas_ct_mw=0.0, grid_charging=False)
    if size_gas:
        need = _firm_floor(ctx, mix, _credits(ctx, mix, solar_cf, wind_cf))
        fleet.gas_cc_mw = _n1_capacity(need) if req.require_n_minus_1 else need
        d = dispatch(fleet, drivers)
        for _ in range(GAS_PASSES - 1):
            short = _shortfall(d.unmet_mw, req.max_unmet_hours)
            if short < UNMET_TOL_MW:
                break
            need += short
            fleet.gas_cc_mw = _n1_capacity(need) if req.require_n_minus_1 else need
            d = _refirm(d, fleet, drivers)
        mix = dataclasses.replace(mix, gas_cc_mw=float(fleet.gas_cc_mw))
    else:
        d = dispatch(fleet, drivers)
    cap = {"solar_pv": mix.solar_mw, "onshore_wind": mix.wind_mw, "gas_cc": mix.gas_cc_mw, "gas_ct": 0.0, "battery": mix.battery_mw}
    summary = summarize(dataclasses.replace(prep, fleet=fleet, drivers=drivers, capacity_mw=cap), d)
    capex, annual, land, campus_land = _capital(ctx, assets_for(ctx, mix))
    energy, co2 = _energy(ctx, d, drivers)
    served = max(summary.demand_mwh - summary.unmet_mwh, 1e-9)
    ic_annual = _crf(ctx.projected.assumptions.discount_rate, ref_value("interconnection_lifetime_years")) * ctx.interconnection_usd
    cfe = _cfe(ctx, d, fleet) if req.clean_metric == "cfe_24_7" else None
    s = Screened(mix, summary, annual + energy, capex + ctx.interconnection_usd, (annual + energy + ic_annual) / served, co2, land, cfe,
                 campus_land)
    s.reason = _screen_reason(ctx, s)
    s.status = "rejected" if s.reason else "screened"
    return s


def _refirm(d: Dispatch, fleet, drivers) -> Dispatch:
    """d re-dispatched with the fleet's new gas: what a full rerun gives, at a fraction of the cost.

    With grid charging off the battery never looks at gas (it charges from surplus and discharges
    into the deficit), and neither do exports or curtailment, so only the firm tiers change. They
    serve each hour's deficit after the battery, so a battery-free dispatch of demand - discharge
    reproduces them (tests/test_builder_optimize.py checks the result against simulate()).
    """
    load = np.maximum(drivers.demand_mw - d.discharge_mw, 0.0)
    firm = dispatch(dataclasses.replace(fleet, batt_mw=0.0, batt_mwh=0.0), dataclasses.replace(drivers, demand_mw=load))
    g = firm.generation_mw
    return dataclasses.replace(d, generation_mw={**d.generation_mw, "gas_cc": g["gas_cc"], "gas_ct": g["gas_ct"]},
                               imports_mw=firm.imports_mw, unmet_mw=firm.unmet_mw)


def _energy(ctx: Context, d: Dispatch, drivers) -> tuple[float, float]:
    """(gas + imports - export credit $/yr, t CO2/yr) for one dispatch."""
    gas = d.generation_mw["gas_cc"] + d.generation_mw["gas_ct"]
    gas_cost = np.broadcast_to(np.asarray(drivers.gas_cc_cost_usd_per_mwh, float), gas.shape)
    usd = float(gas @ gas_cost) + float(d.imports_mw @ drivers.import_cost_usd_per_mwh)
    usd -= ctx.export_credit * float(d.exports_mw @ drivers.export_price_usd_per_mwh)
    spec = ctx.catalog.spec("gas_cc")
    co2 = float(gas.sum()) * (spec.heat_rate_mmbtu_per_mwh or 0.0) * (spec.co2_kg_per_mmbtu or 0.0) / 1000
    co2 += float(d.imports_mw @ ctx.prep.grid.grid_co2_kg_per_mwh) / 1000
    return usd, co2


def _cfe(ctx: Context, d: Dispatch, fleet) -> float:
    """24/7 CFE score on the hourly arrays as evaluate() sees them: rounded to 0.001 MW and clipped to
    their limits like engine.to_result(). Hour matching has a ~1 kW tolerance, so unrounded arrays
    would score a few points higher than the exact run."""
    def r(x, cap=None, nd=3):
        out = np.round(np.asarray(x, float), nd)
        return out if cap is None else np.minimum(out, cap)

    g = d.generation_mw
    ren = r(g["solar_pv"], fleet.solar_mw) + r(g["onshore_wind"], fleet.wind_mw)
    gas = r(g["gas_cc"], fleet.gas_cc_mw) + r(g["gas_ct"], fleet.gas_ct_mw)
    out = cfe_metrics(r(ctx.prep.drivers.demand_mw), ren, r(d.curtailed_mw), r(d.exports_mw, fleet.export_limit_mw),
                      r(d.charge_mw, fleet.batt_mw), r(d.discharge_mw, fleet.batt_mw), r(d.soc_mwh, fleet.batt_mwh),
                      r(d.imports_mw, fleet.import_limit_mw), gas, np.clip(r(ctx.prep.grid.cfe_share, nd=4), 0, 1),
                      fleet.rte, ctx.projected.assumptions.weather_year)
    return float(out["cfe_score_24_7"])


def _clean_value(ctx: Context, onsite: float, cfe: float | None) -> float:
    return (cfe or 0.0) if ctx.req.clean_metric == "cfe_24_7" else onsite


def _clean_reason(ctx: Context) -> str:
    return "cfe_below_target" if ctx.req.clean_metric == "cfe_24_7" else "clean_share_below_target"


def _screen_reason(ctx: Context, s: Screened) -> str | None:
    req, p = ctx.req, ctx.req.project
    if s.summary.hours_unmet > req.max_unmet_hours:
        return "unmet_demand"
    if _clean_value(ctx, s.summary.onsite_clean_share, s.cfe_score_24_7) < req.min_clean_share - 1e-9:
        return _clean_reason(ctx)
    if req.max_co2_t_per_yr is not None and s.est_t_co2e > req.max_co2_t_per_yr:
        return "co2_above_cap"
    if p.budget_usd is not None and s.est_capex_usd > p.budget_usd:
        return "over_budget"
    land = s.land_acres if s.campus_land_acres is None else s.campus_land_acres
    if ctx.footprint_acres is not None and land > ctx.footprint_acres:
        return "over_footprint"
    return None


# ---------------------------------------------------------------------------
# Exact judging
# ---------------------------------------------------------------------------


def scenario_for(ctx: Context, mix: Mix, projected: bool = True, place: Placement | None = None) -> Scenario:
    """A full Scenario for the mix: projected demand (as judged) or current demand (what the store gets)."""
    sc = (ctx.projected if projected else ctx.base).model_copy(deep=True)
    sc.assets = assets_for(ctx, mix, place)
    sc.options["sizing"] = {"plant_type": "optimized", "projected_peak_mw": ctx.projected.demand.peak_mw,
                            "basis": "Least-cost among the designs Griddy's optimizer tested on its hourly dispatch, sized for the projected peak. Not a certified design."}
    return sc


def _find(findings: list[Finding], id_: str) -> Finding | None:
    return next((f for f in findings if f.id == id_), None)


def _checks(ctx: Context, sim: SimulationResult, ev: EvaluationResult, findings: list[Finding], scenario: Scenario | None = None) -> list[str]:
    req, out = ctx.req, []
    if sim.summary.hours_unmet > req.max_unmet_hours:
        out.append("unmet_demand")
    if _clean_value(ctx, sim.summary.onsite_clean_share, ev.extras.get("cfe_score_24_7")) < req.min_clean_share - 1e-9:
        out.append(_clean_reason(ctx))
    if req.max_co2_t_per_yr is not None and ev.emissions.annual_t_co2e > req.max_co2_t_per_yr:
        out.append("co2_above_cap")
    # unmet_demand is the hours check above (it fails on any unmet hour, even an allowed one).
    if any(f.severity == "fail" and f.id not in SITE_LEVEL_FINDINGS | {"unmet_demand"} for f in findings):
        out.append("stress_fail")
    firm = _find(findings, "firm_capacity")
    if req.require_reserve_margin and firm is not None and firm.severity != "pass":
        out.append("firm_margin_short")
    n1 = _find(findings, "n_minus_1")
    if req.require_n_minus_1 and n1 is not None and n1.severity != "pass":
        out.append("n_minus_1_fail")
    project = ev.extras.get("project", {})
    if project.get("budget", {}).get("within_budget") is False:
        out.append("over_budget")
    land = project.get("area", {}).get("land_utilization")
    if land is not None and scenario is not None and ctx.footprint_acres and any(a.location is not None for a in scenario.assets):
        land = _capital(ctx, scenario.assets)[3] / ctx.footprint_acres  # remote cells don't use the campus parcel
    if land is not None and land > 1:
        out.append("over_footprint")
    return out


def _remote_finding(scenario: Scenario) -> list[Finding]:
    """The needs_utility_study finding for solar / wind placed away from the campus (none if all at the campus)."""
    if not any(a.location is not None for a in scenario.assets if a.kind in RENEWABLE):
        return []
    from app.builder.placement import delivery_finding

    f = delivery_finding(scenario)
    return [f] if f else []


def exact(ctx: Context, scenario: Scenario, mix: Mix) -> Judged:
    """simulate(), stress_test() and evaluate() on a full scenario, with the request's checks."""
    sim = simulate(scenario, ctx.catalog)
    findings = stress_test(scenario, sim) + _remote_finding(scenario)
    ev = evaluate(scenario, sim, ctx.catalog)
    return _slim(Judged(mix, scenario, sim, ev, findings, _checks(ctx, sim, ev, findings, scenario)))


def judge(ctx: Context, mix: Mix, place: Placement | None = None) -> Judged:
    """Exact run of a mix; if the firm margin is short, add gas = (15 - margin) / 100 x P / 0.95 once.
    place: where its solar / wind go (default: the request's placement; campus_placement(ctx) for all at the campus)."""
    sc = scenario_for(ctx, mix, place=place)
    sim = simulate(sc, ctx.catalog)
    findings = stress_test(sc, sim)
    firm, bumped = _find(findings, "firm_capacity"), 0.0
    target = 100 * RESERVE_MARGIN_TARGET
    if ctx.req.require_reserve_margin and firm is not None and firm.metric is not None and firm.metric < target:
        bumped = (target + BUMP_PAD_PCT - firm.metric) / 100 * ctx.peak_mw / (1 - EFOR["gas_cc"])
        mix = dataclasses.replace(mix, gas_cc_mw=mix.gas_cc_mw + bumped)
        sc = scenario_for(ctx, mix, place=place)
        sim = simulate(sc, ctx.catalog)
        findings = stress_test(sc, sim)
    ev = evaluate(sc, sim, ctx.catalog)
    findings = findings + _remote_finding(sc)
    j = Judged(mix, sc, sim, ev, findings, _checks(ctx, sim, ev, findings, sc), bumped, place or ctx.place)
    j.weather_ok = _weather_matches(ctx, j)
    return _slim(j)


def _slim(j: Judged) -> Judged:
    """Drop a judged run's hourly arrays once it is scored. They are Python lists of floats, a few MB
    per run, and only _weather_matches() reads them; holding ~20 finalists' worth at once pushed one
    request past 400 MB on a 512 MB host. Mutates in place: _run() keys finalists by id()."""
    j.sim = j.sim.model_copy(update={"hourly": None})
    return j


def _non_dominated(items: list, cost, co2) -> list:
    """Items no other beats on both cost and CO2, cheapest first."""
    out, best = [], math.inf
    for x in sorted(items, key=lambda x: (cost(x), co2(x))):
        if co2(x) < best - 1e-9:
            out.append(x)
            best = co2(x)
    return out


def _finalists(pool: list[Screened], cap: int) -> list[Screened]:
    """The 12 cheapest by estimate plus the estimated cost-vs-CO2 frontier, spread along it, <= cap."""
    by_cost = sorted(pool, key=lambda s: s.est_cost_usd_per_yr)
    chosen = by_cost[: min(CHEAPEST_FINALISTS, cap)]
    ids = {id(s) for s in chosen}
    front = [s for s in _non_dominated(pool, lambda s: s.est_cost_usd_per_yr, lambda s: s.est_t_co2e) if id(s) not in ids]
    room = cap - len(chosen)
    if room > 0 and front:
        if len(front) > room:  # keep both ends of the tradeoff, evenly spaced between
            front = [front[i] for i in sorted(set(np.linspace(0, len(front) - 1, room).round().astype(int).tolist()))]
        chosen += front
    return chosen


def _judge_all(ctx: Context, pool: list[Screened]) -> list[Judged]:
    """Judge finalists from the pool; if none passes, judge the next-cheapest batch once more."""
    out: list[Judged] = []
    for _ in range(JUDGE_ROUNDS):
        todo = [s for s in pool if s.judged is None]
        if not todo:
            break
        for s in _finalists(todo, ctx.req.max_finalists):
            s.judged = judge(ctx, s.mix)
            s.status = "passed" if s.judged.passes else "failed"
            s.reason = s.judged.failed[0] if s.judged.failed else None
            out.append(s.judged)
        if any(j.passes for j in out):
            break
    return out


def _refine(ctx: Context, best: Mix, screened: dict) -> list[Screened]:
    """Half-steps of solar and battery around the winner (3 x 3 = 9 mixes, the winner included)."""
    p, out = ctx.peak_mw, []
    for ds in (-SOLAR_HALF_STEP, 0.0, SOLAR_HALF_STEP):
        for db in (-BATTERY_HALF_STEP, 0.0, BATTERY_HALF_STEP):
            s, b = best.solar_x + ds, best.battery_x + db
            if s < -1e-9 or b < -1e-9:
                continue
            h = best.duration_h if best.battery_mw else min(ctx.req.battery_durations_h)
            m = Mix.of(p, max(s, 0.0) * p, best.wind_mw, max(b, 0.0) * p, h, stage="refine")
            if m.key not in screened:
                screened[m.key] = screen(ctx, m)
                out.append(screened[m.key])
    return out


# ---------------------------------------------------------------------------
# Response
# ---------------------------------------------------------------------------


def _json_safe(x: Any) -> Any:
    if isinstance(x, dict):
        return {str(k): _json_safe(v) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [_json_safe(v) for v in x]
    if isinstance(x, np.ndarray):
        return _json_safe(x.tolist())
    if isinstance(x, (bool, np.bool_)):
        return bool(x)
    if isinstance(x, (int, np.integer)):
        return int(x)
    if isinstance(x, (float, np.floating)):
        return float(x) if math.isfinite(x) else None
    return x


def _counts(findings: list[Finding]) -> dict[str, int]:
    c = Counter(f.severity for f in findings)
    return {k: c.get(k, 0) for k in ("pass", "info", "warn", "fail")}


def _placement_rows(scenario: Scenario, place: Placement) -> list[dict]:
    info = {(o.kind, o.id): o for opts in place.options.values() for o in opts}
    rows = []
    for a in scenario.assets:
        site = "campus" if a.kind not in RENEWABLE or a.id == f"opt-{a.kind}" else a.id.removeprefix(f"opt-{a.kind}-")
        o = info.get((a.kind, site))
        rows.append({"asset_id": a.id, "kind": a.kind, "mw": a.capacity_mw, "site_id": site,
                     "candidate_id": o.info.get("candidate_id") if o else None,
                     "location": a.location.model_dump() if a.location else None, "label": o.label if o else "campus",
                     "gen_tie_usd": o.fixed_usd if o else 0.0, "suitability": o.info.get("suitability") if o else None,
                     **({"candidate": o.info} if o and o.info else {})})
    return rows


def _weather_matches(ctx: Context, j: Judged) -> bool:
    """True when the exact run produced each kind from the same per-MW profile (the MW-weighted blend) the
    screen used: what a live fetch landing, or profiles' stand-in expiring, mid-run would break."""
    place = j.place or ctx.place
    for kind, mw in (("solar_pv", j.mix.solar_mw), ("onshore_wind", j.mix.wind_mw)):
        gen = j.sim.hourly.generation_mw.get(kind)
        if mw <= 0 or gen is None:
            continue
        parts = allocate(place.options[kind], mw)
        cf = sum(part * np.clip(o.cf, 0, 1) for o, part in parts) / sum(part for _, part in parts)
        if not np.allclose(np.asarray(gen, float), mw * cf, rtol=0, atol=2e-3):  # to_result() rounds to 0.001 MW
            return False
    return True


def _metrics(j: Judged) -> dict:
    e, s = j.evaluation, j.sim.summary
    return {"npc_usd": e.economics.npc_usd, "lcoe_usd_per_mwh": e.economics.lcoe_usd_per_mwh,
            "capex_total_usd": e.economics.capex_total_usd, "annual_opex_usd": e.economics.annual_opex_usd,
            "annual_t_co2e": e.emissions.annual_t_co2e, "onsite_clean_share": s.onsite_clean_share,
            "cfe_score_24_7": e.extras.get("cfe_score_24_7"), "hours_unmet": s.hours_unmet, "unmet_mwh": s.unmet_mwh,
            "land_acres": e.extras.get("land_acres_total"), "findings_count": _counts(j.findings),
            "gas_added_for_margin_mw": j.bumped_mw, "passes_checks": j.passes, "failed_checks": j.failed}


def _design(ctx: Context, j: Judged, s: Screened | None, label: str | None = None, full: bool = False) -> dict:
    mix = j.mix
    out = {"label": label, "candidate_id": mix.id, "stage": mix.stage,
           "scenario": scenario_for(ctx, mix, projected=False, place=j.place).model_dump(mode="json"),
           "assets_mw": mix.assets_mw(), "battery_mwh": mix.battery_mwh, "battery_duration_h": mix.duration_h,
           "multiples_of_peak": {"solar_pv": mix.solar_x, "onshore_wind": mix.wind_x, "battery": mix.battery_x},
           **_metrics(j),
           "est_cost_usd_per_yr": s.est_cost_usd_per_yr if s else None, "est_t_co2e": s.est_t_co2e if s else None,
           "placement": _placement_rows(j.scenario, j.place or ctx.place)}
    if full:
        out["projected_scenario"] = j.scenario.model_dump(mode="json")
        out["findings"] = [f.model_dump() for f in j.findings]
    else:
        out["findings"] = [{"id": f.id, "severity": f.severity, "title": f.title} for f in j.findings]
    return out


def _candidate(ctx: Context, s: Screened) -> dict:
    m, j = s.mix, s.judged
    row = {"id": m.id, "stage": m.stage, "assets_mw": m.assets_mw(), "battery_mwh": m.battery_mwh, "battery_duration_h": m.duration_h,
           "multiples_of_peak": {"solar_pv": m.solar_x, "onshore_wind": m.wind_x, "battery": m.battery_x},
           "est_cost_usd_per_yr": s.est_cost_usd_per_yr, "est_capex_usd": s.est_capex_usd,
           "est_lcoe_usd_per_mwh": s.est_lcoe_usd_per_mwh, "est_t_co2e": s.est_t_co2e,
           "onsite_clean_share": s.summary.onsite_clean_share, "cfe_score_24_7": s.cfe_score_24_7,
           "hours_unmet": s.summary.hours_unmet, "land_acres": s.land_acres, "status": s.status, "reason": s.reason,
           "exact": None, "scenario": None}
    if j is not None:
        row["exact"] = {**_metrics(j), "assets_mw": j.mix.assets_mw()}
        row["scenario"] = scenario_for(ctx, j.mix, projected=False, place=j.place).model_dump(mode="json")
    return row


def _baseline(ctx: Context) -> dict:
    """plan_project()'s hybrid at the clean target, judged on the same checks."""
    req = ctx.req
    try:
        plan = plan_project(PlanRequest(scenario=req.scenario, plant_type="hybrid", renewable_energy_share=req.min_clean_share, project=req.project))
    except ValueError as exc:
        return {"label": "Rule-based plan", "available": False, "reason": str(exc)}
    sc = plan["scenario"]
    projected = sc.model_copy(deep=True)
    projected.demand.peak_mw *= ctx.factor
    mw = {k: sum(a.capacity_mw for a in sc.assets if a.kind == k) for k in ("solar_pv", "onshore_wind", "gas_cc", "gas_ct", "battery")}
    j = exact(ctx, projected, Mix.of(ctx.peak_mw, mw["solar_pv"], mw["onshore_wind"], mw["battery"], 0.0, mw["gas_cc"] + mw["gas_ct"]))
    return {"label": "Rule-based plan", "available": True, **_metrics(j), "assets_mw": mw,
            "battery_mwh": sum(a.capacity_mw * (a.duration_h or 4.0) for a in sc.assets if a.kind == "battery"),
            "scenario": sc.model_dump(mode="json"), "basis": plan["screening"]["basis"]}


def _presets(ctx: Context) -> list[dict]:
    """Each preset's mix (and import/export limits) on this site at the projected demand: chart markers."""
    from app.builder.service import list_presets

    out = []
    for p in list_presets(ctx.base.site):
        if p.mode != ctx.base.mode:
            continue
        sc = ctx.projected.model_copy(deep=True)
        sc.assets = [a.model_copy(deep=True) for a in p.assets]
        sc.grid = sc.grid.model_copy(update={"import_limit_mw": p.grid.import_limit_mw, "export_limit_mw": p.grid.export_limit_mw})
        mw = {k: sum(a.capacity_mw for a in p.assets if a.kind == k) for k in ("solar_pv", "onshore_wind", "gas_cc", "gas_ct", "battery")}
        j = exact(ctx, sc, Mix.of(ctx.peak_mw, mw["solar_pv"], mw["onshore_wind"], mw["battery"], 0.0, mw["gas_cc"] + mw["gas_ct"]))
        out.append({"id": p.id, "label": p.name, "assets_mw": mw, "import_limit_mw": p.grid.import_limit_mw, **_metrics(j)})
    return out


def _alternatives(best: Judged, passing: list[Judged]) -> list[tuple[str, Judged]]:
    near = [j for j in passing if j.evaluation.economics.npc_usd <= best.evaluation.economics.npc_usd * (1 + NEAR_COST)]
    co2 = lambda j: j.evaluation.emissions.annual_t_co2e  # noqa: E731
    out: list[tuple[str, Judged]] = []
    picks = [("Lowest CO2 within +10% cost", min(near, key=co2), lambda j: co2(j) < co2(best) - 0.5),
             ("Highest clean share within +10% cost", max(near, key=lambda j: j.sim.summary.onsite_clean_share),
              lambda j: j.sim.summary.onsite_clean_share > best.sim.summary.onsite_clean_share + 0.005),
             ("Lowest CO2 of all passing designs", min(passing, key=co2), lambda j: co2(j) < co2(best) - 0.5)]
    for label, j, better in picks:
        if j is not best and better(j) and all(j is not k for _, k in out):
            out.append((label, j))
    return out


def _provenance(ctx: Context, tested: int, judged: int, best: Judged | None) -> list[dict]:
    items = [Provenance(kind="simulated", source=f"Griddy optimizer: {tested} mixes screened on hourly dispatch(), {judged} judged with simulate(), stress_test() and evaluate()",
                        note="Least-cost among the tested designs, not a proven optimum or a certified design. The screen ranks with an annualized estimate "
                             "(CRF x CAPEX + fixed O&M + hourly gas, import and export costs); every recommended number comes from the exact run.").model_dump()]
    items += [p.model_dump() for p in (best.sim.provenance if best else ctx.prep.provenance)]
    items += [p.model_dump() for p in ctx.place.provenance]
    if best:
        items += list(best.evaluation.extras.get("provenance", {}).values())
    kinds = ("solar_pv", "onshore_wind", "battery", "gas_cc") if ctx.req.include_wind else ("solar_pv", "battery", "gas_cc")
    items += [ctx.catalog.spec(k).provenance.model_dump() for k in kinds]
    seen, out = set(), []
    for p in items:
        key = (p.get("source"), p.get("note"))
        if key not in seen:
            seen.add(key)
            out.append(p)
    return out


def _message(ctx: Context, screened: list[Screened], main: str | None) -> str | None:
    if main is None:
        return None
    target = ctx.req.min_clean_share
    if main in ("clean_share_below_target", "cfe_below_target"):
        what = "24/7 carbon-free score" if main == "cfe_below_target" else "on-site clean share"
        best = max(screened, key=lambda s: _clean_value(ctx, s.summary.onsite_clean_share, s.cfe_score_24_7))
        value = _clean_value(ctx, best.summary.onsite_clean_share, best.cfe_score_24_7)
        # Only suggest what this request left off: wind, site-model locations, (for 24/7 CFE) more grid imports.
        tips = ["lower the target"] + (["turn wind on"] if not ctx.req.include_wind else [])
        tips += ["use site-model locations"] if ctx.place.mode != "site_model" else []
        tips += ["allow more grid imports"] if main == "cfe_below_target" else []
        tip = tips[0] if len(tips) == 1 else f"{', '.join(tips[:-1])} or {tips[-1]}"
        return (f"No tested design reaches a {target:.0%} {what}; the best reached {value:.0%} "
                f"({best.mix.solar_mw:,.0f} MW solar, {best.mix.wind_mw:,.0f} MW wind, {best.mix.battery_mw:,.0f} MW x {best.mix.duration_h:g} h battery). "
                f"Try to {tip}.")
    return f"No tested design passes every check. Most common reason: {REASONS[main].lower()}."


def _has_remote(sc: Scenario) -> bool:
    return any(a.location is not None and a.kind in RENEWABLE for a in sc.assets)


def _campus_block(j: Judged) -> dict:
    e = j.evaluation
    return {"npc_usd": e.economics.npc_usd, "lcoe_usd_per_mwh": e.economics.lcoe_usd_per_mwh, "capex_total_usd": e.economics.capex_total_usd,
            "annual_t_co2e": e.emissions.annual_t_co2e, "onsite_clean_share": j.sim.summary.onsite_clean_share,
            "cfe_score_24_7": e.extras.get("cfe_score_24_7"), "hours_unmet": j.sim.summary.hours_unmet, "assets_mw": j.mix.assets_mw(),
            "gas_added_for_margin_mw": j.bumped_mw, "passes_checks": j.passes, "failed_checks": j.failed}


def _vs_campus(ctx: Context, best: Judged, judged: list[Judged], passing: list[Judged], screened: dict) -> tuple[Judged, dict]:
    """Judge the winning mix once more with every MW at the campus (more gas only if its firm margin falls
    short there). If that is cheaper and passes, it replaces the winner in place, so placement never costs
    more for the mix. Returns (recommended, the response's campus_only block)."""
    keys = ("npc_usd", "lcoe_usd_per_mwh", "annual_t_co2e", "onsite_clean_share")
    if not _has_remote(best.scenario):
        return best, {**_campus_block(best), "same_as_recommended": True, "recommended_minus_campus": dict.fromkeys(keys, 0.0),
                      "basis": "The recommended design already has every MW at the campus: no site-model cell was cheaper per MWh for it."}
    cj = judge(ctx, best.mix, place=campus_placement(ctx))
    remote = _campus_block(best)
    if cj.passes and cj.evaluation.economics.npc_usd < best.evaluation.economics.npc_usd:
        for items in (judged, passing):
            items[:] = [cj if j is best else j for j in items]
        for s in screened.values():
            if s.judged is best:
                s.judged = cj
        ctx.notes.append(f"Placing this design's solar / wind at site-model cells cost ${remote['npc_usd'] - cj.evaluation.economics.npc_usd:,.0f} "
                         "more over the project life than keeping it at the campus, so the recommendation keeps every MW at the campus.")
        return cj, {**_campus_block(cj), "same_as_recommended": True, "recommended_minus_campus": dict.fromkeys(keys, 0.0),
                    "site_model_placement": remote,
                    "basis": "The same mix with every MW at the campus was cheaper than its site-model placement, so it is the recommendation."}
    block = _campus_block(cj)
    return best, {**block, "same_as_recommended": False, "recommended_minus_campus": {k: remote[k] - block[k] for k in keys},
                  "basis": "The recommended mix judged once more with every MW at the campus (simulate, stress test, evaluate), "
                           "with more gas only if its firm margin falls short there."}


def _run(req: OptimizeRequest) -> dict:
    started = time.perf_counter()
    timing: dict[str, float] = {}

    def lap(name: str, since: float) -> float:
        now = time.perf_counter()
        timing[name] = round(1000 * (now - since), 1)
        return now

    ctx = context(req)
    levels = remote_levels(ctx)
    t = lap("prepare_ms", started)
    timing["placement_ms"] = ctx.placement_ms  # part of prepare_ms: site model, remote weather
    screened: dict[tuple, Screened] = {}
    for m in _grid(ctx):
        screened.setdefault(m.key, screen(ctx, m))
    widened = False
    reasons = Counter(s.reason for s in screened.values())
    if not any(s.reason is None for s in screened.values()) and reasons.most_common(1)[0][0] in (_clean_reason(ctx), "co2_above_cap"):
        widened = True
        for m in _wide(ctx):
            if m.key not in screened:
                screened[m.key] = screen(ctx, m)
    t = lap("screen_ms", t)
    judged = _judge_all(ctx, [s for s in screened.values() if s.reason is None])
    t = lap("judge_ms", t)
    passing = [j for j in judged if j.passes]
    best = min(passing, key=lambda j: j.evaluation.economics.npc_usd, default=None)
    refined = False
    if req.refine and best is not None:
        refined = True
        extra = [s for s in _refine(ctx, best.mix, screened) if s.reason is None]
        new = _judge_all(ctx, extra) if extra else []
        judged += new
        passing += [j for j in new if j.passes]
        best = min(passing, key=lambda j: j.evaluation.economics.npc_usd)
    t = lap("refine_ms", t)
    campus_only, weather_ok = None, None
    if best is not None and req.placement == "site_model":
        best, campus_only = _vs_campus(ctx, best, judged, passing, screened)
        weather_ok = best.weather_ok
        if not weather_ok:
            ctx.notes.append("A remote cell's weather changed between the screen and the exact run (a live fetch landed or a stand-in "
                             "expired), so the screen ranked on slightly different solar / wind profiles; every reported number is the exact run's.")
    t = lap("campus_ms", t)
    baseline = _baseline(ctx)
    presets = _presets(ctx)
    t = lap("baseline_ms", t)

    by_mix = {id(s.judged): s for s in screened.values() if s.judged is not None}
    rows = sorted(screened.values(), key=lambda s: s.est_cost_usd_per_yr)
    if best is not None:
        by_mix[id(best)].status = "recommended"
    failed = [s.reason for s in screened.values() if s.status in ("rejected", "failed") and s.reason]
    main = None
    if best is None:
        pool = [s.reason for s in screened.values() if s.status == "failed"] or failed
        main = Counter(pool).most_common(1)[0][0] if pool else "unmet_demand"
    front = _non_dominated(passing, lambda j: j.evaluation.economics.lcoe_usd_per_mwh, lambda j: j.evaluation.emissions.annual_t_co2e)
    recommended = _design(ctx, best, by_mix[id(best)], full=True) if best else None
    vs = None
    if recommended and baseline.get("available"):
        vs = {k: recommended[k] - baseline[k] for k in ("npc_usd", "lcoe_usd_per_mwh", "capex_total_usd", "annual_t_co2e", "onsite_clean_share")}
    rejected = Counter(failed)
    if best is not None and any(f.severity == "fail" and f.id in SITE_LEVEL_FINDINGS for f in best.findings):
        ctx.notes.append("The point-of-interconnection voltage check fails for every mix: it depends on the grid tie, "
                         "so it is reported but doesn't rank designs.")
    resp = {
        "available": True,
        "basis": BASIS.format(n=len(screened)),
        "precomputed": False,
        "tested": len(screened),
        "finalists": len(judged),
        "passing": len(passing),
        "recommended": recommended,
        "alternatives": [_design(ctx, j, by_mix[id(j)], label) for label, j in (_alternatives(best, passing) if best else [])],
        "frontier": [{"candidate_id": j.mix.id, "lcoe_usd_per_mwh": j.evaluation.economics.lcoe_usd_per_mwh,
                      "npc_usd": j.evaluation.economics.npc_usd, "annual_t_co2e": j.evaluation.emissions.annual_t_co2e,
                      "onsite_clean_share": j.sim.summary.onsite_clean_share, "cfe_score_24_7": j.evaluation.extras.get("cfe_score_24_7"),
                      "assets_mw": j.mix.assets_mw(), "battery_mwh": j.mix.battery_mwh, "exact": True, "recommended": j is best,
                      "scenario": scenario_for(ctx, j.mix, projected=False, place=j.place).model_dump(mode="json")} for j in front],
        "candidates": [_candidate(ctx, s) for s in rows],
        "rejected_by_reason": {k: rejected.get(k, 0) for k in REASONS},
        "reasons": REASONS,
        "main_reason": main,
        "message": _message(ctx, list(screened.values()), main),
        "baseline": baseline,
        "vs_baseline": vs,
        "presets": presets,
        "targets": {"clean_metric": req.clean_metric, "min_clean_share": req.min_clean_share, "max_unmet_hours": req.max_unmet_hours,
                    "max_co2_t_per_yr": req.max_co2_t_per_yr, "require_reserve_margin": req.require_reserve_margin,
                    "reserve_margin_target": RESERVE_MARGIN_TARGET, "require_n_minus_1": req.require_n_minus_1,
                    "budget_usd": req.project.budget_usd, "footprint_acres": ctx.footprint_acres},
        "projection": {"years": req.project.projection_years, "annual_growth": req.project.annual_demand_growth,
                       "current_peak_mw": ctx.base.demand.peak_mw, "peak_mw": ctx.projected.demand.peak_mw, "factor": ctx.factor,
                       "basis": "Every design is sized and judged at the projected peak; recommended.scenario keeps today's demand, as the planner does."},
        "search": {"sizing_peak_mw": ctx.peak_mw, "solar_x": list(_with_level(SOLAR_X, levels.get("solar_pv"))),
                   "wind_x": list(_with_level(WIND_X, levels.get("onshore_wind")) if req.include_wind else (0.0,)), "remote_levels": levels,
                   "battery_x": list(BATTERY_X), "battery_durations_h": sorted(set(req.battery_durations_h)), "gas": "sized per design",
                   "grid_import_mw": ctx.prep.fleet.import_limit_mw, "widened": widened,
                   "wide": {"solar_x": list(SOLAR_X_WIDE), "battery_x": list(BATTERY_X_WIDE), "extra_duration_h": DURATION_H_WIDE} if widened else None,
                   "refined": refined, "screen_grid_charging": False,
                   "exact_grid_charging": bool(ctx.prep.fleet.grid_charging),
                   "clean_screen": "cfe_metrics() on each screening dispatch" if req.clean_metric == "cfe_24_7" else "summarize() on-site clean share"},
        "placement": {"requested": req.placement, "used": ctx.place.mode, "notes": ctx.place.notes,
                      "options": {k: [{"id": o.id, "label": o.label, "max_mw": o.max_mw if math.isfinite(o.max_mw) else None,
                                       "location": o.location.model_dump() if o.location else None, "gen_tie_usd": o.fixed_usd, **o.info}
                                      for o in v] for k, v in ctx.place.options.items()},
                      "recommended_remote_mw": ({k: sum(a.capacity_mw for a in best.scenario.assets if a.kind == k and a.location is not None)
                                                 for k in RENEWABLE} if best else None),
                      "weather_consistent": weather_ok, **ctx.place.info},
        "campus_only": campus_only,
        "notes": [*ctx.prep.notes, *ctx.place.notes, *ctx.notes],
        "provenance": _provenance(ctx, len(screened), len(judged), best),
        "timing_ms": timing,
    }
    resp["runtime_ms"] = round(1000 * (time.perf_counter() - started), 1)
    return _json_safe(resp)


# ---------------------------------------------------------------------------
# Caches: in-process LRU, and committed responses for the demo
# ---------------------------------------------------------------------------

_memo: OrderedDict[str, dict] = OrderedDict()
_lock = threading.Lock()
_index: dict[Path, tuple[float, str | None]] = {}


def request_hash(req: OptimizeRequest) -> str:
    """sha256 of the canonical request. Inputs the search ignores (the scenario's assets, name, preset,
    and the options it overwrites) are left out, so the demo cache hits from any starting design."""
    d = req.model_dump(mode="json")
    sc = d["scenario"]
    sc["assets"] = []
    sc.pop("name", None)
    sc.pop("preset", None)
    sc["options"] = {k: v for k, v in sc.get("options", {}).items() if k not in ("project", "sizing", "optimizer")}
    blob = json.dumps({"version": OPTIMIZER_VERSION, "request": d}, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(blob.encode()).hexdigest()


def clear_cache() -> None:
    with _lock:
        _memo.clear()
        _index.clear()


def _precomputed(key: str) -> dict | None:
    if not CACHE_DIR.is_dir():
        return None
    for path in sorted(CACHE_DIR.glob("*.json")):
        try:
            mtime = path.stat().st_mtime
            if _index.get(path, (None,))[0] != mtime:
                with path.open(encoding="utf-8") as f:
                    _index[path] = (mtime, json.load(f).get("request_hash"))
            if _index[path][1] != key:
                continue
            with path.open(encoding="utf-8") as f:
                stored = json.load(f)
        except (OSError, ValueError, AttributeError):
            log.warning("unreadable optimizer cache %s", path)
            continue
        resp = stored["response"]
        resp["precomputed"] = True
        resp["basis"] = f"{resp['basis']} (precomputed for this exact request on {stored.get('created_utc', '')[:10]})"
        return resp
    return None


def optimize(req: OptimizeRequest, *, use_precomputed: bool = True) -> dict:
    """The route's entry point: in-process cache, then a committed response, then a live search."""
    key = request_hash(req)
    with _lock:
        if key in _memo:
            _memo.move_to_end(key)
            return copy.deepcopy(_memo[key])
    resp = _precomputed(key) if use_precomputed else None
    if resp is None:
        resp = _run(req)
    with _lock:
        _memo[key] = resp
        while len(_memo) > MEMO_SIZE:
            _memo.popitem(last=False)
    return copy.deepcopy(resp)


def demo_requests() -> dict[str, OptimizeRequest]:
    from app.builder.service import list_presets

    hybrid = list_presets()[1]  # the store's default industrial preset, at the Kern demo site
    return {"kern_80": OptimizeRequest(scenario=hybrid, min_clean_share=0.8)}


def write_cache(name: str, req: OptimizeRequest, out_dir: Path | None = None) -> Path:
    """Run the search live and save it as <out_dir>/<name>.json for optimize() to serve."""
    out_dir = Path(out_dir or CACHE_DIR)
    out_dir.mkdir(parents=True, exist_ok=True)
    payload = {"name": name, "optimizer_version": OPTIMIZER_VERSION, "request_hash": request_hash(req),
               "created_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
               "request": req.model_dump(mode="json"), "response": _run(req)}
    path = out_dir / f"{name}.json"
    path.write_text(json.dumps(payload, separators=(",", ":"), allow_nan=False), encoding="utf-8")
    with _lock:
        _index.pop(path, None)
    return path


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="python -m app.builder.optimizer", description="Write a committed optimizer response.")
    parser.add_argument("--write-cache", metavar="NAME", required=True, help=f"cache name; built-in requests: {', '.join(demo_requests())}")
    parser.add_argument("--request", type=Path, help="JSON body of a POST /api/projects/optimize (default: the built-in NAME request)")
    parser.add_argument("--out-dir", type=Path, default=CACHE_DIR)
    args = parser.parse_args(argv)
    if args.request:
        req = OptimizeRequest.model_validate_json(args.request.read_text(encoding="utf-8"))
    elif args.write_cache in demo_requests():
        req = demo_requests()[args.write_cache]
    else:
        parser.error(f"no built-in request {args.write_cache!r}; pass --request")
    path = write_cache(args.write_cache, req, args.out_dir)
    resp = json.loads(path.read_text(encoding="utf-8"))["response"]
    rec = resp["recommended"]
    summary = (f"{rec['assets_mw']} battery {rec['battery_mwh']:,.0f} MWh, NPC ${rec['npc_usd'] / 1e9:,.2f}B, "
               f"LCOE ${rec['lcoe_usd_per_mwh']:,.1f}/MWh" if rec else resp["message"])
    print(f"wrote {path} ({path.stat().st_size / 1024:,.0f} KB, {resp['runtime_ms'] / 1000:,.1f} s): {summary}")


if __name__ == "__main__":
    main()
