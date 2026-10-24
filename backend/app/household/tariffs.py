"""Residential TOU tariffs (PG&E bundled, PG&E + SVCE, custom flat) and bills.  OWNER: household (backend).

Bill = sum_h kWh_h x rate(plan, season(month), daytype, local hour) + fixed charges, with an optional per-day
minimum and (when the data carries one) a baseline credit. Periods are defined in local clock hours; hourly
arrays are PST, mapped via calendar().local_hod.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from functools import lru_cache
from typing import Any

import numpy as np

from app.household.data import Ctx, calendar, load_json, meta, num

log = logging.getLogger(__name__)

PLAN_IDS = ("E-TOU-C", "E-TOU-D", "EV2-A", "E-ELEC")
DEFAULT_PLAN = "E-TOU-C"
DAYTYPES = ("weekday", "weekend")


@dataclass
class Plan:
    id: str
    label: str
    utility: str
    season_by_month: list[str]
    periods: dict[str, dict[str, list[str]]]
    rates: dict[str, dict[str, float]]
    effective: str | None = None
    source: str = ""
    url: str | None = None
    fixed_usd_per_month: float = 0.0
    min_usd_per_day: float = 0.0
    baseline_credit_usd_per_kwh: float | None = None
    baseline_allowance_kwh_per_day: dict[str, float] | None = None
    baseline_table: dict | None = None  # {"basic"|"all_electric": {territory: {season: kWh/day}}}
    eligibility: str = ""
    note: str | None = None
    summary: str = ""
    extra_provenance: list[dict] = field(default_factory=list)
    _cache: dict = field(default_factory=dict, repr=False)

    def tables(self) -> tuple[np.ndarray, np.ndarray, list[str]]:
        """(rate_h, period_idx_h, period_names) on the 2024 PST hourly calendar."""
        if "t" not in self._cache:
            cal = calendar()
            names: list[str] = []
            rate_t = np.zeros((12, 2, 24))
            per_t = np.zeros((12, 2, 24), dtype=np.int64)
            for m in range(12):
                season = self.season_by_month[m]
                for w, dt in enumerate(DAYTYPES):
                    for h in range(24):
                        p = self.periods[season][dt][h]
                        if p not in names:
                            names.append(p)
                        per_t[m, w, h] = names.index(p)
                        rate_t[m, w, h] = self.rates[season][p]
            idx = (cal.month_h, cal.weekend_h, cal.local_hod)
            self._cache["t"] = (rate_t[idx], per_t[idx], names)
        return self._cache["t"]

    def weekday_periods(self) -> dict[str, list[str]]:
        seasons = list(dict.fromkeys(self.season_by_month))
        summer = "summer" if "summer" in self.periods else seasons[0]
        winter = "winter" if "winter" in self.periods else seasons[-1]
        return {"summer": list(self.periods[summer]["weekday"]), "winter": list(self.periods[winter]["weekday"])}

    def peak_mask(self) -> np.ndarray:
        _, idx, names = self.tables()
        peak = [i for i, n in enumerate(names) if n == "peak"]
        return np.isin(idx, peak)

    def high_mask(self) -> np.ndarray:
        """Peak + part-peak hours (battery discharge window)."""
        _, idx, names = self.tables()
        hi = [i for i, n in enumerate(names) if n in ("peak", "part_peak")]
        return np.isin(idx, hi)


# ---------------------------------------------------------------------------
# Loading
# ---------------------------------------------------------------------------


def _norm_period(p: str) -> str:
    p = str(p).strip().lower().replace("-", "_").replace(" ", "_")
    return {"offpeak": "off_peak", "partpeak": "part_peak", "partial_peak": "part_peak", "super_off_peak": "super_off_peak",
            "on_peak": "peak"}.get(p, p)


def _parse_plan(pid: str, d: dict) -> Plan:
    sbm = [str(s).lower() for s in d["season_by_month"]]
    if len(sbm) != 12:
        raise ValueError("season_by_month must have 12 entries")
    periods: dict[str, dict[str, list[str]]] = {}
    for season, by_dt in d["periods_by_hour"].items():
        s = season.lower()
        periods[s] = {}
        for dt in DAYTYPES:
            arr = by_dt.get(dt) or by_dt.get("weekday")
            if not isinstance(arr, list) or len(arr) != 24:
                raise ValueError(f"periods_by_hour.{season}.{dt} must have 24 entries")
            periods[s][dt] = [_norm_period(x) for x in arr]
    rates: dict[str, dict[str, float]] = {}
    for season, by_p in d["rates_usd_per_kwh"].items():
        rates[season.lower()] = {_norm_period(p): float(num(v)) for p, v in by_p.items() if num(v) is not None}
    for s in set(sbm):
        if s not in periods or s not in rates:
            raise ValueError(f"season {s} missing periods or rates")
        for dt in DAYTYPES:
            for p in periods[s][dt]:
                if p not in rates[s]:
                    raise ValueError(f"no rate for {s}/{p}")
    allowance = d.get("baseline_allowance_kwh_per_day")
    table = d.get("baseline_kwh_per_day")
    return Plan(
        id=pid, label=d.get("label", pid), utility=d.get("utility", "pge"), season_by_month=sbm, periods=periods, rates=rates,
        effective=d.get("effective"), source=d.get("source", ""), url=d.get("url"),
        fixed_usd_per_month=float(num(d.get("fixed_usd_per_month"), 0.0) or 0.0),
        min_usd_per_day=float(num(d.get("min_usd_per_day"), 0.0) or 0.0),
        baseline_credit_usd_per_kwh=num(d.get("baseline_credit_usd_per_kwh")),
        baseline_allowance_kwh_per_day=allowance if isinstance(allowance, dict) else None,
        baseline_table=table if isinstance(table, dict) else None,
        eligibility=d.get("eligibility", ""), note=d.get("note"), summary=d.get("summary") or _summary(periods, rates),
    )


def _summary(periods, rates) -> str:
    s = "summer" if "summer" in periods else next(iter(periods))
    wk = periods[s]["weekday"]
    peak_hours = [h for h, p in enumerate(wk) if p == "peak"]
    if peak_hours:
        a, b = peak_hours[0], peak_hours[-1] + 1
        return f"Peak {_hh(a)}-{_hh(b)}; summer peak ${rates[s].get('peak', 0):.2f}/kWh vs off-peak ${rates[s].get('off_peak', 0):.2f}"
    return "Time-of-use plan"


def _hh(h: int) -> str:
    h %= 24
    return f"{(h % 12) or 12}{'am' if h < 12 else 'pm'}"


@lru_cache(maxsize=1)
def pge_plans() -> tuple[dict[str, Plan], tuple[str, ...]]:
    doc = load_json("tariffs_pge.json")
    plans: dict[str, Plan] = {}
    problems: list[str] = []
    if not isinstance(doc, dict):
        return plans, ("PG&E tariff file (data/household/tariffs_pge.json) not loaded.",)
    raw = doc.get("plans", {k: v for k, v in doc.items() if not k.startswith("_")})
    for pid, d in raw.items():
        try:
            plans[pid] = _parse_plan(pid, d)
        except (KeyError, TypeError, ValueError, AttributeError) as e:
            problems.append(f"PG&E plan {pid} in tariffs_pge.json is malformed ({e}); left out.")
            log.warning("tariff %s malformed: %s", pid, e)
    return plans, tuple(problems)


def svce_doc() -> dict:
    d = load_json("svce.json")
    return d if isinstance(d, dict) else {}


def _svce_adjust(plan: Plan) -> Plan | None:
    """PG&E plan -> the same plan for an SVCE GreenStart customer (PG&E delivery + SVCE generation + PCIA)."""
    doc = svce_doc()
    if not doc:
        return None
    entry = (doc.get("plans") or {}).get(plan.id)
    m = meta(doc)
    rates = {s: dict(r) for s, r in plan.rates.items()}
    if isinstance(entry, dict):
        tot = (entry.get("greenstart_total_usd_per_kwh") or entry.get("total_rates_usd_per_kwh") or entry.get("rates_usd_per_kwh")
               or entry.get("svce_total_usd_per_kwh"))
        delta = entry.get("greenstart_adjustment_usd_per_kwh") or entry.get("adjustment_usd_per_kwh") or entry.get("delta_usd_per_kwh")
        if isinstance(tot, dict):
            for s, by_p in tot.items():
                for p, v in by_p.items():
                    if s.lower() in rates and num(v) is not None:
                        rates[s.lower()][_norm_period(p)] = float(num(v))
        elif isinstance(delta, dict):
            for s, by_p in delta.items():
                for p, v in (by_p.items() if isinstance(by_p, dict) else ()):
                    if s.lower() in rates and _norm_period(p) in rates[s.lower()] and num(v) is not None:
                        rates[s.lower()][_norm_period(p)] += float(num(v))
        elif num(delta) is not None:
            for s in rates:
                for p in rates[s]:
                    rates[s][p] += float(num(delta))
        else:
            return None
    elif num(doc.get("adjustment_usd_per_kwh")) is not None:
        adj = float(num(doc.get("adjustment_usd_per_kwh")))
        for s in rates:
            for p in rates[s]:
                rates[s][p] += adj
    else:
        return None
    eff = (entry or {}).get("effective") if isinstance(entry, dict) else None
    return Plan(
        id=plan.id, label=f"{plan.label} + SVCE GreenStart", utility="pge_svce", season_by_month=plan.season_by_month,
        periods=plan.periods, rates=rates, effective=eff or doc.get("effective") or m.get("effective"),
        source=f"{plan.source}; {m.get('source', 'SVCE residential rate comparison')}", url=m.get("url") or plan.url,
        fixed_usd_per_month=plan.fixed_usd_per_month, min_usd_per_day=plan.min_usd_per_day,
        baseline_credit_usd_per_kwh=plan.baseline_credit_usd_per_kwh, baseline_allowance_kwh_per_day=plan.baseline_allowance_kwh_per_day,
        baseline_table=plan.baseline_table, eligibility=plan.eligibility, note=(entry or {}).get("note") if isinstance(entry, dict) else None, summary=plan.summary,
    )


@lru_cache(maxsize=1)
def svce_plans() -> dict[str, Plan]:
    out = {}
    for pid, p in pge_plans()[0].items():
        try:
            sp = _svce_adjust(p)
        except (TypeError, ValueError, AttributeError):
            log.exception("svce adjust failed for %s", pid)
            sp = None
        if sp is not None:
            out[pid] = sp
    return out


# PG&E baseline territory of the nearest solar-profile city (inferred; PG&E maps territory by address, not loaded here).
CITY_TERRITORY = {"san_francisco": "T", "oakland": "X", "san_jose": "X", "sacramento": "S", "fresno": "R", "bakersfield": "W"}


def with_baseline(plan: Plan, city_slug: str, all_electric: bool) -> tuple[Plan, str | None]:
    """A copy of the plan with the baseline allowance for the inferred territory set (when the plan has a credit)."""
    if not plan.baseline_credit_usd_per_kwh or not plan.baseline_table or plan.baseline_allowance_kwh_per_day:
        return plan, None
    terr = CITY_TERRITORY.get(city_slug, "X")
    code = "all_electric" if all_electric else "basic"
    by_t = plan.baseline_table.get(code) or plan.baseline_table.get("basic") or {}
    allow = by_t.get(terr)
    if not isinstance(allow, dict):
        return plan, None
    from dataclasses import replace

    return replace(plan, baseline_allowance_kwh_per_day={k: float(num(v, 0.0) or 0.0) for k, v in allow.items()}, _cache={}), terr


def flat_plan(rate: float, label: str, source: str, utility: str = "other") -> Plan:
    per = {"all": {dt: ["flat"] * 24 for dt in DAYTYPES}}
    return Plan(id="custom", label=label, utility=utility, season_by_month=["all"] * 12, periods=per,
                rates={"all": {"flat": float(rate)}}, source=source, summary="Flat $/kWh (no time-of-use)")


def plans_for(utility: str, ctx: Ctx | None = None) -> dict[str, Plan]:
    pge, problems = pge_plans()
    if ctx:
        for p in problems:
            ctx.warn(p)
    if utility == "pge":
        return dict(pge)
    if utility == "pge_svce":
        sv = svce_plans()
        if ctx and pge and not sv:
            ctx.warn("SVCE rate data (data/household/svce.json) not loaded or unrecognised: showing PG&E bundled rates, "
                     "which differ from SVCE customers' generation charges by a few cents/kWh.")
        return sv or dict(pge)
    return {}


# ---------------------------------------------------------------------------
# Eligibility
# ---------------------------------------------------------------------------


def eligible(plan_id: str, has_ev: bool, has_battery: bool, electric_heating: bool, has_solar: bool) -> tuple[bool, str | None]:
    if plan_id == "EV2-A":
        ok = has_ev or has_battery
        return ok, None if ok else "Requires a plug-in EV or home battery storage."
    if plan_id == "E-ELEC":
        ok = has_ev or has_battery or electric_heating
        return ok, None if ok else "Requires an EV, battery storage, or an electric heat pump for space or water heating."
    return True, None


# ---------------------------------------------------------------------------
# Bills
# ---------------------------------------------------------------------------


@dataclass
class BillResult:
    annual_usd: float
    monthly_usd: np.ndarray
    energy_usd: float
    fixed_usd: float
    by_period: list[dict]
    import_kwh: float
    export_credit_usd: float
    baseline_credit_usd: float
    notes: list[str]


def compute_bill(plan: Plan, import_kwh: np.ndarray, export_kwh: np.ndarray | None = None,
                 export_rate_h: np.ndarray | None = None) -> BillResult:
    cal = calendar()
    rate_h, idx_h, names = plan.tables()
    energy_h = import_kwh * rate_h
    energy_m = np.bincount(cal.month_h, weights=energy_h, minlength=12)
    notes: list[str] = []

    base_credit_m = np.zeros(12)
    if plan.baseline_credit_usd_per_kwh and plan.baseline_allowance_kwh_per_day:
        kwh_m = np.bincount(cal.month_h, weights=import_kwh, minlength=12)
        for m in range(12):
            allow = num(plan.baseline_allowance_kwh_per_day.get(plan.season_by_month[m]), 0.0) or 0.0
            base_credit_m[m] = min(kwh_m[m], allow * cal.days_in_month[m]) * plan.baseline_credit_usd_per_kwh
    energy_m = energy_m - base_credit_m

    credit_m = np.zeros(12)
    if export_kwh is not None and export_rate_h is not None:
        credit_m = np.bincount(cal.month_h, weights=export_kwh * export_rate_h, minlength=12)
    min_m = plan.min_usd_per_day * cal.days_in_month
    fixed_m = np.full(12, plan.fixed_usd_per_month)
    if credit_m.sum() > 0:
        # Net Billing: export credits offset energy charges within the year; no cash-out of a leftover credit.
        net = energy_m.sum() - credit_m.sum()
        energy_annual = max(net, float(min_m.sum()))
        if net < min_m.sum():
            notes.append("Export credits exceed the year's energy charges; the leftover credit is not paid out (assumed).")
        monthly = energy_m - credit_m + fixed_m
    else:
        e = np.maximum(energy_m, min_m)
        energy_annual = float(e.sum())
        monthly = e + fixed_m
    by_period = []
    kwh_p = np.bincount(idx_h, weights=import_kwh, minlength=len(names))
    usd_p = np.bincount(idx_h, weights=energy_h, minlength=len(names))
    for i, n in enumerate(names):
        by_period.append({"period": n, "kwh": float(kwh_p[i]), "usd": float(usd_p[i]),
                          "avg_rate": float(usd_p[i] / kwh_p[i]) if kwh_p[i] > 0 else float(np.mean(rate_h[idx_h == i]))})
    return BillResult(
        annual_usd=float(energy_annual + fixed_m.sum()), monthly_usd=monthly, energy_usd=float(energy_annual),
        fixed_usd=float(fixed_m.sum()), by_period=by_period, import_kwh=float(import_kwh.sum()),
        export_credit_usd=float(credit_m.sum()), baseline_credit_usd=float(base_credit_m.sum()), notes=notes,
    )


# ---------------------------------------------------------------------------
# NBT export rates
# ---------------------------------------------------------------------------


@lru_cache(maxsize=1)
def export_rates() -> tuple[np.ndarray | None, dict]:
    """(export $/kWh per 2024 PST hour, info) from nbt_export_rates_pge.json, or (None, {}) if not loaded."""
    doc = load_json("nbt_export_rates_pge.json")
    if not isinstance(doc, dict):
        return None, {}
    try:
        table = _export_table(doc)
    except (KeyError, TypeError, ValueError, IndexError):
        log.exception("nbt_export_rates_pge.json unrecognised")
        return None, {}
    if table is None:
        return None, {}
    cal = calendar()
    m = meta(doc)
    adder = 0.0
    acc = doc.get("acc_plus_adder_usd_per_kwh")
    info = {"source": m.get("source", "PG&E NBT export rates"), "url": m.get("url"), "vintage": doc.get("vintage") or m.get("vintage"),
            "note": m.get("note"), "mean": float(table.mean()), "acc_plus": acc if isinstance(acc, dict) else None, "adder": adder,
            "tariff_url": (m.get("tariff") or {}).get("url") if isinstance(m.get("tariff"), dict) else None}
    return table[cal.month_h, cal.weekend_h, cal.local_hod], info


def _export_table(doc: dict) -> np.ndarray | None:
    """Accepts {"rates_usd_per_kwh": [12][2][24]} or {"weekday": [12][24], "weekend": [12][24]} or month-keyed dicts."""
    for k in ("bundled_total_usd_per_kwh", "rates_usd_per_kwh", "export_usd_per_kwh", "matrix_usd_per_kwh", "rates"):
        v = doc.get(k)
        if isinstance(v, list):
            a = np.asarray(v, float)
            if a.shape == (12, 2, 24):
                return a
            if a.shape == (12, 24):
                return np.stack([a, a], axis=1)
        if isinstance(v, dict):
            t = _export_table(v)
            if t is not None:
                return t
    wd, we = doc.get("weekday"), doc.get("weekend")
    if isinstance(wd, list) and isinstance(we, list):
        a, b = np.asarray(wd, float), np.asarray(we, float)
        if a.shape == (12, 24) and b.shape == (12, 24):
            return np.stack([a, b], axis=1)
    if isinstance(wd, dict) and isinstance(we, dict):
        a = np.asarray([wd[str(m)] if str(m) in wd else list(wd.values())[m - 1] for m in range(1, 13)], float)
        b = np.asarray([we[str(m)] if str(m) in we else list(we.values())[m - 1] for m in range(1, 13)], float)
        if a.shape == (12, 24) and b.shape == (12, 24):
            return np.stack([a, b], axis=1)
    return None


def rate_options() -> list[dict[str, Any]]:
    pge, _ = pge_plans()
    return [{"id": p.id, "label": p.label, "utility": p.utility, "summary": p.summary, "eligibility": p.eligibility} for p in pge.values()]
