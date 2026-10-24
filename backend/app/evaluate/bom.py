"""Bill of materials and land use.  OWNER: workstream C (Evaluate).

Screening-level equipment counts from nameplate MW/MWh and typical unit sizes
(data/evaluate/bom_basis.json; PV ILR, wind turbine, CC block and CT unit from
atb_2025_catalog.json). Item names are prefixed "Generation: ", "Land: ",
"Interconnection: " or "Electrical: " so the UI can group them, and every item's
`basis` states the formula with its numbers. Not an engineered design.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

from app.contract import BomItem, Catalog, Scenario
from app.evaluate.catalog import (
    BATTERY_REF_HOURS,
    KINDS,
    NUCLEAR_KINDS,
    NUCLEAR_UNIT_MW,
    asset_params,
    atb_data,
    bom_basis,
    ref,
    ref_value,
    transmission_tier,
)

LABELS = {
    "solar_pv": "Solar PV",
    "onshore_wind": "Onshore wind",
    "gas_cc": "Gas combined cycle",
    "gas_ct": "Gas combustion turbine",
    "battery": "Battery storage",
    "nuclear": "Nuclear (large reactor)",
    "nuclear_smr": "Nuclear (small modular reactor)",
}


def _f(x: float, digits: int = 0) -> str:
    return f"{x:,.{digits}f}"


def _ceil(x: float) -> int:
    return int(math.ceil(x - 1e-9)) if x > 0 else 0


@dataclass
class Fleet:
    """Nameplate by kind plus land use (project area and direct footprint, acres)."""

    mw: dict[str, float] = field(default_factory=dict)
    battery_mwh: float = 0.0
    land: dict[str, float] = field(default_factory=dict)
    land_direct: dict[str, float] = field(default_factory=dict)
    land_rate: dict[str, float] = field(default_factory=dict)  # capacity-weighted acres per MW (overrides applied)


def fleet(scenario: Scenario, catalog: Catalog) -> Fleet:
    out = Fleet()
    wind_direct = ref_value("land_acres_per_mw_onshore_wind_direct")
    for a in scenario.assets:
        if a.capacity_mw <= 0:
            continue
        p = asset_params(a, catalog)
        acres = a.capacity_mw * p["land_acres_per_mw"]
        if a.kind == "battery":
            hours = BATTERY_REF_HOURS if a.duration_h is None else a.duration_h
            out.battery_mwh += a.capacity_mw * hours
            acres *= hours / BATTERY_REF_HOURS  # land source is per 4 h system; scales with energy (0.01 acres/MWh)
        direct = a.capacity_mw * wind_direct if a.kind == "onshore_wind" else acres
        out.mw[a.kind] = out.mw.get(a.kind, 0.0) + a.capacity_mw
        out.land[a.kind] = out.land.get(a.kind, 0.0) + acres
        out.land_direct[a.kind] = out.land_direct.get(a.kind, 0.0) + direct
    for k, mw in out.mw.items():
        out.land_rate[k] = out.land[k] / mw
    return out


def build_bom(scenario: Scenario, catalog: Catalog, fl: Fleet) -> list[BomItem]:
    b = {k: v["value"] for k, v in bom_basis().items() if k != "_meta"}
    techs = atb_data()["techs"]
    pf = b["power_factor"]
    items: list[BomItem] = []

    def add(item: str, qty: float, unit: str, basis: str) -> None:
        items.append(BomItem(item=item, quantity=float(qty), unit=unit, basis=basis))

    pv, wind, batt = fl.mw.get("solar_pv", 0.0), fl.mw.get("onshore_wind", 0.0), fl.mw.get("battery", 0.0)
    cc, ct = fl.mw.get("gas_cc", 0.0), fl.mw.get("gas_ct", 0.0)

    # Generation ----------------------------------------------------------
    n_inv = n_pcs = n_wtg = gts = sts = cts = 0
    if pv > 0:
        ilr = techs["solar_pv"]["pv_ilr"]["value"]
        mwdc = pv * ilr
        kw_mod = b["pv_module_w"] / 1000
        n_inv = _ceil(pv / (b["pv_inverter_mva"] * pf))
        add("Generation: PV DC capacity", round(mwdc, 1), "MWdc", f"{_f(pv)} MWac x ILR {ilr} (ATB 2025 Utility-Scale PV) = {_f(mwdc, 1)} MWdc")
        add(
            f"Generation: PV modules ({b['pv_module_w']:.0f} W bifacial)",
            _ceil(mwdc * 1000 / kw_mod),
            "modules",
            f"ceil({_f(pv)} MWac x ILR {ilr} x 1,000 kW/MW / {kw_mod} kW per module)",
        )
        add(
            f"Generation: PV central inverters / MV skids ({b['pv_inverter_mva']} MVA)",
            n_inv,
            "skids",
            f"ceil({_f(pv)} MWac / ({b['pv_inverter_mva']} MVA x power factor {pf})) = ceil({_f(pv / (b['pv_inverter_mva'] * pf), 2)})",
        )
    if wind > 0:
        ref_unit = techs["onshore_wind"]["reference_unit"]
        t_mw, t_alt = ref_unit["value"], ref_unit.get("atb_2035_turbine_mw")
        n_wtg = _ceil(wind / t_mw)
        alt = f"; ATB's 2035 T1 turbine ({t_alt} MW) would need {_ceil(wind / t_alt)}" if t_alt else ""
        add(
            f"Generation: Wind turbines ({t_mw} MW)",
            n_wtg,
            "turbines",
            f"ceil({_f(wind)} MW / {t_mw} MW): {ref_unit['description']}{alt}",
        )
    if batt > 0:
        n_pcs = _ceil(batt / b["bess_pcs_mw"])
        basis = f"{_f(batt)} MW x duration_h per asset (default {BATTERY_REF_HOURS:.0f} h) = {_f(fl.battery_mwh)} MWh"
        add("Generation: Battery energy", round(fl.battery_mwh, 1), "MWh", basis)
        add(
            f"Generation: Battery containers ({b['battery_container_mwh']} MWh, 20-ft LFP)",
            _ceil(fl.battery_mwh / b["battery_container_mwh"]),
            "containers",
            f"ceil({_f(fl.battery_mwh)} MWh / {b['battery_container_mwh']} MWh per container)",
        )
        add(
            f"Generation: Battery PCS / MV skids ({b['bess_pcs_mw']} MW)",
            n_pcs,
            "skids",
            f"ceil({_f(batt)} MW / {b['bess_pcs_mw']} MW per PCS skid ({b['bess_pcs_mw'] / pf:.1f} MVA x pf {pf}))",
        )
    if cc > 0:
        ru = techs["gas_cc"]["reference_unit"]
        gt_mw = ru["value"] / ru["gts_per_block"]
        gts = _ceil(cc / gt_mw)
        sts = _ceil(gts * ru["sts_per_block"] / ru["gts_per_block"])
        block = f"ATB {ru['gts_per_block']}-on-{ru['sts_per_block']} H-class block = {_f(ru['value'])} MW-net"
        add(
            "Generation: Gas CC combustion turbines + HRSGs (H-class)",
            gts,
            "trains",
            f"ceil({_f(cc)} MW / ({block} / {ru['gts_per_block']} GTs)) = ceil({_f(cc / gt_mw, 2)}); one HRSG per GT",
        )
        add(
            "Generation: Gas CC steam turbines",
            sts,
            "units",
            f"ceil({gts} GTs x {ru['sts_per_block']} ST / {ru['gts_per_block']} GTs per block)",
        )
    if ct > 0:
        ct_mw = techs["gas_ct"]["reference_unit"]["value"]
        cts = _ceil(ct / ct_mw)
        add(
            "Generation: Gas combustion turbines (F-class, simple cycle)",
            cts,
            "units",
            f"ceil({_f(ct)} MW / {ct_mw} MW-net ATB F-class unit) = ceil({_f(ct / ct_mw, 2)})",
        )

    # Nuclear ---------------------------------------------------------------
    for k in NUCLEAR_KINDS:
        mw = fl.mw.get(k, 0.0)
        if mw > 0:
            unit = NUCLEAR_UNIT_MW[k]
            what = "reactors" if k == "nuclear" else "SMR modules"
            add(f"Nuclear: {what}", math.ceil(mw / unit - 1e-9), "units", f"ceil({_f(mw)} MW / {unit:g} MW per unit) (ATB reference unit; see the catalog source)")

    # Land ------------------------------------------------------------------
    for k in KINDS:
        if k not in fl.land:
            continue
        rate = fl.land_rate[k]
        if k == "solar_pv":
            name, basis = "Land: Solar PV (array area)", f"{_f(pv)} MWac x {rate:.2f} acres/MWac direct array area (LBNL, Bolinger & Bolinger 2022)"
        elif k == "onshore_wind":
            d = ref_value("land_acres_per_mw_onshore_wind_direct")
            name = "Land: Onshore wind (total project area)"
            basis = (
                f"{_f(wind)} MW x {rate:.2f} acres/MW total project area incl. turbine spacing (NREL, Denholm et al. 2009); "
                f"direct footprint {d} acres/MW = {_f(fl.land_direct[k])} acres, the rest stays farmable"
            )
        elif k == "battery":
            name = "Land: Battery storage"
            per_mwh = fl.land[k] / fl.battery_mwh if fl.battery_mwh > 0 else 0.0
            basis = (
                f"{_f(fl.battery_mwh)} MWh x {per_mwh:.3f} acres/MWh ({ref_value('land_acres_per_mw_battery')} acres/MW for a "
                f"{BATTERY_REF_HOURS:.0f} h system, scaled by energy; EIA/Sargent & Lundy 2024)"
            )
        elif k in NUCLEAR_KINDS:
            land = ref(f"land_acres_per_mw_{k}")
            name = f"Land: {LABELS[k]}"
            basis = f"{_f(fl.mw[k])} MW x {rate} acres/MW ({land['source']})"
        else:
            name = f"Land: {LABELS[k]}"
            basis = f"{_f(fl.mw[k])} MW x {rate} acres/MW (EIA/Sargent & Lundy 2024 cost study)"
        add(name, round(fl.land[k], 1), "acres", basis)
    if fl.land:
        total, direct = sum(fl.land.values()), sum(fl.land_direct.values())
        add("Land: Total project area", round(total, 1), "acres", " + ".join(f"{_f(v, 1)} ({LABELS[k]})" for k, v in fl.land.items()))
        add(
            "Land: Total direct footprint",
            round(direct, 1),
            "acres",
            "Project area with wind at its direct (exclusive-use) footprint: " + " + ".join(f"{_f(v, 1)}" for v in fl.land_direct.values()),
        )

    # Interconnection -------------------------------------------------------
    g = scenario.grid
    tier = transmission_tier(g.poi_voltage_kv)
    line_terminals = 0
    if g.connected:
        poi = "unknown POI voltage, default tier" if g.poi_voltage_kv is None else f"POI {g.poi_voltage_kv:g} kV"
        if g.interconnection_km > 0:
            line_terminals = tier["circuits"]
            add(
                f"Interconnection: New transmission line ({tier['line_desc']})",
                round(g.interconnection_km, 2),
                "km",
                f"Scenario interconnection_km; {tier['kv']} kV tier ({poi}); {tier['circuits']} circuit(s)",
            )
        if g.new_substation:
            name = f"Interconnection: {tier['sub_desc'][:1].upper()}{tier['sub_desc'][1:]}"
            add(name, 1, "each", f"Scenario new_substation = true; utility side of the POI ({poi})")

    # Electrical ------------------------------------------------------------
    collector = pv + wind + batt
    n_mpt = _ceil(collector / pf / b["mpt_mva"])
    if n_mpt:
        add(
            f"Electrical: Main power transformers (230/34.5 kV, {b['mpt_mva']:.0f} MVA)",
            n_mpt,
            "units",
            f"ceil(({_f(pv)} MW PV + {_f(wind)} MW wind + {_f(batt)} MW battery) / pf {pf} / {b['mpt_mva']:.0f} MVA) = "
            f"ceil({_f(collector / pf / b['mpt_mva'], 2)}); gas units step up through their own GSUs",
        )
    n_gsu = gts + sts + cts
    if n_gsu:
        add("Electrical: Generator step-up transformers (GSUs)", n_gsu, "units", f"One per gas/steam turbine: {gts} CC GTs + {sts} STs + {cts} CTs")
    n_pad = n_inv + n_pcs + n_wtg
    if n_pad:
        add(
            "Electrical: MV pad-mount step-up transformers (34.5 kV)",
            n_pad,
            "units",
            f"One per PV inverter skid ({n_inv}) and BESS PCS skid ({n_pcs}), integrated in the MV power station, plus one per wind turbine ({n_wtg})",
        )
    dc = scenario.demand.kind == "data_center"
    peak = scenario.demand.peak_mw
    n_svc = _ceil(peak / pf / b["dc_service_transformer_mva"]) + 1 if dc and peak > 0 else 0
    if n_svc:
        add(
            f"Electrical: Data-center service transformers (230/34.5 kV, {b['dc_service_transformer_mva']:.0f} MVA)",
            n_svc,
            "units",
            f"ceil({_f(peak)} MW peak / pf {pf} / {b['dc_service_transformer_mva']:.0f} MVA) + 1 spare (N+1)",
        )
    elements = n_mpt + n_gsu + n_svc + line_terminals
    if elements:
        hv = b["hv_breakers_per_element"]
        add(
            "Electrical: HV circuit breakers (campus switchyard, breaker-and-a-half)",
            _ceil(hv * elements),
            "breakers",
            f"ceil({hv} x ({n_mpt} MPTs + {n_gsu} GSUs + {n_svc} service transformers + {line_terminals} line terminals)); "
            "the utility substation's own breakers are in its cost",
        )
    feeders = _ceil(collector / b["mv_feeder_mw"]) + _ceil(peak / b["mv_feeder_mw"])
    if feeders:
        add(
            "Electrical: MV feeders (34.5 kV)",
            feeders,
            "feeders",
            f"ceil({_f(collector)} MW collector / {b['mv_feeder_mw']:.0f} MW) + ceil({_f(peak)} MW load / {b['mv_feeder_mw']:.0f} MW)",
        )
        per = b["mv_feeders_per_switchgear_lineup"]
        basis = f"ceil({feeders} feeders / {per:.0f} feeders per lineup)"
        add("Electrical: MV switchgear lineups (34.5 kV metal-clad)", _ceil(feeders / per), "lineups", basis)
    if dc and peak > 0:
        it = peak / scenario.demand.pue
        red = b["dc_ups_redundancy_factor"]
        add(
            f"Electrical: UPS modules ({b['dc_ups_module_mw']} MW, 4-to-make-3 distributed redundant)",
            _ceil(it / b["dc_ups_module_mw"] * red),
            "modules",
            f"ceil({_f(it)} MW IT (= {_f(peak)} MW / PUE {scenario.demand.pue}) / {b['dc_ups_module_mw']} MW x {red:.3f} redundancy)",
        )
        base = _ceil(peak / pf / b["dc_unit_substation_mva"])
        add(
            f"Electrical: MV/LV unit substations ({b['dc_unit_substation_mva']} MVA, 34.5 kV/480 V)",
            _ceil(base * red),
            "units",
            f"ceil(ceil({_f(peak)} MW / pf {pf} / {b['dc_unit_substation_mva']} MVA) = {base} x {red:.3f} redundancy)",
        )
    return items
