"""Solar + battery sizing search for Griddy Home.  OWNER: household (backend).

Grid search over new rooftop solar (1.0 kW to the cap in 0.5 kW steps) and, optionally, a home battery
({0, 5, 10, 13.5, 15} kWh). Each candidate is scored with service.solar_block, the same 25-year NPV the Solar tab
reports, so applying the suggestion reproduces the same numbers there. The household load, tariff and baseline
bill are built once and reused for every candidate.

cap = min(roof capacity (request, else the household's roof_kw_max, else 12 kW), 15 kW,
          1.5 x annual use / annual kWh per kW here)  # under the Net Billing Tariff most extra output is exported
Every value it shows is an estimate from the stated assumptions, not a quote.
"""

from __future__ import annotations

import math

from app.household import load as load_mod
from app.household.data import Ctx, calendar, pv_profiles
from app.household.models import SolarOptimizeRequest, SolarOptimizeResult
from app.household.service import _prov, _r, choose_plan, locate, solar_block
from app.household.whatif import Engine

STEP_KW = 0.5
MIN_KW = 1.0
MAX_KW = 15.0
DEFAULT_ROOF_KW = 12.0
DEMAND_MULTIPLE = 1.5
BATTERY_SIZES_KWH = (0.0, 5.0, 10.0, 13.5, 15.0)


def _not_applicable(reason: str, provenance: list[dict] | None = None) -> SolarOptimizeResult:
    return SolarOptimizeResult(applicable=False, solar_kw=0, battery_kwh=0, upfront_cost_usd=0, annual_savings_usd=0,
                               payback_years=None, npv_usd=0, annual_production_kwh=0, offset_share=0, binding=[],
                               reason=reason, candidates=[], provenance=provenance or [])


def _money(x: float) -> str:
    return f"${x:,.0f}"


def optimize_solar(req: SolarOptimizeRequest) -> SolarOptimizeResult:
    hh = req.household
    if hh.owns_home is False:
        return _not_applicable("Rooftop solar usually needs the owner's approval, so there is no size to suggest for "
                               "renters: consider community solar or your CCA's 100% renewable plan instead.")
    ctx = Ctx()
    cal = calendar()
    _, slug = locate(hh, ctx)
    prof = pv_profiles().get(slug)
    if prof is None:
        return _not_applicable("Solar output profiles are not loaded, so solar sizes cannot be compared.")
    lm = load_mod.build_load(hh, ctx, slug)
    total = lm.total()
    cur_plan, plans, _ = choose_plan(hh, ctx, slug)
    eng = Engine(ctx, cur_plan, plans, prof.hourly_8784, hh.utility)

    # Existing equipment stays; the search sizes only what is added (as the Solar tab's what-if sliders do).
    existing_kw = float(hh.existing_solar_kw or ctx.a("existing_solar_kw_default")) if hh.has_solar else 0.0
    existing_batt = float(hh.existing_battery_kwh or ctx.a("existing_battery_kwh_default")) if hh.has_battery else 0.0
    base = eng.run(total, pv_kw=existing_kw, battery_kwh=existing_batt)

    w = hh.whatif
    esc = (w.rate_escalation_pct if w and w.rate_escalation_pct is not None else float(ctx.a("rate_escalation_pct_per_yr"))) / 100.0
    pv_cost = float(ctx.a("pv_installed_usd_per_w")) * 1000.0
    batt_cost = float(ctx.a("battery_installed_usd_per_kwh"))
    itc = float(ctx.a("federal_residential_clean_energy_credit_pct")) / 100.0

    annual_kwh = float(total.sum())
    kwh_per_kw = float(prof.hourly_8784.sum())
    roof_given = req.roof_kw_max if req.roof_kw_max is not None else hh.roof_kw_max
    roof_cap = (float(roof_given) if roof_given is not None else DEFAULT_ROOF_KW) - existing_kw
    demand_cap = DEMAND_MULTIPLE * annual_kwh / kwh_per_kw - existing_kw if kwh_per_kw > 0 else MAX_KW
    caps = {"roof": roof_cap, "limit": MAX_KW - existing_kw, "demand": demand_cap}
    cap = min(caps.values())
    cap_by = min(caps, key=caps.get)
    sizes = [MIN_KW + STEP_KW * i for i in range(int(math.floor((cap - MIN_KW) / STEP_KW + 1e-9)) + 1)] if cap >= MIN_KW else []

    provs = [
        {"kind": "simulated", "source": "Griddy solar sizing search (grid search, 25-year NPV from the Solar tab)",
         "note": f"New solar {MIN_KW:g} kW to {cap:.1f} kW in {STEP_KW:g} kW steps"
                 + (f" x battery {', '.join(f'{b:g}' for b in BATTERY_SIZES_KWH)} kWh" if req.include_battery else ", no battery")
                 + f"; cap = min(roof, {MAX_KW:g} kW, {DEMAND_MULTIPLE:g} x annual use / {kwh_per_kw:,.0f} kWh per kW here). "
                   "Tie on NPV goes to the lower upfront cost. Estimates, not installer quotes."},
        {"kind": "assumption",
         "source": "Your roof capacity" if roof_given is not None else f"Default roof capacity ({DEFAULT_ROOF_KW:g} kW): enter yours",
         "note": f"{roof_cap + existing_kw:g} kW roof" + (f", less your existing {existing_kw:g} kW" if existing_kw else "")},
    ]
    if req.budget_usd is not None:
        provs.append({"kind": "assumption", "source": "Your budget", "note": f"{_money(req.budget_usd)} upfront, compared after incentives"})
    if not sizes:
        why = (f"Your roof has room for {max(roof_cap, 0):.1f} kW of new solar, under the {MIN_KW:g} kW minimum this search tries."
               if cap_by == "roof" else f"At most {max(cap, 0):.1f} kW of new solar fits your demand and the {MAX_KW:g} kW limit, "
               f"under the {MIN_KW:g} kW minimum this search tries.")
        return _not_applicable(why, provs)

    batteries = BATTERY_SIZES_KWH if req.include_battery else (0.0,)
    rows = []
    for kw in sizes:
        for batt in batteries:
            blk = solar_block(eng, total, base, ctx, cal, existing_kw, existing_batt, kw, batt, True, esc, pv_cost, batt_cost, itc, prof)
            net = float(blk["upfront_cost_usd"]) - float(blk["incentives_usd"])
            feasible = req.budget_usd is None or net <= req.budget_usd + 1e-6
            rows.append((kw, batt, net, blk, feasible))

    def key(row):
        return (round(float(row[3]["npv_usd"])), -row[2])

    feasible = [r for r in rows if r[4]]
    over_budget = not feasible
    best = max(feasible, key=key) if feasible else min(rows, key=lambda r: (r[2], -float(r[3]["npv_usd"])))
    kw, batt, net, blk, _ = best
    npv = float(blk["npv_usd"])
    unconstrained = max(rows, key=key)

    binding = []
    on_cap = kw >= sizes[-1] - 1e-9
    if on_cap and cap_by == "roof":
        binding.append("roof")
    if req.budget_usd is not None and (over_budget or key(unconstrained) > key(best)):
        binding.append("budget")
    if on_cap and cap_by == "demand":
        binding.append("demand")

    batt_txt = f" with a {batt:g} kWh battery" if batt > 0 else ""
    size_txt = f"{kw:g} kW of solar{batt_txt}"
    if over_budget:
        reason = (f"Even the smallest option, {size_txt}, costs {_money(net)} upfront after incentives, above your "
                  f"{_money(req.budget_usd or 0)} budget.")
    elif npv <= 0:
        within = "Within your budget, no" if "budget" in binding else "No"
        reason = (f"{within} size pays back at these rates over {int(float(ctx.a('pv_system_life_years')))} years; the "
                  f"smallest loss is {size_txt} (25-year NPV {_money(npv)}).")
    else:
        limits = {"roof": "your roof space", "budget": "your budget", "demand": f"your use (past {DEMAND_MULTIPLE:g}x your yearly use, most output is exported for low Net Billing credits)"}
        lim = " and ".join(limits[b] for b in binding)
        reason = (f"{size_txt[0].upper()}{size_txt[1:]} has the best 25-year value: {_money(npv)} NPV, about "
                  f"{_money(float(blk['annual_savings_usd']))} saved a year" +
                  (f", paying back in {float(blk['payback_years']):.1f} years" if blk["payback_years"] is not None else "") +
                  (f"; limited by {lim}." if lim else "."))
    if existing_kw > 0:
        reason += f" Sizes are in addition to your existing {existing_kw:g} kW; production and offset include it."

    provs.extend(p for p in blk["provenance"] if p not in provs)
    provs.append(_prov(ctx.used["pv_system_life_years"]))
    provs.append(_prov(ctx.used["rate_escalation_pct_per_yr"]) if "rate_escalation_pct_per_yr" in ctx.used else
                 {"kind": "assumption", "source": "Electricity price escalation (your what-if)", "note": f"{esc * 100:g}%/yr"})

    production = float(blk["annual_production_kwh"])
    return SolarOptimizeResult(
        applicable=True, solar_kw=_r(kw, 2), battery_kwh=_r(batt, 2), upfront_cost_usd=_r(net, 0),
        annual_savings_usd=_r(blk["annual_savings_usd"]), payback_years=blk["payback_years"], npv_usd=_r(npv, 0),
        annual_production_kwh=_r(production, 1), offset_share=_r(production / annual_kwh if annual_kwh > 0 else 0.0, 4),
        binding=binding, reason=reason,
        candidates=[{"solar_kw": _r(k, 2), "battery_kwh": _r(b, 2), "upfront_cost_usd": _r(n, 0), "npv_usd": _r(bk["npv_usd"], 0),
                     "payback_years": bk["payback_years"], "feasible": f} for k, b, n, bk, f in rows],
        provenance=provs,
    )
