"""Technology cost + performance catalog.  OWNER: workstream C (Evaluate).

Built from the committed, cited JSON in data/evaluate/ (see data/evaluate/README.md):
  atb_2025_catalog.json  NLR ATB 2025 v1.0.0 rows (2023 USD), Moderate, 2027 COD, no tax credits
                         (regenerate: cd backend && .venv/bin/python -m app.evaluate.prep_atb)
  ref_costs.json         CPI-U deflators, interconnection unit costs, land use, gas prices
  ref_emissions.json     emission factors, GHG metrics, allowance price
  bom_basis.json         equipment unit sizes for the bill of materials

Every catalog dollar is real 2024 USD: ATB 2023$ x CPI-U 2023->2024, PTO cost-guide 2025$ x
CPI-U 2025->2024. ATB CAPEX is used net of ATB's generic grid-connection cost (GCC), because
Griddy costs each site's interconnection explicitly (line km + substation).
"""

from __future__ import annotations

import json
import math
from functools import lru_cache
from typing import Any

from app import DATA_DIR
from app.contract import Asset, AssetKind, Catalog, Provenance, TechSpec, TransmissionSpec

_DIR = DATA_DIR / "evaluate"
KINDS: tuple[AssetKind, ...] = ("solar_pv", "onshore_wind", "gas_cc", "gas_ct", "battery", "nuclear", "nuclear_smr")
GAS_KINDS: tuple[AssetKind, ...] = ("gas_cc", "gas_ct")
NUCLEAR_KINDS: tuple[AssetKind, ...] = ("nuclear", "nuclear_smr")
COD_YEAR = 2027
DOLLAR_YEAR = 2024
BATTERY_REF_HOURS = 4.0  # ATB's reference configuration and the default when duration_h is unset
LB_TO_KG = 0.45359237


@lru_cache(maxsize=None)
def _load(name: str) -> dict[str, Any]:
    return json.loads((_DIR / name).read_text(encoding="utf-8"))


def nuclear_data() -> dict[str, Any]:
    """nuclear_2025.json: cited ATB 2025 nuclear values, kept apart from the generated ATB file (cached: read-only)."""
    return _load("nuclear_2025.json")


@lru_cache(maxsize=None)
def atb_data() -> dict[str, Any]:
    """atb_2025_catalog.json (from prep_atb.py) plus the nuclear techs from nuclear_2025.json (cached: treat as read-only)."""
    base = _load("atb_2025_catalog.json")
    return {**base, "techs": {**base["techs"], **nuclear_data()["techs"]}}


# Per-kind constants the simulation needs (stress.py, resilience.py), cited in nuclear_2025.json.
NUCLEAR_EFOR: dict[str, float] = {k: float(nuclear_data()["techs"][k]["efor"]["value"]) for k in NUCLEAR_KINDS}
NUCLEAR_UNIT_MW: dict[str, float] = {k: float(nuclear_data()["techs"][k]["unit_mw"]["value"]) for k in NUCLEAR_KINDS}


def nuclear_fuel_usd_per_mwh(kind: str) -> float:
    """ATB nuclear fuel cost in 2024$/MWh (ATB's 'Fuel' parameter x the CPI-U deflator)."""
    return float(nuclear_data()["techs"][kind]["parameters"]["Fuel"]["value"]) * ref_value("deflator_2023_to_2024")


def bom_basis() -> dict[str, Any]:
    """bom_basis.json (cached: treat as read-only)."""
    return _load("bom_basis.json")


def reference_files() -> dict[str, dict[str, Any]]:
    """The three cited reference files, keyed by stem (cached: treat as read-only)."""
    return {name: _load(f"{name}.json") for name in ("ref_emissions", "ref_costs", "bom_basis")}


def ref(key: str) -> dict[str, Any]:
    """One cited entry from ref_emissions.json or ref_costs.json."""
    for name in ("ref_emissions.json", "ref_costs.json"):
        d = _load(name)
        if key in d and key != "_meta":
            return d[key]
    if key in (nuclear_refs := nuclear_data().get("refs", {})):
        return nuclear_refs[key]
    raise KeyError(f"no reference value {key!r} in data/evaluate/ref_*.json")


def ref_value(key: str) -> Any:
    """`value` of a reference entry: a float, or a list of floats for monthly series."""
    v = ref(key)["value"]
    return [float(x) for x in v] if isinstance(v, list) else float(v)


def asset_params(asset: Asset, catalog: Catalog) -> dict[str, Any]:
    """Catalog TechSpec fields for an asset with its per-asset overrides on top."""
    p = catalog.spec(asset.kind).model_dump() | {k: float(v) for k, v in asset.overrides.items()}
    p["lifetime_years"] = max(1, int(round(p["lifetime_years"])))
    return p


# ---------------------------------------------------------------------------
# Technologies
# ---------------------------------------------------------------------------


def _num(x: float) -> str:
    return f"{x:,.4f}".rstrip("0").rstrip(".") if abs(x) < 10 else f"{x:,.2f}"


def _cap(s: str) -> str:
    return s[:1].upper() + s[1:]


def _atb_value(t: dict[str, Any], name: str) -> float | None:
    p = t["parameters"].get(name)
    return None if p is None else float(p["value"])


def battery_fom_split() -> tuple[float, float]:
    """Battery fixed O&M in 2024$: ($/kW-yr power part, $/kWh-yr energy part), from ATB's exact split."""
    d = ref_value("deflator_2023_to_2024")
    der = atb_data()["techs"]["battery"]["derived"]
    return der["fixed_om_power_usd_per_kw_yr"] * d, der["fixed_om_energy_usd_per_kwh_yr"] * d


def _provenance(kind: AssetKind, spec: dict[str, Any]) -> Provenance:
    atb = atb_data()
    t = atb["techs"][kind]
    sel = t["atb"]
    d = ref_value("deflator_2023_to_2024")
    der = t["derived"]
    params = "; ".join(
        f"{name} {_num(float(p['value']))} {p.get('units') or ''}".strip() for name, p in t["parameters"].items() if name != "LCOE"
    )
    parts = [
        f"ATB {sel['technology']} '{sel['techdetail']}' ({sel['techdetail2']}), scenario {sel['scenario']}, case {sel['core_metric_case']}, "
        f"COD {sel['cod_year']}, crpyears {sel['crpyears']}, no tax credits, {atb['source']['dollar_year']} USD: {params}.",
        f"CAPEX used = {der['formula']} = {_num(der['capex_ex_gcc_usd_per_kw'])} $/kW: ATB's generic grid-connection cost (GCC) and its "
        "share of construction finance are removed because Griddy costs the site's line and substation explicitly "
        "(avoids double counting).",
    ]
    if kind == "battery":
        fk, fe = battery_fom_split()
        parts.append(
            f"Battery CAPEX split by least squares over 2/4/6/8/10 h ({der['fit_formula']}, R^2 {der['fit_r2']:.4f}): "
            f"{_num(der['power_usd_per_kw'])} $/kW + {_num(der['energy_usd_per_kwh'])} $/kWh (2023$) -> "
            f"{_num(spec['capex_usd_per_kw'])} $/kW + {_num(spec['capex_usd_per_kwh'])} $/kWh (2024$). Fixed O&M split "
            f"{_num(der['fixed_om_power_usd_per_kw_yr'])} $/kW-yr + {_num(der['fixed_om_energy_usd_per_kwh_yr'])} $/kWh-yr "
            f"(R^2 {der['fixed_om_fit_r2']:.4f}) -> {_num(fk)} $/kW-yr + {_num(fe)} $/kWh-yr in 2024$; "
            f"{_num(spec['fixed_om_usd_per_kw_yr'])} $/kW-yr shown is the 4 h equivalent.",
        )
    parts.append(
        f"All dollars x CPI-U 2023->2024 deflator {d} (BLS CUUR0000SA0 annual averages) = 2024 USD: CAPEX "
        f"{_num(spec['capex_usd_per_kw'])} $/kW, fixed O&M {_num(spec['fixed_om_usd_per_kw_yr'])} $/kW-yr, variable O&M "
        f"{_num(spec['var_om_usd_per_mwh'])} $/MWh.",
    )
    if spec.get("heat_rate_mmbtu_per_mwh"):
        co2 = ref("co2_kg_per_mmbtu_natural_gas")
        parts.append(
            f"Heat rate {_num(spec['heat_rate_mmbtu_per_mwh'])} MMBtu/MWh (ATB, full load). CO2 {co2['value']} kg/MMBtu: {co2['source']}."
        )
    if kind in NUCLEAR_KINDS:
        n = t
        parts.append(
            f"ATB capacity factor {spec['typical_capacity_factor']}: the simulation runs the plant at this share of nameplate every "
            f"hour (must-run baseload). Fuel {_num(float(n['parameters']['Fuel']['value']))} $/MWh (ATB, 2023$). Forced-outage rate "
            f"{n['efor']['value']}: {n['efor']['source']} ({n['efor']['url']}). Unit size for N-1 {n['unit_mw']['value']:g} MW: "
            f"{n['unit_mw']['source']} ({n['unit_mw']['url']}). Direct CO2 and NOx: none (no combustion)."
        )
    elif spec.get("typical_capacity_factor"):
        parts.append(f"ATB reference CF {spec['typical_capacity_factor']} (display only; the simulation uses hourly weather).")
    if spec.get("round_trip_efficiency"):
        parts.append(f"Round-trip efficiency {spec['round_trip_efficiency']} (ATB 2025 battery page; Cole et al. 2025).")
    if rationale := t.get("class_rationale"):
        parts.append(f"Class choice: {rationale}")
    if data_note := t.get("data_note"):
        parts.append(data_note)
    ls = t["lifetime_source"]
    parts.append(f"Lifetime {t['lifetime_years']} years: {ls['source']} ({ls['url']}).")
    land = ref(f"land_acres_per_mw_{kind}")
    parts.append(f"Land {land['value']} {land['units']}: {land['source']} ({land['url']}).")
    if kind == "onshore_wind":
        direct = ref("land_acres_per_mw_onshore_wind_direct")
        parts.append(f"Direct footprint {direct['value']} {direct['units']} (same study).")
    source = (
        f"NLR ATB 2025 v1.0.0: {sel['display_name']}, {sel['scenario']}, {sel['core_metric_case']} case, "
        f"{sel['cod_year']} COD, no tax credits"
    )
    url = t.get("docs_url") or atb["source"]["docs_url"]
    return Provenance(kind="assumption", source=source, url=url, note=" ".join(parts))


def _tech_spec(kind: AssetKind) -> TechSpec:
    t = atb_data()["techs"][kind]
    d = ref_value("deflator_2023_to_2024")
    der = t["derived"]
    spec: dict[str, Any] = {
        "kind": kind,
        "label": t["label"],
        "var_om_usd_per_mwh": (_atb_value(t, "Variable O&M") or 0.0) * d,
        "lifetime_years": int(t["lifetime_years"]),
        "land_acres_per_mw": ref_value(f"land_acres_per_mw_{kind}"),
        "typical_capacity_factor": _atb_value(t, "CF"),
    }
    if kind == "battery":
        fk, fe = battery_fom_split()
        spec |= {
            "capex_usd_per_kw": der["power_usd_per_kw"] * d,
            "capex_usd_per_kwh": der["energy_usd_per_kwh"] * d,
            "fixed_om_usd_per_kw_yr": fk + fe * BATTERY_REF_HOURS,
            "round_trip_efficiency": _atb_value(t, "Round-Trip Efficiency"),
        }
    else:
        spec |= {"capex_usd_per_kw": der["capex_ex_gcc_usd_per_kw"] * d, "fixed_om_usd_per_kw_yr": (_atb_value(t, "Fixed O&M") or 0.0) * d}
    if kind in GAS_KINDS:
        spec |= {"heat_rate_mmbtu_per_mwh": _atb_value(t, "Heat Rate"), "co2_kg_per_mmbtu": ref_value("co2_kg_per_mmbtu_natural_gas")}
    return TechSpec(**spec, provenance=_provenance(kind, spec))


@lru_cache(maxsize=None)
def _trajectory(kind: str) -> dict[int, float]:
    t = atb_data()["techs"].get(kind, {})
    return {int(y): float(v) for y, v in t.get("capex_ex_gcc_trajectory_usd_per_kw", {}).items()}


def replacement_cost_ratio(kind: str, years_after_cod: float) -> float:
    """ATB Moderate projected CAPEX at COD+years / CAPEX at COD (clamped to the last ATB year; 1.0 if none)."""
    traj = _trajectory(kind)
    if not traj or COD_YEAR not in traj or traj[COD_YEAR] <= 0:
        return 1.0
    year = min(max(COD_YEAR + int(round(years_after_cod)), min(traj)), max(traj))
    return traj[year] / traj[COD_YEAR]


# ---------------------------------------------------------------------------
# Interconnection
# ---------------------------------------------------------------------------

_TIERS: dict[int, dict[str, Any]] = {
    115: {
        "line": "transmission_line_115kv_usd_per_km", "sub": "substation_230kv_usd", "circuits": 2, "guides": "PG&E 2025",
        "line_desc": "115 kV double-circuit lattice line", "sub_desc": "new loop-in substation (230 kV 8-CB price used at 115 kV)",
    },
    230: {
        "line": "transmission_line_230kv_usd_per_km", "sub": "substation_230kv_usd", "circuits": 2, "guides": "PG&E 2025",
        "line_desc": "230 kV double-circuit lattice line", "sub_desc": "new 230 kV loop-in substation (breaker-and-a-half, 8 CB)",
    },
    500: {
        "line": "transmission_line_500kv_usd_per_km", "sub": "substation_500kv_usd", "circuits": 1,
        "guides": "SCE 2025 (line) and PG&E 2025 (substation)",
        "line_desc": "500 kV single-circuit lattice line", "sub_desc": "new 500 kV loop-in substation (breaker-and-a-half, 8 CB)",
    },
}


def transmission_tier(poi_voltage_kv: float | None) -> dict[str, Any]:
    """Voltage tier for a POI: >=345 kV -> 500 kV; <=161 kV -> 115 kV; else (and unknown) 230 kV."""
    if poi_voltage_kv is None or not math.isfinite(poi_voltage_kv):
        kv = 230
    elif poi_voltage_kv >= 345:
        kv = 500
    elif poi_voltage_kv <= 161:
        kv = 115
    else:
        kv = 230
    return {"kv": kv, **_TIERS[kv]}


def transmission_for_voltage(poi_voltage_kv: float | None) -> TransmissionSpec:
    """Line $/km and substation $ (2024$) from a CAISO participating TO 2025 unit cost guide."""
    tier = transmission_tier(poi_voltage_kv)
    d = ref_value("deflator_2025_to_2024")
    line, sub = ref(tier["line"]), ref(tier["sub"])
    line_usd, sub_usd = float(line["value"]) * d, float(sub["value"]) * d
    proxy = " The guide's 115 kV loop-in (8 CB) is $20.0M, so the 230 kV price is a conservative proxy." if tier["kv"] == 115 else ""
    note = (
        f"{_cap(tier['line_desc'])}: ${line['value']:,.0f}/km in 2025$ ({line['source']}). {_cap(tier['sub_desc'])}: "
        f"${sub['value']:,.0f} in 2025$ ({sub['source']}).{proxy} Both x CPI-U 2025->2024 deflator {d} = ${line_usd:,.0f}/km and "
        f"${sub_usd:,.0f} in 2024$. Base case: flat land / rural setting and line length >= 10 miles (terrain and length factor 1X); "
        "the guides add 1.2-3.0X for hilly, mountainous, forested, suburban or urban routes and 1.1-2X for short lines. Includes "
        "the guides' 35% line contingency; excludes right of way, permitting, environmental mitigation, corporate overheads and "
        "AFUDC. Screening estimate only: the real cost and any network upgrades need a utility interconnection study."
    )
    return TransmissionSpec(
        line_usd_per_km=line_usd,
        substation_usd=sub_usd,
        provenance=Provenance(
            kind="assumption",
            source=f"{tier['guides']} Generator Interconnection Unit Cost Guide (CAISO): {tier['line_desc']}; {tier['sub_desc']}",
            url=line["url"],
            note=note,
        ),
    )


@lru_cache(maxsize=1)
def _catalog() -> Catalog:
    return Catalog(techs=[_tech_spec(k) for k in KINDS], transmission=transmission_for_voltage(230))


def get_catalog() -> Catalog:
    return _catalog().model_copy(deep=True)
