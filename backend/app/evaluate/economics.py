"""CAPEX / OPEX / NPC / LCOE / emissions / BOM.  OWNER: workstream C (Evaluate).

STUB: a simple, transparent first pass so the pipeline runs end to end.
Keep the signature of evaluate() unchanged; app/pipeline.py calls it.

Financial boundary: the campus owner builds and owns every on-site asset and
buys grid imports at the hourly price. Owned generation is costed through
CAPEX + O&M + fuel; only imports appear as purchased power, so nothing is
counted twice.
"""

from __future__ import annotations

from app.contract import (
    BomItem,
    Catalog,
    CostLine,
    Economics,
    Emissions,
    EvaluationResult,
    Provenance,
    Scenario,
    SimulationResult,
)

_SIM = Provenance(kind="simulated", source="GridForge hourly simulation")


def _annuity_factor(rate: float, years: int) -> float:
    """Present value of $1/yr for `years` years."""
    if rate == 0:
        return float(years)
    return (1 - (1 + rate) ** -years) / rate


def evaluate(scenario: Scenario, sim: SimulationResult, catalog: Catalog) -> EvaluationResult:
    a = scenario.assumptions
    h = sim.hourly
    lines: list[CostLine] = []
    bom: list[BomItem] = []
    emissions_by_source: dict[str, float] = {}

    for asset in scenario.assets:
        spec = catalog.spec(asset.kind)
        p = spec.model_dump() | asset.overrides
        kw = asset.capacity_mw * 1000
        capex = kw * p["capex_usd_per_kw"]
        if asset.kind == "battery":
            kwh = kw * (asset.duration_h or 4)
            capex += kwh * (p["capex_usd_per_kwh"] or 0)
        lines.append(CostLine(category="capex", item=f"{spec.label} ({asset.capacity_mw:.0f} MW)", usd=capex, provenance=spec.provenance))
        lines.append(CostLine(category="fixed_om", item=spec.label, usd=kw * p["fixed_om_usd_per_kw_yr"], provenance=spec.provenance))
        bom.append(BomItem(item=spec.label, quantity=asset.capacity_mw, unit="MW", basis="Scenario input"))
        bom.append(
            BomItem(
                item=f"Land for {spec.label}",
                quantity=round(asset.capacity_mw * p["land_acres_per_mw"], 1),
                unit="acres",
                basis=f"{p['land_acres_per_mw']} acres/MW",
            )
        )

    # Energy-dependent costs use the simulated output of each technology kind.
    for kind, series in h.generation_mw.items():
        spec = catalog.spec(kind)  # type: ignore[arg-type]
        mwh = float(sum(series))
        if spec.var_om_usd_per_mwh:
            lines.append(CostLine(category="var_om", item=spec.label, usd=mwh * spec.var_om_usd_per_mwh, provenance=spec.provenance))
        if spec.heat_rate_mmbtu_per_mwh:
            mmbtu = mwh * spec.heat_rate_mmbtu_per_mwh
            lines.append(
                CostLine(
                    category="fuel",
                    item=f"Natural gas for {spec.label}",
                    usd=mmbtu * a.gas_price_usd_per_mmbtu,
                    provenance=Provenance(kind="assumption", source=f"Gas price ${a.gas_price_usd_per_mmbtu}/MMBtu"),
                )
            )
            emissions_by_source[kind] = mmbtu * (spec.co2_kg_per_mmbtu or 0) / 1000

    adder = a.import_adder_usd_per_mwh
    imports_cost = sum(m * (p + adder) for m, p in zip(h.imports_mw, h.price_usd_per_mwh))
    lines.append(
        CostLine(
            category="purchased_power",
            item=f"Grid imports at hourly price + ${adder:.0f}/MWh delivery adder",
            usd=imports_cost,
            provenance=_SIM,
        )
    )
    export_rev = sum(m * p for m, p in zip(h.exports_mw, h.price_usd_per_mwh))
    if export_rev:
        lines.append(CostLine(category="export_revenue", item="Grid exports at hourly price", usd=-export_rev, provenance=_SIM))
    emissions_by_source["grid_imports"] = sum(m * c for m, c in zip(h.imports_mw, h.grid_co2_kg_per_mwh)) / 1000

    total_t = sum(emissions_by_source.values())
    if a.carbon_price_usd_per_t:
        lines.append(
            CostLine(
                category="carbon",
                item="Carbon price on all emissions",
                usd=total_t * a.carbon_price_usd_per_t,
                provenance=Provenance(kind="assumption", source=f"${a.carbon_price_usd_per_t}/t CO2"),
            )
        )

    g = scenario.grid
    if g.connected:
        tx = catalog.transmission
        lines.append(CostLine(category="capex", item=f"Interconnection line ({g.interconnection_km:.0f} km)", usd=g.interconnection_km * tx.line_usd_per_km, provenance=tx.provenance))
        if g.new_substation:
            lines.append(CostLine(category="capex", item="New substation", usd=tx.substation_usd, provenance=tx.provenance))

    capex = sum(line.usd for line in lines if line.category == "capex")
    annual = sum(line.usd for line in lines if line.category != "capex")
    af = _annuity_factor(a.discount_rate, a.analysis_years)
    npc = capex + annual * af
    served_mwh = sim.summary.demand_mwh - sim.summary.unmet_mwh
    lcoe = npc / (served_mwh * af) if served_mwh else 0.0

    return EvaluationResult(
        economics=Economics(
            financial_boundary="Campus owner: builds and owns on-site assets, buys grid imports at hourly price",
            capex_total_usd=capex,
            annual_opex_usd=annual,
            npc_usd=npc,
            lcoe_usd_per_mwh=lcoe,
            lines=lines,
            bom=bom,
        ),
        emissions=Emissions(
            annual_t_co2e=total_t,
            by_source_t_co2e=emissions_by_source,
            intensity_kg_per_mwh=total_t * 1000 / served_mwh if served_mwh else 0.0,
            provenance=[
                Provenance(kind="assumption", source="EPA natural gas 53.06 kg CO2/MMBtu"),
                Provenance(kind="simulated", source="Hourly imports x hourly grid CO2 intensity"),
            ],
        ),
    )
