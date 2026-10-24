"""CAPEX / OPEX / NPC / LCOE / emissions / CFE / BOM.  OWNER: workstream C (Evaluate).

Keep the signature of evaluate() unchanged; app/pipeline.py calls it.

Financial boundary: the campus owner builds and owns every on-site asset and the new
interconnection (line + substation), pays their O&M and fuel, and buys grid imports at the
hourly price plus a delivery adder. Owned generation is costed only through CAPEX + O&M +
fuel; only imports are purchased power, so no MWh is paid for twice. Exports earn
options["export_credit_fraction"] (default 0) x the hourly price. A carbon price applies only
to on-site combustion CO2, because CAISO prices already embed cap-and-trade. No tax credits.
All dollars are real 2024 USD; finance.py documents the horizon method (explicit cash flows
with replacements and linear salvage).
"""

from __future__ import annotations

import math
from functools import partial
from typing import Any

import numpy as np

from app.contract import (
    Asset,
    Catalog,
    CostLine,
    Economics,
    Emissions,
    EvaluationResult,
    Provenance,
    Scenario,
    SimulationResult,
    TechSpec,
)
from app.evaluate.bom import LABELS, Fleet, build_bom, fleet
from app.evaluate.catalog import (
    BATTERY_REF_HOURS,
    DOLLAR_YEAR,
    GAS_KINDS,
    KINDS,
    LB_TO_KG,
    asset_params,
    atb_data,
    battery_fom_split,
    ref,
    ref_value,
    replacement_cost_ratio,
    transmission_for_voltage,
    transmission_tier,
)
from app.evaluate.cfe import cfe_metrics, grid_clean_share, month_index
from app.evaluate.emissions import compute_emissions
from app.evaluate.finance import CapitalItem, NpcResult, OpexItem, annuity_factor, net_present_cost

FINANCIAL_BOUNDARY = (
    "Campus owner: builds and owns every on-site asset and the new interconnection, pays O&M and fuel, and buys grid "
    "imports at the hourly price + delivery adder. Owned generation is never also counted as purchased power. Exports "
    "earn nothing by default. No tax credits. Real 2024 USD."
)


def _arr(x: Any, n: int) -> np.ndarray:
    """Float array of length n (padded/truncated, non-finite -> 0) from a list B sent."""
    a = np.asarray([] if x is None else x, dtype=float).ravel()
    if a.size != n:
        out = np.zeros(n)
        m = min(n, a.size)
        out[:m] = a[:m]
        a = out
    return np.nan_to_num(a, nan=0.0, posinf=0.0, neginf=0.0)


def _option_float(options: dict[str, Any], key: str, default: float) -> float:
    try:
        v = float(options.get(key, default))
    except (TypeError, ValueError):
        return default
    return v if math.isfinite(v) else default


def _truthy(v: Any) -> bool:
    return v.strip().lower() in ("1", "true", "yes", "on") if isinstance(v, str) else bool(v)


def _json_safe(x: Any) -> Any:
    """Plain-JSON copy: numpy scalars -> Python, non-finite floats -> None."""
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
        f = float(x)
        return f if math.isfinite(f) else None
    return x


def _m(usd: float) -> str:
    return f"{'-' if usd < 0 else ''}${abs(usd) / 1e6:,.1f}M"


CATEGORY_NAMES = {
    "fixed_om": "fixed O&M",
    "var_om": "variable O&M",
    "fuel": "fuel",
    "purchased_power": "purchased power",
    "export_revenue": "export credit",
    "carbon": "carbon",
}


def _kind_value(pairs: list[tuple[Asset, dict[str, Any]]], kind: str, field: str, default: float) -> float:
    """Capacity-weighted value of a spec field across a kind's assets (overrides applied)."""
    rows = [(a.capacity_mw, float(p[field])) for a, p in pairs if a.kind == kind and p.get(field) is not None]
    w = sum(c for c, _ in rows)
    return sum(c * v for c, v in rows) / w if w > 0 else default


def _overrides(asset: Asset, fields: tuple[str, ...]) -> str:
    used = [f"{k} = {asset.overrides[k]:g}" for k in fields if k in asset.overrides]
    return f" Scenario override: {', '.join(used)}." if used else ""


def gas_price_hourly(scenario: Scenario, n: int) -> tuple[np.ndarray, list[float] | None]:
    """Hourly $/MMBtu: the scenario scalar (authoritative annual average) x the 2024 PG&E Citygate monthly shape."""
    a = scenario.assumptions
    scalar = a.gas_price_usd_per_mmbtu
    if a.weather_year == 2024 and scenario.options.get("gas_price_shape") != "flat":
        p = np.asarray(ref_value("gas_price_pge_citygate_2024_monthly_usd_per_mmbtu"), dtype=float)
        monthly = scalar * p / p.mean()
        return monthly[month_index(a.weather_year, n)], [float(x) for x in monthly]
    return np.full(n, float(scalar)), None


def _capex(asset: Asset, p: dict[str, Any], spec: TechSpec, horizon: int) -> tuple[CostLine, CapitalItem]:
    kw = asset.capacity_mw * 1000
    unit = "MWac" if asset.kind == "solar_pv" else "MW"
    if asset.kind == "battery":
        hours = BATTERY_REF_HOURS if asset.duration_h is None else asset.duration_h
        kwh = kw * hours
        usd = kw * p["capex_usd_per_kw"] + kwh * (p["capex_usd_per_kwh"] or 0.0)
        size = f"{asset.capacity_mw:,.0f} MW / {kwh / 1000:,.0f} MWh"
        math_ = f"{kw:,.0f} kW x ${p['capex_usd_per_kw']:,.2f}/kW + {kwh:,.0f} kWh x ${p['capex_usd_per_kwh'] or 0:,.2f}/kWh"
    else:
        usd = kw * p["capex_usd_per_kw"]
        size = f"{asset.capacity_mw:,.0f} {unit}"
        math_ = f"{kw:,.0f} kW x ${p['capex_usd_per_kw']:,.2f}/kW"
    der = atb_data()["techs"][asset.kind]["derived"]
    atb = (
        f"ATB {der['power_usd_per_kw']:,.2f} $/kW + {der['energy_usd_per_kwh']:,.2f} $/kWh"
        if asset.kind == "battery"
        else f"ATB {der['capex_ex_gcc_usd_per_kw']:,.2f} $/kW"
    )
    label = f"{LABELS[asset.kind]} {size} ({asset.name or asset.id})"
    over = _overrides(asset, ("capex_usd_per_kw", "capex_usd_per_kwh", "lifetime_years"))
    life = p["lifetime_years"]
    ratio = replacement_cost_ratio(asset.kind, life)
    basis = f"{atb} net of ATB's generic grid-connection cost, 2023$, x CPI-U {ref_value('deflator_2023_to_2024')}"
    if any(k in asset.overrides for k in ("capex_usd_per_kw", "capex_usd_per_kwh")):
        basis = f"scenario override; the catalog default is {basis}"
    note = (
        f"{math_} = {_m(usd)} in 2024$ ({basis}).{over} Lifetime {life} years (ATB 2025 Definitions page, 'Technical "
        "Lifetimes for Technologies')"
        + (f"; re-bought in year {life} at {ratio:.2f}x (ATB Moderate projected cost)." if life < horizon else ".")
    )
    prov = Provenance(kind="assumption", source=spec.provenance.source, url=spec.provenance.url, note=note)
    item = CapitalItem(label, asset.kind, usd, life, partial(replacement_cost_ratio, asset.kind))
    return CostLine(category="capex", item=label, usd=usd, provenance=prov), item


def _fixed_om(kind: str, group: list[tuple[Asset, dict[str, Any]]], spec: TechSpec) -> CostLine:
    fk, fe = battery_fom_split()
    usd, parts = 0.0, []
    for a, p in group:
        kw = a.capacity_mw * 1000
        rate = p["fixed_om_usd_per_kw_yr"]
        split = kind == "battery" and "fixed_om_usd_per_kw_yr" not in a.overrides and abs(rate - (fk + fe * BATTERY_REF_HOURS)) < 1e-6
        if split:
            kwh = kw * (BATTERY_REF_HOURS if a.duration_h is None else a.duration_h)
            usd += kw * fk + kwh * fe
            parts.append(f"{kw:,.0f} kW x ${fk:.2f}/kW-yr + {kwh:,.0f} kWh x ${fe:.2f}/kWh-yr (ATB fixed O&M split)")
        else:
            usd += kw * rate
            parts.append(f"{kw:,.0f} kW x ${rate:.2f}/kW-yr" + _overrides(a, ("fixed_om_usd_per_kw_yr",)))
    mw = sum(a.capacity_mw for a, _ in group)
    note = "; ".join(parts) + f" = {_m(usd)}/yr. ATB Fixed O&M (2023$) x CPI-U 2023->2024 {ref_value('deflator_2023_to_2024')}."
    return CostLine(
        category="fixed_om",
        item=f"Fixed O&M: {LABELS[kind]} ({mw:,.0f} MW)",
        usd=usd,
        provenance=Provenance(kind="assumption", source=spec.provenance.source, url=spec.provenance.url, note=note),
    )


def _methodology(scenario: Scenario, res: NpcResult, tx_kv: int, shaped: bool, carbon_price: float) -> dict[str, str]:
    """Plain-language method notes, one per topic, for the UI footnotes."""
    a = scenario.assumptions
    life_ic = int(ref_value("interconnection_lifetime_years"))
    batt_ratio = replacement_cost_ratio("battery", 15)
    return {
        "boundary": FINANCIAL_BOUNDARY,
        "horizon": (
            f"Explicit cash flows over N = {a.analysis_years} years (finance.py). Year 0: all CAPEX. Years 1..N: constant real OPEX "
            "(fixed O&M + variable O&M + fuel + purchased power + carbon - export credit). An asset with life L < N is re-bought "
            f"at each k*L < N; a battery (15 yr) is re-bought in year 15 at {batt_ratio:.2f}x its 2027 cost (ATB Moderate projection). "
            "Linear salvage of the last installation's remaining life, (t_last + L - N)/L, is credited in year N: 1/3 for "
            f"30-year PV/wind/gas at N = 20, 2/3 for a battery replaced in year 15, {life_ic - 20}/{life_ic} for the "
            f"{life_ic}-year interconnection. Lifetimes: ATB 2025 'Technical Lifetimes for Technologies'; interconnection "
            "from PG&E's 2027 GRC depreciation study (station equipment 47-R2). Cross-check: LCOE_crf annualizes each "
            "item's CAPEX with CRF(r, its own life)."
        ),
        "discounting": (
            f"NPC = sum_t CF_t / (1+r)^t with a real discount rate r = {a.discount_rate:.1%}. LCOE = NPC / sum_(t=1..N) "
            f"MWh_served / (1+r)^t (served = demand - unmet; {res.discounted_mwh:,.0f} discounted MWh)."
        ),
        "dollar_year": (
            f"Real {DOLLAR_YEAR} USD. ATB 2023$ x {ref_value('deflator_2023_to_2024')} and 2025 PTO cost guides x "
            f"{ref_value('deflator_2025_to_2024')} (BLS CPI-U annual averages). Gas and hourly power prices are taken as 2024$. "
            f"The CA allowance reference (${ref_value('ca_allowance_price_usd_per_t')}/t) is nominal 2026 and is not deflated."
        ),
        "capex": (
            "NLR ATB 2025 v1.0.0, Moderate scenario, 2027 COD, no tax credits: Expanded Cost Drivers (Exp) case for PV, wind and "
            "battery; R&D case for gas (the only one published). CAPEX is used net of ATB's generic grid-connection cost: "
            "OCC + CFC x OCC/(OCC+GCC). Battery = $/kW + $/kWh x hours (least-squares fit over 2-10 h, R^2 1.0). "
            f"Interconnection ({tx_kv} kV tier): CAISO participating-TO 2025 unit cost guides, flat rural terrain (factor 1X); "
            "a real cost needs a utility interconnection study."
        ),
        "fuel": (
            f"Fuel = sum_h gas MWh_h x ATB full-load heat rate (no part-load penalty) x price_h. The scenario gas price "
            f"(${a.gas_price_usd_per_mmbtu:.2f}/MMBtu) is the authoritative annual average"
            + (
                "; with weather year 2024 it follows the 2024 PG&E Citygate monthly shape (CAISO DMM 2024 Annual Report, Fig. 2.7, "
                "normalized to mean 1) so gas and power prices come from the same year. options.gas_price_shape = 'flat' disables it."
                if shaped
                else "; flat all year (the 2024 monthly shape applies only to weather year 2024 and is off when options.gas_price_shape = 'flat')."
            )
        ),
        "imports": (
            f"Purchased power = sum_h imports_h x (price_h + ${a.import_adder_usd_per_mwh:g}/MWh delivery adder), price source "
            f"'{a.price_source}'"
            + (f" (${a.flat_price_usd_per_mwh:g}/MWh every hour)" if a.price_source == "flat" else "")
            + ". Import emissions use the simulation's hourly CAISO average intensity (primary); CARB's "
            "unspecified-import factor (0.428 t/MWh x 1.02 transmission loss, 17 CCR 95111(b)(1)) is shown as an alternative."
        ),
        "exports": (
            f"Exports earn options.export_credit_fraction (here {_option_float(scenario.options, 'export_credit_fraction', 0.0):g}) "
            "x the hourly price: a behind-the-meter campus is not paid for exports by default. Exports earn no emission credit."
        ),
        "carbon": (
            f"Carbon price ${carbon_price:g}/t applies only to on-site combustion CO2: CAISO energy prices already embed "
            "California cap-and-invest allowance costs, so pricing imports again would double count. Upstream methane is never "
            f"priced. Reference: Aug 2026 auction settlement ${ref_value('ca_allowance_price_usd_per_t')}/t (nominal), a UI hint only."
        ),
        "emissions": (
            "Direct CO2 = gas MMBtu x 53.06 kg/MMBtu (40 CFR 98 Table C-1); combustion CH4/N2O (<0.1%) omitted. Imports = "
            "sum_h imports_h x grid CO2_h. Upstream methane (2.3% leakage, Alvarez 2018; GWP100 29.8, IPCC AR6) adds 12.47 kg "
            "CO2e/MMBtu only when options.include_upstream_methane is true, and is always reported. Battery and exports carry no "
            "direct emissions or credits. NOx: AP-42 lean-premix 0.099 lb/MMBtu (no SCR, conservative); CA BACT SCR alternative "
            "2.0 ppm (CC) / 2.5 ppm (CT). PM2.5: AP-42 total PM 0.0066 lb/MMBtu. Factors are never tuned to force an ordering: "
            "on-site gas CC (~0.32 t/MWh) can be dirtier than CAISO average imports."
        ),
        "cfe": (
            "24/7 CFE (hourly matching): clean supply each hour = on-site wind/solar used on site + battery discharge x its clean "
            "fraction (energy-pool mixing) + imports used by the load x the grid's clean share that hour. An hour counts only "
            "when clean supply covers all demand; score = matched hours / hours with demand. The energy-weighted hourly share "
            "and the annual-netting share are shown for contrast."
        ),
        "bom": (
            "Screening counts from nameplate MW/MWh and typical unit sizes (bom_basis.json; PV ILR, wind turbine, CC block and "
            "CT unit from ATB). Each row's basis states the formula. Not an engineered design."
        ),
    }


def _interconnection(scenario: Scenario, catalog: Catalog) -> tuple[list[CostLine], list[CapitalItem], dict[str, Any]]:
    """New line + substation CAPEX for the POI's voltage tier (the 230 kV tier is the catalog's own)."""
    g = scenario.grid
    tier = transmission_tier(g.poi_voltage_kv)
    tx = catalog.transmission if tier["kv"] == 230 else transmission_for_voltage(g.poi_voltage_kv)
    life = int(ref_value("interconnection_lifetime_years"))
    life_note = f" Lifetime {life} years: {ref('interconnection_lifetime_years')['source']}."
    rows: list[tuple[str, float, str]] = []
    if g.connected and g.interconnection_km > 0:
        usd = g.interconnection_km * tx.line_usd_per_km
        head = f"{g.interconnection_km:,.1f} km x ${tx.line_usd_per_km:,.0f}/km = {_m(usd)}."
        rows.append((f"Interconnection: {tier['line_desc']} ({g.interconnection_km:,.1f} km)", usd, head))
    if g.connected and g.new_substation:
        rows.append((f"Interconnection: {tier['sub_desc'][:1].upper()}{tier['sub_desc'][1:]}", tx.substation_usd, f"1 x ${tx.substation_usd:,.0f}."))
    lines, items = [], []
    for label, usd, head in rows:
        prov = tx.provenance.model_copy(update={"note": f"{head} {tx.provenance.note}{life_note}"})
        lines.append(CostLine(category="capex", item=label, usd=usd, provenance=prov))
        items.append(CapitalItem(label, "interconnection", usd, life))
    return lines, items, tier


def _energy_lines(
    scenario: Scenario, catalog: Catalog, pairs: list[tuple[Asset, dict[str, Any]]], gen: dict[str, np.ndarray], n: int
) -> tuple[list[CostLine], dict[str, float], dict[str, float], float, list[float] | None]:
    """Variable O&M and fuel from simulated output; returns lines, MMBtu and CO2 factor by gas kind, fuel $, monthly gas price."""
    a = scenario.assumptions
    gas_price_h, monthly = gas_price_hourly(scenario, n)
    shape_src = ref("gas_price_pge_citygate_2024_monthly_usd_per_mmbtu")
    lines: list[CostLine] = []
    mmbtu_by: dict[str, float] = {}
    co2_by: dict[str, float] = {}
    fuel_usd = 0.0
    for kind in KINDS:
        series = gen.get(kind)
        mwh = float(series.sum()) if series is not None else 0.0
        if mwh <= 0:
            continue
        spec = catalog.spec(kind)
        vom = _kind_value(pairs, kind, "var_om_usd_per_mwh", spec.var_om_usd_per_mwh)
        if vom > 0:
            note = f"{mwh:,.0f} MWh x ${vom:.3f}/MWh (ATB Variable O&M x CPI-U 2023->2024)."
            prov = Provenance(kind="assumption", source=spec.provenance.source, url=spec.provenance.url, note=note)
            lines.append(CostLine(category="var_om", item=f"Variable O&M: {LABELS[kind]} ({mwh:,.0f} MWh/yr)", usd=mwh * vom, provenance=prov))
        if kind not in GAS_KINDS:
            continue
        hr = _kind_value(pairs, kind, "heat_rate_mmbtu_per_mwh", spec.heat_rate_mmbtu_per_mwh or 0.0)
        burn = series * hr
        mmbtu, usd = float(burn.sum()), float(burn @ gas_price_h)
        fuel_usd += usd
        mmbtu_by[kind] = mmbtu
        co2_by[kind] = _kind_value(pairs, kind, "co2_kg_per_mmbtu", spec.co2_kg_per_mmbtu or 0.0)
        source = f"Scenario gas price ${a.gas_price_usd_per_mmbtu:.2f}/MMBtu (annual average)" + (
            " x 2024 PG&E Citygate monthly shape (CAISO DMM 2024 Annual Report, Fig. 2.7)" if monthly else ", flat"
        )
        note = (
            f"{mwh:,.0f} MWh x {hr:.3f} MMBtu/MWh (ATB full-load heat rate, no part-load penalty) = {mmbtu:,.0f} MMBtu; "
            f"burn-weighted ${usd / mmbtu if mmbtu else 0:.3f}/MMBtu."
        )
        prov = Provenance(kind="assumption", source=source, url=shape_src["url"] if monthly else None, note=note)
        lines.append(CostLine(category="fuel", item=f"Natural gas: {LABELS[kind]} ({mmbtu:,.0f} MMBtu/yr)", usd=usd, provenance=prov))
    return lines, mmbtu_by, co2_by, fuel_usd, monthly


def _grid_lines(scenario: Scenario, imports: np.ndarray, exports: np.ndarray, price: np.ndarray, direct_t: float) -> list[CostLine]:
    """Purchased power (imports only), export credit and the carbon price on on-site combustion."""
    a, g = scenario.assumptions, scenario.grid
    lines: list[CostLine] = []
    imp_mwh, exp_mwh = float(imports.sum()), float(exports.sum())
    if g.connected or imp_mwh > 0:
        adder = a.import_adder_usd_per_mwh
        usd = float(imports @ (price + adder))
        avg = float(imports @ price) / imp_mwh if imp_mwh > 0 else 0.0
        prov = Provenance(
            kind="simulated",
            source=(
                f"GridForge hourly simulation: imports x (hourly price + import adder), price source '{a.price_source}'"
                + (f" (${a.flat_price_usd_per_mwh:g}/MWh every hour)" if a.price_source == "flat" else "")
            ),
            note=(
                f"sum_h imports_h x (price_h + ${adder:g}) = {_m(usd)}/yr; import-weighted energy price ${avg:.2f}/MWh. "
                "Only imports are purchased power: on-site generation is costed through CAPEX, O&M and fuel."
            ),
        )
        item = f"Grid imports ({imp_mwh:,.0f} MWh/yr) at hourly price + ${adder:g}/MWh delivery adder"
        lines.append(CostLine(category="purchased_power", item=item, usd=usd, provenance=prov))
    if exp_mwh > 0:
        frac = _option_float(scenario.options, "export_credit_fraction", 0.0)
        credit = frac * float(exports @ price)
        prov = Provenance(
            kind="assumption",
            source=f"Export credit = {frac:g} x hourly price (scenario option export_credit_fraction, default 0)",
            note="A behind-the-meter campus is not paid for exports by default. Exports carry no emission credit.",
        )
        item = f"Grid exports ({exp_mwh:,.0f} MWh/yr) credited at {frac:.0%} of the hourly price"
        lines.append(CostLine(category="export_revenue", item=item, usd=-credit if credit else 0.0, provenance=prov))
    if a.carbon_price_usd_per_t > 0:
        prov = Provenance(
            kind="assumption",
            source=f"Scenario carbon price ${a.carbon_price_usd_per_t:g}/t CO2 on on-site combustion only",
            note=(
                f"{direct_t:,.0f} t x ${a.carbon_price_usd_per_t:g}/t. Imports are not priced: CAISO prices already embed "
                f"cap-and-trade. Reference: CA allowance ${ref_value('ca_allowance_price_usd_per_t')}/t (Aug 2026 auction, nominal)."
            ),
        )
        item = f"Carbon price on on-site combustion ({direct_t:,.0f} t CO2/yr)"
        lines.append(CostLine(category="carbon", item=item, usd=direct_t * a.carbon_price_usd_per_t, provenance=prov))
    return lines


def evaluate(scenario: Scenario, sim: SimulationResult, catalog: Catalog) -> EvaluationResult:
    a, h = scenario.assumptions, sim.hourly
    n = len(h.demand_mw)
    demand, unmet = _arr(h.demand_mw, n), _arr(h.unmet_mw, n)
    imports, exports, curtailed = _arr(h.imports_mw, n), _arr(h.exports_mw, n), _arr(h.curtailed_mw, n)
    charge, discharge, soc = _arr(h.battery_charge_mw, n), _arr(h.battery_discharge_mw, n), _arr(h.battery_soc_mwh, n)
    price, grid_co2 = _arr(h.price_usd_per_mwh, n), _arr(h.grid_co2_kg_per_mwh, n)
    if a.price_source == "flat":  # the scenario's flat price wins even if simulate sent an hourly series
        price = np.full(n, float(a.flat_price_usd_per_mwh))
    zeros = np.zeros(n)
    gen = {k: _arr(h.generation_mw[k], n) for k in KINDS if k in h.generation_mw}
    served = max(0.0, float(demand.sum() - unmet.sum()))
    pairs = [(x, asset_params(x, catalog)) for x in scenario.assets if x.capacity_mw > 0]

    lines: list[CostLine] = []
    items: list[CapitalItem] = []
    for asset, p in pairs:
        line, item = _capex(asset, p, catalog.spec(asset.kind), a.analysis_years)
        lines.append(line)
        items.append(item)
    ic_lines, ic_items, tier = _interconnection(scenario, catalog)
    lines += ic_lines
    items += ic_items
    for kind in KINDS:
        group = [(x, p) for x, p in pairs if x.kind == kind]
        if group:
            lines.append(_fixed_om(kind, group, catalog.spec(kind)))
    energy, gas_mmbtu, co2_factor, fuel_usd, gas_monthly = _energy_lines(scenario, catalog, pairs, gen, n)
    lines += energy
    direct_t = sum(gas_mmbtu[k] * co2_factor[k] / 1000 for k in gas_mmbtu)
    lines += _grid_lines(scenario, imports, exports, price, direct_t)
    shaped = gas_monthly is not None

    include_upstream = _truthy(scenario.options.get("include_upstream_methane", False))
    emissions, em_extras = compute_emissions(gas_mmbtu, co2_factor, imports, grid_co2, served, include_upstream)

    opex = [OpexItem(line.item, line.category, line.usd) for line in lines if line.category != "capex"]
    res = net_present_cost(items, opex, served, a.discount_rate, a.analysis_years)

    fl = fleet(scenario, catalog)
    bom = build_bom(scenario, catalog, fl)

    g_h, g_src = grid_clean_share(sim.extras, grid_co2)
    rte = _kind_value(pairs, "battery", "round_trip_efficiency", catalog.spec("battery").round_trip_efficiency or 0.85)
    cfe = cfe_metrics(
        demand,
        gen.get("solar_pv", zeros) + gen.get("onshore_wind", zeros),
        curtailed,
        exports,
        charge,
        discharge,
        soc,
        imports,
        gen.get("gas_cc", zeros) + gen.get("gas_ct", zeros),
        g_h,
        rte,
        a.weather_year,
    )

    fuel_mmbtu = float(sum(gas_mmbtu.values()))
    extras: dict[str, Any] = {
        **em_extras,
        **cfe,
        "cfe_grid_share_source": g_src,
        "land_acres_total": float(sum(fl.land.values())),
        "land_acres_direct_total": float(sum(fl.land_direct.values())),
        "land_acres_by_kind": dict(fl.land),
        "npc_breakdown": res.breakdown,
        "cash_flows": res.cash_flows,
        "lcoe_crf_usd_per_mwh": res.lcoe_crf_usd_per_mwh,
        "served_mwh_per_yr": served,
        "discounted_mwh_served": res.discounted_mwh,
        "fuel_mmbtu_per_yr": fuel_mmbtu,
        "fuel_effective_usd_per_mmbtu": fuel_usd / fuel_mmbtu if fuel_mmbtu > 0 else float(a.gas_price_usd_per_mmbtu),
        "gas_price_monthly_usd_per_mmbtu": gas_monthly,
        "dollar_year": DOLLAR_YEAR,
        "interconnection_tier_kv": tier["kv"],
    }
    extras["provenance"] = _headline_provenance(scenario, lines, res, emissions, extras, fl)
    extras["methodology"] = _methodology(scenario, res, tier["kv"], shaped, a.carbon_price_usd_per_t)

    return EvaluationResult(
        economics=Economics(
            financial_boundary=FINANCIAL_BOUNDARY,
            capex_total_usd=res.capex_usd,
            annual_opex_usd=res.annual_opex_usd,
            npc_usd=res.npc_usd,
            lcoe_usd_per_mwh=res.lcoe_usd_per_mwh,
            lines=lines,
            bom=bom,
        ),
        emissions=emissions,
        extras=_json_safe(extras),
    )


def _headline_provenance(
    scenario: Scenario, lines: list[CostLine], res: NpcResult, emissions: Emissions, ex: dict[str, Any], fl: Fleet
) -> dict[str, Any]:
    """Provenance (as dicts) for each headline metric the UI shows."""
    a = scenario.assumptions
    atb_url = atb_data()["source"]["docs_url"]
    capex_lines = [x for x in lines if x.category == "capex"]
    by_cat: dict[str, float] = {}
    for x in lines:
        if x.category != "capex":
            by_cat[x.category] = by_cat.get(x.category, 0.0) + x.usd
    pv = {}
    for b in res.breakdown:
        pv[b["category"]] = pv.get(b["category"], 0.0) + b["usd"]
    af = annuity_factor(a.discount_rate, max(1, int(a.analysis_years)))
    co2 = ref("co2_kg_per_mmbtu_natural_gas")
    ap42 = ref("nox_lb_per_mmbtu_gas_turbine_lean_premix")
    pm = ref("pm25_lb_per_mmbtu_gas_turbine")
    carb = ex["emissions_import_methods"]["carb_unspecified"]
    served = ex["served_mwh_per_yr"]
    gas_kg = ref_value("egrid_camx_gas_co2_lb_per_mwh") * LB_TO_KG
    src_note = (
        "grid clean share from the simulation"
        if ex["cfe_grid_share_source"] == "simulate"
        else (
            f"grid clean share inferred as 1 - grid CO2 / {gas_kg:.0f} kg/MWh (eGRID2023 CAMX gas-fired output rate "
            f"{ref_value('egrid_camx_gas_co2_lb_per_mwh')} lb/MWh)"
        )
    )
    prov = {
        "capex_total_usd": Provenance(
            kind="assumption",
            source="NLR ATB 2025 v1.0.0 (Moderate, 2027 COD, no tax credits) + CAISO PTO 2025 interconnection unit cost guides",
            url=atb_url,
            note="Year-0 CAPEX, 2024$: " + ("; ".join(f"{x.item} {_m(x.usd)}" for x in capex_lines) or "no capital items") + ".",
        ),
        "annual_opex_usd": Provenance(
            kind="simulated",
            source="Year-1 operating cost: simulated hourly dispatch x ATB O&M, gas price and hourly power price",
            note=("; ".join(f"{CATEGORY_NAMES.get(k, k)} {_m(v)}" for k, v in by_cat.items()) or "no operating costs")
            + ". Replacements and salvage are in NPC, not here.",
        ),
        "npc_usd": Provenance(
            kind="simulated",
            source=f"Explicit {a.analysis_years}-year cash flows at a {a.discount_rate:.1%} real discount rate",
            note=(
                f"CAPEX {_m(pv.get('capex', 0))} + PV replacements {_m(pv.get('replacement', 0))} - PV salvage "
                f"{_m(-pv.get('salvage', 0))} + PV OPEX {_m(sum(v for k, v in pv.items() if k not in ('capex', 'replacement', 'salvage')))} "
                f"(annuity factor {af:.4f}) = {_m(res.npc_usd)}."
            ),
        ),
        "lcoe_usd_per_mwh": Provenance(
            kind="simulated",
            source="LCOE = NPC / discounted MWh served",
            note=(
                f"{_m(res.npc_usd)} / ({served:,.0f} MWh/yr x {af:.4f} = {res.discounted_mwh:,.0f} MWh) = "
                f"${res.lcoe_usd_per_mwh:.2f}/MWh. CRF cross-check: ${res.lcoe_crf_usd_per_mwh:.2f}/MWh."
            ),
        ),
        "annual_t_co2e": Provenance(
            kind="simulated",
            source="On-site gas combustion (EPA 40 CFR 98, 53.06 kg CO2/MMBtu) + hourly imports x CAISO average grid intensity",
            url=co2["url"],
            note=(
                "; ".join(f"{k} {v:,.0f} t" for k, v in emissions.by_source_t_co2e.items())
                + f". With CARB's unspecified-import factor instead: {carb['annual_t_co2e']:,.0f} t."
                + (
                    " Includes upstream methane."
                    if ex["upstream_methane_included"]
                    else f" Upstream methane ({ex['upstream_methane_t_co2e']:,.0f} t) excluded by default."
                )
            ),
        ),
        "intensity_kg_per_mwh": Provenance(
            kind="simulated",
            source="Annual CO2e / MWh served",
            note=f"{emissions.annual_t_co2e:,.0f} t x 1,000 / {served:,.0f} MWh = {emissions.intensity_kg_per_mwh:,.1f} kg/MWh.",
        ),
        "cfe_score_24_7": Provenance(
            kind="simulated",
            source="Hourly 24/7 CFE matching: on-site clean supply, battery (clean fraction tracked) and the grid's clean share",
            note=(
                f"{ex['cfe_score_24_7']:.1%} of hours fully met by clean supply; {src_note}. Energy-weighted hourly share "
                f"{ex['cfe_hourly_energy_share']:.1%}; annual netting {ex['cfe_annual_netting_share']:.1%}."
            ),
        ),
        "land_acres_total": Provenance(
            kind="assumption",
            source="LBNL Bolinger & Bolinger 2022 (PV array area), NREL Denholm et al. 2009 (wind project area), EIA/Sargent & Lundy 2024 (gas, battery)",
            url=ref("land_acres_per_mw_solar_pv")["url"],
            note=(
                ("; ".join(f"{LABELS[k]} {v:,.0f} acres" for k, v in fl.land.items()) or "no on-site assets")
                + f". Direct (exclusive-use) footprint {ex['land_acres_direct_total']:,.0f} acres (wind at 2.47 acres/MW)."
            ),
        ),
        "nox_t_per_yr": Provenance(kind="inferred", source=f"EPA AP-42 Table 3.1-1 lean-premix {ap42['value']} lb NOx/MMBtu x simulated gas burn",
                                   url=ap42["url"], note=ex["nox_basis"] + "."),
        "pm25_t_per_yr": Provenance(
            kind="inferred",
            source=f"EPA AP-42 Table 3.1-2a total PM {pm['value']} lb/MMBtu, all treated as PM2.5 (upper bound)",
            url=pm["url"],
            note=f"{ex['fuel_mmbtu_per_yr']:,.0f} MMBtu/yr x {pm['value']} lb/MMBtu x 0.45359237 kg/lb = {ex['pm25_t_per_yr']:,.2f} t/yr.",
        ),
    }
    return {k: v.model_dump() for k, v in prov.items()}
