"""What-if engine: evaluate a household configuration ($, grid kWh, kg CO2e) and the auto-generated scenarios.
OWNER: household (backend).

Every scenario is compared with the household's current behaviour (same load model, plan and existing system).
Pure timing shifts (EV / laundry / dishwasher) move a component within each day, a permutation that preserves total
kWh exactly; setpoint and equipment changes use the stated assumptions.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from app.household.carbon import hourly_kg, intensity_kg_per_kwh
from app.household.data import HOURS, Ctx
from app.household.load import LoadModel, shift
from app.household.solar import Flows, dispatch
from app.household.tariffs import BillResult, Plan, compute_bill, export_rates


@dataclass
class Outcome:
    usd: float
    grid_kwh: float
    kg: float
    consumption_kwh: float
    bill: BillResult
    plan: Plan
    flows: Flows | None
    grid_import: np.ndarray


class Engine:
    def __init__(self, ctx: Ctx, plan: Plan, plans: dict[str, Plan], pv_unit: np.ndarray | None, utility: str):
        self.ctx = ctx
        self.plan = plan
        self.plans = plans
        self.pv_unit = pv_unit
        self.utility = utility
        self.rte = float(ctx.a("battery_round_trip_efficiency"))
        self.kw_per_kwh = float(ctx.a("battery_kw_per_kwh"))
        rates, info = export_rates()
        self.export_info = info
        if rates is None:
            flat = float(ctx.a("nbt_flat_export_usd_per_kwh"))
            rates = np.full(HOURS, flat)
            self.export_info = {"source": "flat export credit (NBT export rate file not loaded)", "mean": flat}
        self.export_h = rates
        acc = (info or {}).get("acc_plus") or {}
        adder = 0.0
        try:
            adder = float(acc["value_by_application_year"]["residential"]["2026"])
        except (KeyError, TypeError, ValueError):
            adder = 0.0
        self.acc_plus = adder

    def nbt_plan(self, plan: Plan | None = None) -> Plan:
        """New PG&E solar customers take service on E-ELEC under the Net Billing Tariff."""
        plan = plan or self.plan
        if plan.id == "custom":
            return plan
        return self.plans.get("E-ELEC", plan)

    def run(self, load: np.ndarray, plan: Plan | None = None, pv_kw: float = 0.0, battery_kwh: float = 0.0,
            new_solar: bool = False) -> Outcome:
        plan = plan or self.plan
        consumption = float(load.sum())
        if pv_kw <= 0 or self.pv_unit is None:
            b = compute_bill(plan, load)
            return Outcome(b.annual_usd, consumption, hourly_kg(load), consumption, b, plan, None, load)
        pv = self.pv_unit * pv_kw
        mask = plan.high_mask()
        fl = dispatch(load, pv, battery_kwh, battery_kwh * self.kw_per_kwh, self.rte, mask if mask.any() else None)
        rate = self.export_h + (self.acc_plus if new_solar else 0.0)
        b = compute_bill(plan, fl.grid_import, fl.export, rate)
        return Outcome(b.annual_usd, float(fl.grid_import.sum()), hourly_kg(fl.grid_import), consumption, b, plan, fl, fl.grid_import)


# ---------------------------------------------------------------------------
# Load edits
# ---------------------------------------------------------------------------


def edited_load(lm: LoadModel, ctx: Ctx, ev_start: int | None = None, laundry_hour: int | None = None,
                dishwasher_hour: int | None = None, ac_delta_f: float | None = None) -> tuple[np.ndarray, bool]:
    """(total hourly load, preserves_total) after applying the edits to a copy of the household load."""
    comps = dict(lm.components)
    timing_only = True
    if ev_start is not None and "ev" in comps and lm.ev_start is not None:
        comps["ev"] = shift(comps["ev"], ev_start - lm.ev_start)
    if laundry_hour is not None and "laundry" in comps:
        comps["laundry"] = shift(comps["laundry"], laundry_hour - lm.laundry_hour)
    if dishwasher_hour is not None and "dishwasher" in comps:
        comps["dishwasher"] = shift(comps["dishwasher"], dishwasher_hour - lm.dishwasher_hour)
    if ac_delta_f and "cooling" in comps:
        pct = float(ctx.a("cooling_pct_change_per_degF")) / 100.0
        comps["cooling"] = comps["cooling"] * max(0.0, 1.0 - pct * ac_delta_f)
        timing_only = False
    return np.sum(list(comps.values()), axis=0), timing_only


def best_start(component: np.ndarray, current: int, candidates: list[int], plan: Plan, prefer: str = "cost") -> int:
    """Start hour (local clock) that minimises cost then carbon (or carbon then cost) for a shifted component."""
    rate_h = plan.tables()[0]
    inten = intensity_kg_per_kwh()[0]
    best, best_key = current, None
    for h in candidates:
        arr = shift(component, h - current)
        usd, kg = float(arr @ rate_h), float(arr @ inten)
        key = (round(usd, 0), kg) if prefer == "cost" else (round(kg, 0), usd)
        if best_key is None or key < best_key:
            best, best_key = h, key
    return best


def _hh(h: int) -> str:
    h %= 24
    return f"{(h % 12) or 12} {'a.m.' if h < 12 else 'p.m.'}"


# ---------------------------------------------------------------------------
# Scenarios
# ---------------------------------------------------------------------------


def scenarios(eng: Engine, lm: LoadModel, base: Outcome, ctx: Ctx, req, existing_kw: float, existing_batt: float,
              plan_rows: list[dict], solar_ok: bool, solar_note: str | None) -> list[dict]:
    out: list[dict] = []
    base_total = lm.total()
    plan = eng.plan

    def add(sid: str, label: str, detail: str, res: Outcome, preserves: bool, assumption: str, applicable: bool = True):
        out.append({
            "id": sid, "label": label, "detail": detail, "annual_usd_saved": base.usd - res.usd,
            "annual_kwh_change": res.grid_kwh - base.grid_kwh, "annual_kg_saved": base.kg - res.kg,
            "preserves_total_kwh": bool(preserves), "assumption": assumption, "applicable": bool(applicable),
        })

    def run_load(total: np.ndarray, **kw) -> Outcome:
        return eng.run(total, plan=kw.get("plan"), pv_kw=kw.get("pv_kw", existing_kw), battery_kwh=kw.get("battery_kwh", existing_batt),
                       new_solar=kw.get("new_solar", False))

    def check_preserved(total: np.ndarray) -> bool:
        return abs(float(total.sum()) - float(base_total.sum())) <= 1e-6 * max(1.0, float(base_total.sum()))

    if "ev" in lm.components and lm.ev_start is not None:
        t, _ = edited_load(lm, ctx, ev_start=0)
        add("ev_midnight", "Charge the EV starting at midnight",
            f"Move EV charging from {_hh(lm.ev_start)} to 12 a.m. (off-peak on every PG&E plan). Late-night grid power is "
            "usually gas-heavier than midday solar hours, so the carbon change can be small or negative.",
            run_load(t), check_preserved(t), "Same daily EV kWh, charger power and days; only the start time changes.")
        mid = best_start(lm.components["ev"], lm.ev_start, [9, 10, 11, 12, 13], plan, prefer="carbon")
        t, _ = edited_load(lm, ctx, ev_start=mid)
        home = bool(req.home_daytime)
        add("ev_midday", f"Charge the EV midday (from {_hh(mid)})",
            "Midday is when the CAISO grid is cleanest (solar). Only works if the car is parked at home during the day"
            + ("." if home else "; you said you are usually away, so this assumes workplace or daytime charging instead."),
            run_load(t), check_preserved(t), "Same daily EV kWh; start time moved to the cleanest midday hour.", applicable=home)

        # Shift + plan together: EV2-A only pays off once charging moves out of the evening peak.
        t0, _ = edited_load(lm, ctx, ev_start=0)
        elig = [r for r in plan_rows if r["eligible"]]
        if len(elig) > 1:
            runs = {r["plan"]: run_load(t0, plan=eng.plans[r["plan"]]) for r in elig}
            best_pid = min(runs, key=lambda k: runs[k].usd)
            if best_pid != plan.id:
                add("ev_midnight_best_plan", f"Charge the EV at midnight on {best_pid}",
                    f"Move EV charging to 12 a.m. and switch to {best_pid}, the cheapest eligible plan for the shifted load.",
                    runs[best_pid], check_preserved(t0), "Same daily EV kWh; start time and rate plan change.")

    if "laundry" in lm.components:
        h = best_start(lm.components["laundry"], lm.laundry_hour, list(range(7, 22)), plan)
        t, _ = edited_load(lm, ctx, laundry_hour=h)
        add("laundry_offpeak", f"Run laundry at {_hh(h)}",
            f"Move washer + dryer from {_hh(lm.laundry_hour)} to {_hh(h)}, the cheapest-then-cleanest start on your plan.",
            run_load(t), check_preserved(t), "Same loads per week and kWh per load; only the time of day changes.")
    if "dishwasher" in lm.components:
        h = best_start(lm.components["dishwasher"], lm.dishwasher_hour, list(range(24)), plan)
        t, _ = edited_load(lm, ctx, dishwasher_hour=h)
        add("dishwasher_offpeak", f"Delay-start the dishwasher to {_hh(h)}",
            f"Use the delay-start button: {_hh(lm.dishwasher_hour)} -> {_hh(h)} (cheapest, then cleanest hour on your plan).",
            run_load(t), check_preserved(t), "Same cycles per week and kWh per cycle; only the time of day changes.")
    if "cooling" in lm.components:
        t, _ = edited_load(lm, ctx, ac_delta_f=2.0)
        pct = float(ctx.a("cooling_pct_change_per_degF"))
        add("ac_plus_2f", "Set the AC 2 F warmer", f"Cooling energy drops ~{2 * pct:.0f}% ({pct:g}% per F, stated assumption).",
            run_load(t), False, f"Cooling kWh x (1 - {pct:g}% x 2 F).")

    elig_rows = [r for r in plan_rows if r["eligible"]]
    if len(plan_rows) > 1 and elig_rows:
        best = min(elig_rows, key=lambda r: r["annual_usd"])
        res = run_load(base_total, plan=eng.plans[best["plan"]])
        same = best["plan"] == plan.id
        add("cheapest_plan", "Already on your cheapest eligible plan" if same else f"Switch to {best['plan']}",
            "Same usage priced on every PG&E residential plan you qualify for."
            + ("" if same else f" {best['label']} is cheapest for your load shape."),
            res, True, "Same hourly load on each plan's published rates.")

    pv_ok = eng.pv_unit is not None
    note = solar_note or ("" if pv_ok else "Solar profiles not loaded.")
    if req.roof_kw_max is not None and req.roof_kw_max < 5 and existing_kw <= 0:
        solar_ok = False
        note += " The 5 kW recommendation exceeds your entered roof capacity; size a smaller system in the Solar tab."
    if existing_kw <= 0:
        res = eng.run(base_total, plan=eng.nbt_plan(), pv_kw=5.0, battery_kwh=existing_batt, new_solar=True)
        add("solar_5kw", "Add 5 kW of rooftop solar",
            "PVWatts output for your area; self-used solar offsets retail kWh and exports earn PG&E Net Billing export credits "
            "(modelled on E-ELEC, the plan NBT customers take)." + (f" {note}" if note else ""),
            res, False, "5 kW_DC fixed roof, 20 deg tilt, south, 14% losses; NBT export rates (2026 vintage).", applicable=solar_ok and pv_ok)
    kw = existing_kw if existing_kw > 0 else 5.0
    res = eng.run(base_total, plan=eng.nbt_plan(), pv_kw=kw, battery_kwh=existing_batt + 10.0, new_solar=True)
    lbl = "Add a 10 kWh battery" if existing_kw > 0 else "Add 5 kW solar + 10 kWh battery"
    add("solar_battery", lbl,
        "Battery charges only from solar surplus and powers the home in peak hours (no grid charging or battery export)."
        + (f" {note}" if note else ""),
        res, False, f"Round-trip efficiency {eng.rte:.0%}; {eng.kw_per_kwh:g} kW per kWh.", applicable=solar_ok and pv_ok)
    return out
