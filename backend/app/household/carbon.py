"""Household carbon: CAISO 2024 hourly average intensity (primary) and provider Power Content Label (annual).
OWNER: household (backend).

Hourly method: kg = sum_h grid_kWh_h x grid_co2_kg_per_mwh_h / 1000. This is the CAISO AVERAGE intensity of the
regional supply mix (not marginal emissions); neither it nor the provider's annual label identifies the plant
physically supplying a home.
"""

from __future__ import annotations

import logging
from functools import lru_cache

import numpy as np

from app.household.data import HOURS, Ctx, caiso, calendar, load_json, meta, norm_key, num

log = logging.getLogger(__name__)

LB_PER_KG = 2.20462
CAISO_SOURCE = "CAISO 2024 hourly fuel mix (data/simulate/caiso_2024_hourly.csv, workstream B)"
CAISO_URL = "https://www.caiso.com/todays-outlook/supply"

# utility -> which Power Content Label product to show
PROVIDER_PRODUCT = {"pge": ("PG&E", "Base Plan"), "pge_svce": ("SVCE", "GreenStart")}


@lru_cache(maxsize=1)
def intensity_kg_per_kwh() -> tuple[np.ndarray, bool]:
    """(8784 kg CO2/kWh, observed?) from CAISO 2024; a flat CA average if B's file is unreadable."""
    c = caiso()
    if c is None:
        return np.full(HOURS, 0.22), False
    return c["grid_co2_kg_per_mwh"] / 1000.0, True


def hourly_kg(grid_kwh: np.ndarray) -> float:
    return float(np.dot(grid_kwh, intensity_kg_per_kwh()[0]))


def avg_day_by_local_hour(arr: np.ndarray) -> np.ndarray:
    cal = calendar()
    return np.bincount(cal.local_hod, weights=arr, minlength=24) / np.bincount(cal.local_hod, minlength=24)


# ---------------------------------------------------------------------------
# Power Content Labels
# ---------------------------------------------------------------------------


def _pcl_entries() -> list[dict]:
    doc = load_json("power_content_labels.json")
    if not isinstance(doc, dict):
        return []
    out = []
    containers = [doc.get("products"), doc.get("labels"), doc.get("entries"), doc.get("providers"), doc]
    for c in containers:
        if isinstance(c, dict):
            for k, v in c.items():
                if k.startswith("_") or not isinstance(v, dict):
                    continue
                if "mix_pct" in v or any(x in v for x in ("ghg_lb_per_mwh", "ghg_lb_co2e_per_mwh", "ghg_intensity_lb_co2e_per_mwh")):
                    out.append({"_key": k, **v})
        elif isinstance(c, list):
            out.extend(v for v in c if isinstance(v, dict))
        if out:
            break
    return out


def _ghg(e: dict) -> float | None:
    for k in ("ghg_lb_per_mwh", "ghg_lb_co2e_per_mwh", "ghg_intensity_lb_co2e_per_mwh", "ghg_intensity_lb_per_mwh", "ghg_intensity"):
        if k in e and num(e[k]) is not None:
            return float(num(e[k]))
    return None


PCL_KEYS = {"pge": "pge_base", "pge_svce": "svce_greenstart", "greenprime": "svce_greenprime"}


def find_pcl(utility: str, product: str | None = None) -> dict | None:
    doc = load_json("power_content_labels.json")
    labels = doc.get("labels") if isinstance(doc, dict) else None
    if isinstance(labels, dict):
        key = PCL_KEYS.get(product or utility, "ca_utility_average")
        if isinstance(labels.get(key), dict):
            return {"_key": key, **labels[key]}
    want_org, want_prod = PROVIDER_PRODUCT.get(utility, ("California", "power mix"))
    if product:
        want_prod = product
    entries = _pcl_entries()
    tokens = [norm_key(want_org), norm_key(want_prod)]
    best, best_score = None, 0
    for e in entries:
        hay = norm_key(" ".join(str(e.get(k, "")) for k in ("_key", "id", "label", "name", "provider", "product", "utility")))
        score = sum(1 for t in tokens if t and t in hay)
        if utility not in PROVIDER_PRODUCT and not product and ("california" in hay or "ca_mix" in hay or "statewide" in hay):
            score = 2
        if score > best_score:
            best, best_score = e, score
    return best if best_score >= (2 if utility in PROVIDER_PRODUCT or product else 1) else None


def pcl_meta() -> dict:
    return meta(load_json("power_content_labels.json"))


# ---------------------------------------------------------------------------
# Result blocks
# ---------------------------------------------------------------------------


def caiso_prov() -> dict:
    return {"kind": "observed", "source": CAISO_SOURCE, "url": CAISO_URL,
            "note": "Average (not marginal) intensity of CAISO supply incl. imports; CO2 inferred from fuel emission factors."}


def sources_block(utility: str, ctx: Ctx) -> dict:
    cal = calendar()
    c = caiso()
    mix: dict[str, list[float]] = {}
    clean = [0.0] * 24
    if c is not None:
        for k, v in c.items():
            if k.endswith("_mw"):
                mix[k[:-3]] = [round(float(x), 1) for x in avg_day_by_local_hour(np.clip(v, 0, None))]
        clean = [round(float(x), 4) for x in avg_day_by_local_hour(c["grid_cfe_share"])]
    else:
        ctx.warn("CAISO 2024 hourly file not readable: hourly grid mix and carbon use a flat 0.22 kg/kWh placeholder.")
    e = find_pcl(utility)
    provs = [caiso_prov()]
    pm = pcl_meta()
    if e is None:
        e = find_pcl("other")
        if utility in PROVIDER_PRODUCT:
            ctx.warn("Power Content Label for your provider not found in data/household/power_content_labels.json; "
                     "showing the California power mix instead.")
    if e is None:
        ctx.warn("Power Content Label data (data/household/power_content_labels.json) not loaded: provider mix unavailable.")
        provider, year, mix_pct, ghg = "Not loaded", 0, {}, 0.0
    else:
        provider = str(e.get("label") or e.get("name") or e.get("_key"))
        year = int(num(e.get("year"), num(pm.get("year"), 0)) or 0)
        mix_pct = {str(k): float(num(v, 0.0) or 0.0) for k, v in (e.get("mix_pct") or {}).items()}
        ghg = _ghg(e) or 0.0
        provs.append({"kind": "observed", "source": str(e.get("source") or pm.get("source") or "CEC Power Content Label"),
                      "url": e.get("url") or pm.get("url"), "note": f"{provider} {year} annual mix (retail sales claims)"})
    note = ("Your provider's Power Content Label is an annual accounting of what it bought; the CAISO hourly mix is the "
            "regional grid at each hour. Neither identifies the plant that physically supplies your home. Hours are local clock time.")
    return {"provider": provider, "label_year": year, "mix_pct": mix_pct, "ghg_lb_per_mwh": float(ghg),
            "caiso_avg_day_mix_mw": mix, "caiso_avg_day_clean_share": clean, "note": note, "provenance": provs}


def carbon_block(grid_kwh: np.ndarray, sources: dict, ctx: Ctx, ca_avg_kg: float) -> dict:
    cal = calendar()
    inten, observed = intensity_kg_per_kwh()
    kg_h = grid_kwh * inten
    annual = float(kg_h.sum())
    ghg_lb = sources.get("ghg_lb_per_mwh") or 0.0
    annual_kwh = float(grid_kwh.sum())
    if ghg_lb > 0 or sources.get("provider") not in (None, "Not loaded"):
        provider_kg = annual_kwh * ghg_lb / LB_PER_KG / 1000.0
    else:
        provider_kg = annual
        ctx.warn("Provider-method carbon uses the CAISO hourly result because no Power Content Label intensity is loaded.")
    day = avg_day_by_local_hour(inten)
    order = np.argsort(day)
    kg_mile = float(ctx.a("epa_kg_co2e_per_car_mile"))
    kg_tree = float(ctx.a("epa_kg_co2_per_tree_seedling_10yr"))
    provs = [caiso_prov(),
             {"kind": "observed", "source": "US EPA Greenhouse Gas Equivalencies Calculator",
              "url": "https://www.epa.gov/energy/greenhouse-gas-equivalencies-calculator", "note": "car miles and tree seedlings"}]
    if sources.get("provenance") and len(sources["provenance"]) > 1:
        provs.append(sources["provenance"][1])
    if not observed:
        provs[0] = {"kind": "assumption", "source": "flat 0.22 kg/kWh placeholder (CAISO file unreadable)"}
    return {
        "annual_kg_hourly": round(annual, 1),
        "annual_kg_provider": round(float(provider_kg), 1),
        "monthly_kg": [round(float(x), 2) for x in np.bincount(cal.month_h, weights=kg_h, minlength=12)],
        "avg_day_intensity_kg_per_kwh": [round(float(x), 5) for x in day],
        "equivalents": {"car_miles": round(annual / kg_mile, 0) if kg_mile > 0 else 0.0,
                        "tree_seedlings_10yr": round(annual / kg_tree, 1) if kg_tree > 0 else 0.0,
                        "share_of_ca_avg_household": round(annual / ca_avg_kg, 3) if ca_avg_kg > 0 else 0.0},
        "cleanest_hours": sorted(int(h) for h in order[:4]),
        "dirtiest_hours": sorted(int(h) for h in order[-4:]),
        "provenance": provs,
    }
