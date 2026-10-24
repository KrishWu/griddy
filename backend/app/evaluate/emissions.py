"""Annual CO2e, import accounting, upstream methane, NOx and PM2.5.  OWNER: workstream C (Evaluate).

Direct CO2 (t)  = gas MMBtu x 53.06 kg/MMBtu / 1000 (40 CFR 98 Table C-1), per gas kind.
Imports (t)     = sum_h imports_h x grid CO2_h / 1000 (B's hourly CAISO average intensity; primary).
                  Alternative shown in extras: imports MWh x 1.02 x 0.428 t/MWh (CARB unspecified, 17 CCR 95111(b)(1)).
Upstream CH4    = gas MMBtu x 12.47 kg CO2e/MMBtu; added only when options["include_upstream_methane"] is truthy,
                  always reported in extras.
NOx / PM2.5 (t) = gas MMBtu x lb/MMBtu x 0.45359237 / 1000 (AP-42 lean-premix primary; CA BACT SCR alternative).
Battery and exports carry no direct emissions and earn no credits. Factors are never tuned to force an
ordering between scenarios: on-site gas CC (~0.32 t/MWh) can be dirtier than CAISO's average imports.
"""

from __future__ import annotations

from typing import Any

import numpy as np

from app.contract import Emissions, Provenance
from app.evaluate.catalog import LB_TO_KG, ref, ref_value

EGRID_YEAR = 2023


def compute_emissions(
    gas_mmbtu: dict[str, float],
    co2_kg_per_mmbtu: dict[str, float],
    imports: np.ndarray,
    grid_co2: np.ndarray,
    served_mwh: float,
    include_upstream: bool,
) -> tuple[Emissions, dict[str, Any]]:
    """Emissions result plus its extras keys (plain JSON values)."""
    mmbtu = float(sum(gas_mmbtu.values()))
    by_source = {k: v * co2_kg_per_mmbtu.get(k, 0.0) / 1000 for k, v in gas_mmbtu.items() if v > 0}
    direct_t = float(sum(by_source.values()))
    imports_mwh = float(imports.sum())
    hourly_t = float(imports @ grid_co2) / 1000
    by_source["grid_imports"] = hourly_t

    upstream_kg = ref_value("upstream_methane_kg_co2e_per_mmbtu")
    upstream_t = mmbtu * upstream_kg / 1000
    if include_upstream:
        by_source["upstream_methane"] = upstream_t
    extra_t = upstream_t if include_upstream else 0.0

    carb_ef, carb_tl = ref_value("carb_unspecified_import_t_co2_per_mwh"), ref_value("carb_transmission_loss_factor")
    carb_t = imports_mwh * carb_tl * carb_ef

    def intensity(t: float) -> float:
        return t * 1000 / served_mwh if served_mwh > 0 else 0.0

    total_t = direct_t + hourly_t + extra_t

    lb = LB_TO_KG / 1000  # lb -> metric t
    nox_lp = ref_value("nox_lb_per_mmbtu_gas_turbine_lean_premix")
    nox_cc, nox_ct = ref_value("nox_lb_per_mmbtu_gas_turbine_scr_bact"), ref_value("nox_lb_per_mmbtu_gas_ct_scr_bact")
    pm25 = ref_value("pm25_lb_per_mmbtu_gas_turbine")
    nox_t = mmbtu * nox_lp * lb
    nox_scr_t = (gas_mmbtu.get("gas_cc", 0.0) * nox_cc + gas_mmbtu.get("gas_ct", 0.0) * nox_ct) * lb
    pm_t = mmbtu * pm25 * lb

    egrid = ref_value("egrid_camx_co2_lb_per_mwh") * LB_TO_KG
    co2 = ref("co2_kg_per_mmbtu_natural_gas")
    import_weighted = hourly_t * 1000 / imports_mwh if imports_mwh > 0 else None
    provenance = [
        Provenance(kind="observed", source=f"EPA 40 CFR 98 Subpart C Table C-1: natural gas {co2['value']} kg CO2/MMBtu", url=co2["url"],
                   note="On-site combustion CO2 = gas MMBtu (ATB full-load heat rate x simulated MWh) x factor. Combustion CH4/N2O (<0.1% of CO2e) omitted."),
        Provenance(kind="simulated", source="GridForge hourly simulation: imports x hourly CAISO average grid CO2 intensity",
                   note=f"{imports_mwh:,.0f} MWh imported" + (f" at an import-weighted {import_weighted:,.0f} kg/MWh." if import_weighted else ".")),
        Provenance(kind="observed", source=ref("carb_unspecified_import_t_co2_per_mwh")["source"], url=ref("carb_unspecified_import_t_co2_per_mwh")["url"],
                   note=f"Alternative import accounting (extras only): {carb_tl} x {carb_ef} t CO2e/MWh = {carb_t:,.0f} t/yr."),
    ]
    if include_upstream:
        um = ref("upstream_methane_kg_co2e_per_mmbtu")
        provenance.append(Provenance(kind="inferred", source=um["source"], url=um["url"], note=f"{upstream_kg} kg CO2e/MMBtu x {mmbtu:,.0f} MMBtu."))

    nox_basis = (
        f"EPA AP-42 Table 3.1-1 lean-premix {nox_lp} lb NOx/MMBtu (no SCR) x {mmbtu:,.0f} MMBtu/yr = {nox_t:,.1f} t/yr; "
        f"with CA BACT SCR ({nox_cc} lb/MMBtu CC, {nox_ct} lb/MMBtu CT): {nox_scr_t:,.1f} t/yr"
    )
    if mmbtu <= 0:
        nox_basis = "No on-site gas combustion: 0 t NOx/yr"
    extras: dict[str, Any] = {
        "nox_t_per_yr": float(nox_t),
        "pm25_t_per_yr": float(pm_t),
        "nox_t_per_yr_scr": float(nox_scr_t),
        "nox_basis": nox_basis,
        "emissions_import_methods": {
            "caiso_hourly_average": {"grid_imports_t": hourly_t, "annual_t_co2e": total_t, "intensity_kg_per_mwh": intensity(total_t)},
            "carb_unspecified": {
                "grid_imports_t": carb_t,
                "annual_t_co2e": direct_t + carb_t + extra_t,
                "intensity_kg_per_mwh": intensity(direct_t + carb_t + extra_t),
                "factor_t_per_mwh": carb_tl * carb_ef,
                "base_factor_t_per_mwh": carb_ef,
                "transmission_loss_factor": carb_tl,
            },
        },
        "emissions_crosscheck": {
            "egrid_camx_kg_per_mwh": egrid,
            "egrid_year": EGRID_YEAR,
            "sim_import_weighted_kg_per_mwh": import_weighted,
            "sim_grid_mean_kg_per_mwh": float(grid_co2.mean()) if grid_co2.size else 0.0,
            "note": (
                f"eGRID{EGRID_YEAR} CAMX total output rate {ref_value('egrid_camx_co2_lb_per_mwh')} lb/MWh = {egrid:.1f} kg/MWh. "
                "eGRID is generation-based (plants inside CAMX), so it excludes imports into California; it is a sanity check "
                "on the simulation's hourly grid intensity, not a substitute for it."
            ),
        },
        "upstream_methane_t_co2e": float(upstream_t),
        "upstream_methane_included": bool(include_upstream),
        "ca_allowance_reference_usd_per_t": ref_value("ca_allowance_price_usd_per_t"),
        "direct_co2_t": direct_t,
    }
    emissions = Emissions(
        annual_t_co2e=total_t,
        by_source_t_co2e={k: float(v) for k, v in by_source.items()},
        intensity_kg_per_mwh=intensity(total_t),
        provenance=provenance,
    )
    return emissions, extras
