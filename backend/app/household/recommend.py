"""Personalised recommendations from the what-if scenarios (plus provider green-power options).
OWNER: household (backend). Each card carries $ and kg CO2e so cost-vs-carbon trade-offs stay visible.
"""

from __future__ import annotations

EFFORT = {"ev_midnight": "easy", "ev_midnight_best_plan": "easy", "ev_midday": "moderate", "laundry_offpeak": "easy", "dishwasher_offpeak": "easy",
          "ac_plus_2f": "easy", "cheapest_plan": "easy", "solar_5kw": "investment", "solar_battery": "investment"}


def _tradeoff(usd: float, kg: float) -> str:
    if usd > 1 and kg < -1:
        return " Trade-off: cheaper, but a bit more CO2e because those hours lean on gas-fired and imported power."
    if usd < -1 and kg > 1:
        return " Trade-off: cleaner, but costs a little more on your current rates."
    return ""


def recommendations(scen: list[dict], *, upfront: dict[str, float], greenprime: dict | None, renter: bool,
                    utility: str) -> list[dict]:
    recs: list[dict] = []
    for s in scen:
        if not s["applicable"]:
            continue
        usd, kg = s["annual_usd_saved"], s["annual_kg_saved"]
        if usd <= 1 and kg <= 1:
            continue
        if s["id"] == "cheapest_plan" and usd <= 1:
            continue
        recs.append({
            "id": s["id"], "title": s["label"],
            "detail": f"{s['detail']} Saves about ${usd:,.0f}/yr and {kg:,.0f} kg CO2e/yr (estimate).{_tradeoff(usd, kg)}",
            "annual_usd_saved": usd, "annual_kg_saved": kg, "effort": EFFORT.get(s["id"], "moderate"),
            "upfront_usd": upfront.get(s["id"]),
        })
    if greenprime:
        recs.append({
            "id": "svce_greenprime", "title": "Opt up to SVCE GreenPrime (100% renewable)",
            "detail": (f"GreenPrime adds ${greenprime['adder']:.4f}/kWh (~${greenprime['cost']:,.0f}/yr for your use) and its Power "
                       f"Content Label reports {greenprime['ghg']:g} lb CO2e/MWh vs GreenStart's {greenprime['base_ghg']:g}. "
                       "This is an annual accounting claim (provider method); the physical CAISO grid at each hour does not change."),
            "annual_usd_saved": -greenprime["cost"], "annual_kg_saved": greenprime["kg_saved"], "effort": "easy", "upfront_usd": 0.0,
        })
    if renter:
        recs.append({
            "id": "renter_green_power",
            "title": "Renting? Look at community solar or a green-power plan",
            "detail": ("Rooftop solar usually needs the owner's consent. "
                       + ("SVCE GreenPrime is a one-click 100% renewable option." if utility == "pge_svce" else
                          "Check your CCA's 100% renewable option or PG&E's community solar programs; prices vary, not estimated here.")),
            "annual_usd_saved": 0.0, "annual_kg_saved": 0.0, "effort": "easy", "upfront_usd": None,
        })
    recs.sort(key=lambda r: (-(r["annual_usd_saved"] > 1), -r["annual_usd_saved"], -r["annual_kg_saved"]))
    return recs
