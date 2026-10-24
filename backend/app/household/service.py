"""Griddy Home service: options(), parse_usage(), plan().  OWNER: household (backend).

plan() builds the 2024 hourly household load, prices it on the chosen tariff (and every eligible alternative),
computes CAISO-hourly and provider carbon, runs the what-if scenarios, the solar + battery analysis (Net Billing
Tariff), a multi-year projection and recommendations. Every block carries provenance; every fallback a warning.
"""

from __future__ import annotations

import math
import re

import numpy as np

from app.household import carbon as carbon_mod
from app.household import load as load_mod
from app.household import tariffs as tar
from app.household.data import HOURS, Ctx, calendar, load_json, meta, pv_profiles, zip_centroids
from app.household.models import HouseholdOptions, HouseholdRequest, HouseholdResult, UsageParseResult
from app.household.recommend import recommendations
from app.household.solar import haversine_km, nearest_profile, savings_path
from app.household.whatif import Engine, Outcome, edited_load, scenarios

UTILITIES = [
    {"id": "pge", "label": "PG&E (bundled)", "supported": True},
    {"id": "pge_svce", "label": "PG&E + Silicon Valley Clean Energy", "supported": True},
    {"id": "sce", "label": "Southern California Edison", "supported": False},
    {"id": "sdge", "label": "San Diego Gas & Electric", "supported": False},
    {"id": "municipal", "label": "Municipal utility (SMUD, LADWP, Palo Alto, ...)", "supported": False},
    {"id": "other", "label": "Other", "supported": False},
]
DEFAULT_CITY = "san_jose"


def _finite(x: float, default: float = 0.0) -> float:
    x = float(x)
    return x if math.isfinite(x) else default


def _r(x: float, nd: int = 2) -> float:
    return round(_finite(x), nd)


def _rl(a, nd: int = 2) -> list[float]:
    return [_r(v, nd) for v in a]


# ---------------------------------------------------------------------------
# Options + usage parse
# ---------------------------------------------------------------------------


def options() -> HouseholdOptions:
    m = meta(load_json("tariffs_pge.json"))
    provs = []
    if m:
        provs.append({"kind": "observed", "source": m.get("title", "PG&E residential TOU tariffs"),
                      "url": "https://www.pge.com/tariffs/en/rate-information/electric-rates.html", "note": f"retrieved {m.get('retrieved', '')}"})
    sm = meta(load_json("svce.json"))
    if sm:
        provs.append({"kind": "observed", "source": sm.get("title", "SVCE rates"), "url": (sm.get("sources") or [{}])[0].get("url"),
                      "note": f"effective {sm.get('effective', '')}"})
    return HouseholdOptions(utilities=UTILITIES, plans=tar.rate_options(), default_plan="E-TOU-C",
                            solar_profile_cities=[p.city for p in pv_profiles().values()], provenance=provs)


def parse_usage(csv_text: str) -> UsageParseResult:
    return UsageParseResult(**load_mod.parse_green_button(csv_text))


# ---------------------------------------------------------------------------
# Location
# ---------------------------------------------------------------------------


def locate(req: HouseholdRequest, ctx: Ctx) -> tuple[dict, str]:
    profs = pv_profiles()
    lat = lon = None
    note = None
    z = re.sub(r"\D", "", req.zip or "")[:5]
    if req.lat is not None and req.lon is not None:
        lat, lon = float(req.lat), float(req.lon)
        zc = zip_centroids()
        near = min(zc, key=lambda k: haversine_km(lat, lon, *zc[k])) if zc else None
        note = "Location from your map pin" + (f" (nearest ZIP {near})." if near else ".")
        if not (32.4 <= lat <= 42.1 and -124.6 <= lon <= -114.1):
            note += " The pin looks outside California; rates and solar data are California-only."
            ctx.warn(note)
        z = ""  # the pin wins over a typed ZIP or city
    elif z:
        zc = zip_centroids()
        if z in zc:
            lat, lon = zc[z]
        elif zc:
            near = min(zc, key=lambda k: abs(int(k) - int(z)))
            if abs(int(near) - int(z)) <= 20:
                lat, lon = zc[near]
                note = f"ZIP {z} not in the Census ZCTA list; used nearby ZIP {near}."
            else:
                note = f"ZIP {z} is not a California ZIP in the Census list."
    if lat is None and req.city and not (req.lat is not None and req.lon is not None):
        key = re.sub(r"[^a-z]", "", req.city.lower())
        for p in profs.values():
            if re.sub(r"[^a-z]", "", p.city.lower()) == key:
                lat, lon = p.lat, p.lon
                break
        if lat is None:
            note = (note + " " if note else "") + f"City '{req.city}' not matched to a solar-profile city."
    if lat is None:
        d = profs.get(DEFAULT_CITY)
        lat, lon = (d.lat, d.lon) if d else (37.3, -121.8)
        note = (note + " " if note else "") + "No usable ZIP or city: using San Jose (PG&E / SVCE territory) as the location."
        ctx.warn(note)
    prof = nearest_profile(lat, lon)
    if prof is None:
        ctx.warn("PVWatts solar profiles (data/household/pvwatts/) not loaded: solar analysis unavailable.")
        return {"zip": req.zip, "city": req.city, "lat": lat, "lon": lon, "solar_profile_city": "not loaded", "note": note}, DEFAULT_CITY
    dist = haversine_km(lat, lon, prof.lat, prof.lon)
    note = (note + " " if note else "") + f"Solar uses the cached PVWatts typical-year profile for {prof.city}, {dist:,.1f} km from this location; it is not rooftop-specific weather."
    if dist > 80:
        note = (note + " " if note else "") + f"Nearest solar profile ({prof.city}) is {dist:,.0f} km away; solar output is approximate."
    pinned = req.lat is not None and req.lon is not None
    return {"zip": None if pinned else req.zip, "city": None if pinned else req.city, "lat": float(lat), "lon": float(lon), "solar_profile_city": prof.city, "note": note}, prof.slug


# ---------------------------------------------------------------------------
# Plan selection
# ---------------------------------------------------------------------------


def choose_plan(req: HouseholdRequest, ctx: Ctx, slug: str) -> tuple[tar.Plan, dict[str, tar.Plan], list[str]]:
    bill_warn: list[str] = []
    plans = tar.plans_for(req.utility, ctx)
    all_electric = bool(req.electric_heating)
    if plans:
        fitted = {}
        terr = None
        for pid, p in plans.items():
            fitted[pid], t = tar.with_baseline(p, slug, all_electric)
            terr = terr or t
        plans = fitted
        if terr:
            ctx.record("baseline_territory", terr, "PG&E baseline territory (for the E-TOU-C baseline credit)",
                       "Inferred from the nearest city; PG&E assigns territory by address (Preliminary Statement Part A)",
                       kind="inferred", note="Code H (all-electric) allowances used when electric heating is on.")
        pid = req.rate_plan
        if pid == "unknown":
            pid = tar.DEFAULT_PLAN
            bill_warn.append("Rate plan unknown: using E-TOU-C, PG&E's default residential time-of-use plan.")
        if pid not in plans:
            fallback = tar.DEFAULT_PLAN if tar.DEFAULT_PLAN in plans else next(iter(plans))
            bill_warn.append(f"Rates for {pid} are not loaded; using {fallback}.")
            pid = fallback
        if req.custom_rate_usd_per_kwh:
            bill_warn.append("A custom $/kWh was entered, but PG&E published rates are loaded and used instead.")
        return plans[pid], plans, bill_warn
    if req.utility in ("pge", "pge_svce"):
        bill_warn.append("PG&E tariff data is not loaded; using a flat rate instead of time-of-use pricing.")
    rate = req.custom_rate_usd_per_kwh
    if rate:
        src = "Your entered rate"
        ctx.record("custom_rate", rate, "Custom electricity rate", src, unit="$/kWh")
    else:
        rate = float(ctx.a("ca_avg_rate_usd_per_kwh"))
        src = "California average residential price (EIA 2024); enter your own $/kWh for a real estimate"
        bill_warn.append(f"Rates for {req.utility.upper()} are not loaded: using the California average "
                         f"${rate:.2f}/kWh. Enter your own $/kWh (total bill / kWh) for a better estimate.")
    label = "Custom flat rate" if req.custom_rate_usd_per_kwh else "California average flat rate (estimate)"
    plan = tar.flat_plan(rate, label, src, req.utility)
    return plan, {}, bill_warn


# ---------------------------------------------------------------------------
# plan()
# ---------------------------------------------------------------------------


def plan(req: HouseholdRequest) -> HouseholdResult:
    from app.household.time_view import time_view
    ctx = Ctx()
    cal = calendar()
    location, slug = locate(req, ctx)
    lm = load_mod.build_load(req, ctx, slug)
    total = lm.total()
    cur_plan, plans, bill_warn = choose_plan(req, ctx, slug)
    prof = pv_profiles().get(slug)
    pv_unit = prof.hourly_8784 if prof is not None else None
    eng = Engine(ctx, cur_plan, plans, pv_unit, req.utility)

    # Existing system
    existing_kw = 0.0
    existing_batt = 0.0
    if req.has_solar:
        existing_kw = float(req.existing_solar_kw) if req.existing_solar_kw else float(ctx.a("existing_solar_kw_default"))
        if not req.existing_solar_kw:
            ctx.warn(f"You have solar but no size was given: assumed {existing_kw:g} kW.")
        ctx.warn("Existing solar: your usage is treated as total household consumption. If it comes from a bill or meter "
                 "data that is net of solar, actual consumption is higher.")
    if req.has_battery:
        existing_batt = float(req.existing_battery_kwh) if req.existing_battery_kwh else float(ctx.a("existing_battery_kwh_default"))
        if not req.existing_battery_kwh:
            ctx.warn(f"You have a battery but no size was given: assumed {existing_batt:g} kWh.")
    base = eng.run(total, pv_kw=existing_kw, battery_kwh=existing_batt)

    has_ev = bool(req.ev and req.ev.has_ev)
    owns = req.owns_home is not False
    plan_rows = []
    for pid, p in plans.items():
        ok, why = tar.eligible(pid, has_ev, existing_batt > 0, bool(req.electric_heating), existing_kw > 0)
        res = base if p is cur_plan else eng.run(total, plan=p, pv_kw=existing_kw, battery_kwh=existing_batt)
        plan_rows.append({"plan": pid, "label": p.label, "annual_usd": _r(res.usd), "eligible": ok,
                          "note": why if not ok else ("current plan" if p is cur_plan else None)})

    # ---- usage
    season = np.asarray([s == "summer" for s in cur_plan.season_by_month]) if "summer" in cur_plan.periods \
        else np.asarray([5 <= m <= 8 for m in range(12)])
    summer_h = season[cal.month_h]
    avg_all = load_mod.avg_day(total)
    ca_kwh = float(ctx.a("ca_avg_annual_kwh"))
    peak_mask = cur_plan.peak_mask()
    if not peak_mask.any():
        peak_mask = (cal.local_hod >= 16) & (cal.local_hod < 21)
    by_end_use = {k: _r(v.sum(), 1) for k, v in lm.components.items() if v.sum() > 0.05}
    ca_prov = ctx.used.get("ca_avg_annual_kwh", {})
    usage = {
        "annual_kwh": _r(total.sum(), 1), "monthly_kwh": _rl(load_mod.monthly(total), 1),
        "avg_day_kwh": {"summer": _rl(load_mod.avg_day(total, summer_h), 4), "winter": _rl(load_mod.avg_day(total, ~summer_h), 4),
                        "all": _rl(avg_all, 4)},
        "by_end_use_kwh": by_end_use, "peak_hour": int(np.argmax(avg_all)),
        "peak_window_share": _r(float(total[peak_mask].sum() / max(total.sum(), 1e-9)), 4),
        "benchmark": {"ca_avg_annual_kwh": _r(ca_kwh, 0), "label": "California average household",
                      "provenance": _prov(ca_prov)},
    }

    # ---- bill
    b = base.bill
    bill_provs = [{"kind": "observed", "source": cur_plan.source or cur_plan.label, "url": cur_plan.url,
                   "note": f"effective {cur_plan.effective}" if cur_plan.effective else None}]
    if cur_plan.id != "custom":
        if cur_plan.baseline_credit_usd_per_kwh and b.baseline_credit_usd > 0:
            bill_provs.append({"kind": "inferred", "source": "Baseline credit on baseline-allowance kWh",
                               "note": f"${cur_plan.baseline_credit_usd_per_kwh:.4f}/kWh credit; territory inferred from location"})
        elif cur_plan.baseline_credit_usd_per_kwh:
            bill_warn.append("Baseline credit not modelled (territory allowances not loaded).")
        bill_provs.append({"kind": "observed", "source": "PG&E Base Services Charge (fixed, per day)",
                           "note": f"${cur_plan.fixed_usd_per_month:.2f}/month standard tier; CARE/FERA tiers and the semi-annual "
                                   "California Climate Credit are not applied"})
    if base.flows is not None:
        bill_provs.append({"kind": "simulated", "source": "Existing solar under Net Billing export rates",
                           "note": "Legacy NEM 2 customers earn closer-to-retail export credits than shown."})
    grid_kwh = max(base.grid_kwh, 1e-9)
    bill = {
        "plan": cur_plan.id, "plan_label": cur_plan.label, "annual_usd": _r(b.annual_usd), "monthly_usd": _rl(b.monthly_usd),
        "fixed_usd": _r(b.fixed_usd),
        "by_period": [{"period": r["period"], "kwh": _r(r["kwh"], 1), "usd": _r(r["usd"]), "avg_rate": _r(r["avg_rate"], 4)} for r in b.by_period],
        "effective_usd_per_kwh": _r(b.annual_usd / grid_kwh, 4), "periods_by_hour": cur_plan.weekday_periods(),
        "plan_comparison": plan_rows, "provenance": bill_provs, "warnings": bill_warn + b.notes,
    }

    # ---- sources + carbon
    sources = carbon_mod.sources_block(req.utility, ctx)
    base_shape, _ = load_mod.base_shape_hourly(ctx)
    inten = carbon_mod.intensity_kg_per_kwh()[0]
    ca_avg_kg = ca_kwh * float(base_shape @ inten / max(base_shape.sum(), 1e-9))
    carbon = carbon_mod.carbon_block(base.grid_import, sources, ctx, ca_avg_kg)

    # ---- what-if scenarios
    solar_note = None if owns else "Renters usually cannot install rooftop solar: see community solar / green-power plans."
    if req.utility not in ("pge", "pge_svce") and pv_unit is not None:
        ctx.warn(f"Solar export credits for {req.utility.upper()} use PG&E's Net Billing export values as a proxy "
                 "(your utility's export rates are not loaded).")
    elif req.utility == "pge_svce":
        ctx.record("svce_export_credit", "PG&E NBT values", "SVCE solar export credit",
                   "Assumption: SVCE's NEM-SVCE generation export credit equals PG&E's 'Energy Produced' values (unconfirmed)",
                   url="https://www.svcleanenergy.org/solar-billing-plan")
    scen = scenarios(eng, lm, base, ctx, req, existing_kw, existing_batt, plan_rows, owns, solar_note)

    # ---- combined what-ifs
    w = req.whatif
    wp = None
    if w and w.rate_plan and w.rate_plan in plans:
        wp = plans[w.rate_plan]
    elif w and w.rate_plan and w.rate_plan not in ("unknown", cur_plan.id):
        ctx.warn(f"What-if rate plan {w.rate_plan} is not loaded; kept {cur_plan.id}.")
    t_act, _ = edited_load(lm, ctx, ev_start=w.ev_charge_start_hour if w else None, laundry_hour=w.laundry_hour if w else None,
                           dishwasher_hour=w.dishwasher_hour if w else None, ac_delta_f=w.ac_setpoint_delta_f if w else None)
    actions = eng.run(t_act, plan=wp, pv_kw=existing_kw, battery_kwh=existing_batt)
    new_kw = float(w.solar_kw) if w and w.solar_kw else 0.0
    new_batt = float(w.battery_kwh) if w and w.battery_kwh else 0.0
    if req.roof_kw_max is not None and new_kw + existing_kw > req.roof_kw_max:
        new_kw = max(0, req.roof_kw_max - existing_kw)
        ctx.warn(f"New solar limited to {new_kw:g} kW by your {req.roof_kw_max:g} kW roof capacity, less existing solar.")
    if new_kw > 0 and not owns:
        ctx.warn("What-if solar not applied to the combined result: renters usually cannot install rooftop solar.")
    solar_in_combined = owns and pv_unit is not None and (new_kw > 0 or (new_batt > 0 and existing_kw > 0))
    if new_batt > 0 and new_kw <= 0 and existing_kw <= 0:
        ctx.warn("A battery without solar is not modelled (no grid charging assumed), so it has no effect here.")
    if solar_in_combined:
        combined = eng.run(t_act, plan=eng.nbt_plan(wp), pv_kw=existing_kw + new_kw, battery_kwh=existing_batt + new_batt, new_solar=True)
    else:
        combined = actions
    whatif = {
        "baseline": {"annual_usd": _r(base.usd), "annual_kwh": _r(base.grid_kwh, 1), "annual_kg": _r(base.kg, 1)},
        "scenarios": [{**s, "annual_usd_saved": _r(s["annual_usd_saved"]), "annual_kwh_change": _r(s["annual_kwh_change"], 3),
                       "annual_kg_saved": _r(s["annual_kg_saved"], 1)} for s in scen],
        "combined": {"annual_usd": _r(combined.usd), "annual_kwh": _r(combined.grid_kwh, 1), "annual_kg": _r(combined.kg, 1),
                     "annual_usd_saved": _r(base.usd - combined.usd), "annual_kg_saved": _r(base.kg - combined.kg, 1)},
    }

    # ---- solar section
    esc = (w.rate_escalation_pct if w and w.rate_escalation_pct is not None else float(ctx.a("rate_escalation_pct_per_yr"))) / 100.0
    if w and w.rate_escalation_pct is not None:
        ctx.record("rate_escalation_pct_per_yr", w.rate_escalation_pct, "Electricity price escalation (your what-if)", "Your input", unit="%/yr")
    solar = None
    upfront_by_scen: dict[str, float] = {}
    pv_cost = float(ctx.a("pv_installed_usd_per_w")) * 1000.0
    batt_cost = float(ctx.a("battery_installed_usd_per_kwh"))
    itc = float(ctx.a("federal_residential_clean_energy_credit_pct")) / 100.0
    upfront_by_scen["solar_5kw"] = 5.0 * pv_cost
    upfront_by_scen["solar_battery"] = (0.0 if existing_kw > 0 else 5.0 * pv_cost) + 10.0 * batt_cost
    if (new_kw > 0 or new_batt > 0 or req.has_solar) and pv_unit is not None:
        solar = solar_block(eng, total, base, ctx, cal, existing_kw, existing_batt, new_kw, new_batt, owns, esc, pv_cost, batt_cost, itc, prof)

    # ---- projection
    years = int(w.years) if w and w.years else 20
    deg = float(ctx.a("pv_degradation_pct_per_yr")) / 100.0
    t = np.arange(1, years + 1)
    growth = (1 + esc) ** (t - 1)
    baseline_usd = base.usd * growth
    actions_usd = actions.usd * growth
    with_solar_usd = None
    net_upfront = 0.0
    replacement_cost = np.zeros(years)
    if solar_in_combined:
        sav1 = actions.usd - combined.usd
        bonus = _bonus_credit(eng, combined)
        savings = savings_path(sav1, combined.bill.export_credit_usd, bonus, years, esc, deg)
        with_solar_usd = actions_usd - savings
        net_upfront = (new_kw * pv_cost + new_batt * batt_cost) * (1 - itc)
        batt_life = max(1, int(float(ctx.a("battery_life_years"))))
        for y in range(batt_life, years, batt_life):
            replacement_cost[y] = new_batt * batt_cost  # at start of year after rated life
    path = with_solar_usd if with_solar_usd is not None else actions_usd
    cum = np.cumsum(baseline_usd - path - replacement_cost) - net_upfront
    proj_provs = [_prov(ctx.used["rate_escalation_pct_per_yr"])]
    if with_solar_usd is not None:
        proj_provs.append({"kind": "assumption", "source": "Solar projection: retail escalation, flat base export values, 9-year ACC Plus bonus",
                           "note": f"{deg * 100:g}%/yr output degradation; cumulative savings net of ${net_upfront:,.0f} upfront and same-cost new battery replacements after its rated life. Future export schedules are unavailable; base export values held flat, not escalated with retail rates. No replacement cost inflation."})
    projection = {"years": [int(x) for x in t], "baseline_usd": _rl(baseline_usd), "with_actions_usd": _rl(actions_usd),
                  "with_solar_usd": _rl(with_solar_usd) if with_solar_usd is not None else None,
                  "cumulative_savings_usd": _rl(cum), "escalation_pct": _r(esc * 100, 3), "provenance": proj_provs}

    # ---- recommendations
    gp = None
    if req.utility == "pge_svce":
        gp = _greenprime(base.grid_kwh, sources)
    recs = recommendations(scen, upfront=upfront_by_scen, greenprime=gp, renter=not owns, utility=req.utility)
    recs = [{**r, "annual_usd_saved": _r(r["annual_usd_saved"]), "annual_kg_saved": _r(r["annual_kg_saved"], 1),
             "upfront_usd": None if r.get("upfront_usd") is None else _r(r["upfront_usd"], 0)} for r in recs]

    # ---- assumptions + warnings
    assumptions = []
    for key, rec in ctx.used.items():
        val = rec["value"]
        if isinstance(val, dict):
            sval = ", ".join(f"{k}: {v}" for k, v in val.items())
        elif isinstance(val, list):
            sval = ", ".join(f"{x:g}" if isinstance(x, (int, float)) else str(x) for x in val)
        else:
            sval = f"{val:g}" if isinstance(val, float) else str(val)
        if rec.get("unit"):
            sval = f"{sval} {rec['unit']}"
        assumptions.append({"key": key, "label": str(rec["label"]), "value": sval, "provenance": _prov(rec)})
    warnings = list(ctx.warnings)
    if ctx.defaulted:
        warnings.append("Built-in default values used (not in data/household/*.json): " + ", ".join(sorted(set(ctx.defaulted))) + ".")
    warnings.append("Weekday/weekend follow the 2024 calendar; holidays are ignored. Hours are local clock time.")

    return HouseholdResult(
        location=location, load_source=lm.source, load_label=lm.label, usage=usage, bill=bill, sources=sources, carbon=_clean(carbon),
        whatif=whatif, solar=solar, projection=projection, recommendations=recs, assumptions=assumptions, warnings=warnings,
        time_view=time_view(req, total, base,
            combined.flows.pv if combined.flows is not None else np.zeros(HOURS), cur_plan),
    )


def _prov(rec: dict) -> dict:
    kind = rec.get("kind", "assumption")
    if kind not in ("observed", "assumption", "simulated", "inferred"):
        kind = "assumption"
    return {"kind": kind, "source": str(rec.get("source") or "assumption"), "url": rec.get("url"), "note": rec.get("note")}


def _clean(d):
    if isinstance(d, dict):
        return {k: _clean(v) for k, v in d.items()}
    if isinstance(d, list):
        return [_clean(v) for v in d]
    if isinstance(d, float):
        return _finite(d)
    return d


def _greenprime(grid_kwh: float, sources: dict) -> dict | None:
    doc = load_json("svce.json")
    adder = doc.get("greenprime_adder_usd_per_kwh") if isinstance(doc, dict) else None
    gp = carbon_mod.find_pcl("pge_svce", product="greenprime")
    if adder is None or gp is None:
        return None
    ghg = float(gp.get("ghg_lb_per_mwh") or 0.0)
    base_ghg = float(sources.get("ghg_lb_per_mwh") or 0.0)
    kg_saved = grid_kwh * (base_ghg - ghg) / carbon_mod.LB_PER_KG / 1000.0
    return {"adder": float(adder), "cost": grid_kwh * float(adder), "ghg": ghg, "base_ghg": base_ghg, "kg_saved": kg_saved}


def _bonus_credit(eng: Engine, outcome: Outcome) -> float:
    if outcome.flows is None or not eng.acc_plus:
        return 0.0
    without = tar.compute_bill(outcome.plan, outcome.grid_import, outcome.flows.export, eng.export_h)
    return max(0, outcome.bill.export_credit_usd - without.export_credit_usd)


def solar_block(eng: Engine, total: np.ndarray, base: Outcome, ctx: Ctx, cal, existing_kw: float, existing_batt: float,
                new_kw: float, new_batt: float, owns: bool, esc: float, pv_cost: float, batt_cost: float, itc: float, prof) -> dict:
    deg = float(ctx.a("pv_degradation_pct_per_yr")) / 100.0
    disc = float(ctx.a("discount_rate_pct")) / 100.0
    life = int(float(ctx.a("pv_system_life_years")))
    notes = []
    if new_kw > 0 or new_batt > 0:
        if existing_kw <= 0 and new_kw <= 0:
            notes.append("A battery alone is not modelled without solar (no grid charging assumed).")
        before = base
        kw, batt = existing_kw + new_kw, existing_batt + new_batt
        after = eng.run(total, plan=eng.nbt_plan(), pv_kw=kw, battery_kwh=batt, new_solar=True)
        upfront = new_kw * pv_cost + new_batt * batt_cost
        if existing_kw > 0:
            notes.append(f"Includes your existing {existing_kw:g} kW; cost counts only the new equipment.")
        if eng.nbt_plan().id != base.plan.id:
            notes.append(f"Priced on {eng.nbt_plan().id}: new PG&E solar customers on the Net Billing Tariff take service on E-ELEC.")
        if eng.acc_plus:
            notes.append(f"Exports include the 2026 ACC Plus adder (${eng.acc_plus:.4f}/kWh), held for 9 years per NBT.")
    else:
        before = eng.run(total, pv_kw=0.0, battery_kwh=0.0)
        after = base
        kw, batt = existing_kw, existing_batt
        upfront = 0.0
        notes.append("Your existing system: cost treated as already paid (no payback). Exports valued at NBT export rates.")
    notes.append("CO2e saved counts only grid purchases avoided (exports are not credited as displaced emissions).")
    notes.append("Projection holds base export-credit values flat; the ACC Plus bonus ends after year 9. Retail savings escalate, and output degrades. Future export schedules are not loaded.")
    if not owns:
        notes.insert(0, "Not applicable for renters: consider community solar or your CCA's 100% renewable plan instead.")
    fl = after.flows
    pv = fl.pv if fl is not None else np.zeros(HOURS)
    incentives = upfront * itc
    savings = before.usd - after.usd
    payback = (upfront - incentives) / savings if savings > 0 and upfront > 0 else None
    yearly = savings_path(savings, after.bill.export_credit_usd,
                         _bonus_credit(eng, after) if new_kw > 0 or new_batt > 0 else 0, life, esc, deg)
    batt_life = max(1, int(float(ctx.a("battery_life_years"))))
    replacements = sum(new_batt * batt_cost / (1 + disc) ** (y + 1) for y in range(batt_life, life, batt_life))
    npv_usd = float(np.sum(yearly / (1 + disc) ** np.arange(1, life + 1)) - upfront + incentives - replacements)
    if new_batt > 0:
        notes.append(f"NPV includes same-cost replacement of the new battery after each {batt_life}-year service life; no replacement cost inflation.")
    provs = [
        {"kind": "simulated", "source": prof.source, "url": prof.url,
         "note": f"PVWatts v8 TMY for {prof.city}: fixed roof mount, 20 deg tilt, south, 14% losses (typical weather, not 2024)"},
        {"kind": "observed", "source": str(eng.export_info.get("source", "PG&E NBT export rates")), "url": eng.export_info.get("url"),
         "note": f"vintage {eng.export_info.get('vintage', 'n/a')}; credits offset energy charges within the year, no cash-out (assumed)"},
        _prov(ctx.used["pv_installed_usd_per_w"]), _prov(ctx.used["federal_residential_clean_energy_credit_pct"]),
        _prov(ctx.used["discount_rate_pct"]),
    ]
    if batt > 0:
        provs.append(_prov(ctx.used["battery_installed_usd_per_kwh"]))
        provs.append(_prov(ctx.used["battery_round_trip_efficiency"]))
    return {
        "kw": _r(kw, 2), "battery_kwh": _r(batt, 2), "annual_production_kwh": _r(pv.sum(), 1),
        "self_consumed_kwh": _r(fl.self_consumed_kwh if fl else 0.0, 1), "exported_kwh": _r(fl.export.sum() if fl else 0.0, 1),
        "battery_discharge_kwh": _r(fl.discharge.sum() if fl else 0.0, 1), "bill_before_usd": _r(before.usd),
        "bill_after_usd": _r(after.usd), "annual_savings_usd": _r(savings), "export_credit_usd": _r(after.bill.export_credit_usd),
        "upfront_cost_usd": _r(upfront, 0), "incentives_usd": _r(incentives, 0),
        "payback_years": None if payback is None else _r(payback, 1), "npv_usd": _r(npv_usd, 0),
        "monthly_production_kwh": _rl(np.bincount(cal.month_h, weights=pv, minlength=12), 1),
        "avg_day_production_kwh": _rl(load_mod.avg_day(pv), 4), "annual_kg_saved": _r(before.kg - after.kg, 1),
        "applicable": bool(owns), "note": " ".join(notes) or None, "provenance": provs,
    }
