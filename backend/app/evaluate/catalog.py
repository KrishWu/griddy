"""Technology cost + performance catalog.  OWNER: workstream C (Evaluate).

STUB: these numbers are rough placeholders so the pipeline runs end to end.
Replace them with Annual Technology Baseline (ATB 2025) values (and cite the exact table/scenario/year in
each Provenance) before the demo.
"""

from app.contract import Catalog, Provenance, TechSpec, TransmissionSpec

_PLACEHOLDER = Provenance(
    kind="assumption",
    source="PLACEHOLDER - verify against ATB 2025 (Moderate)",
    url="https://atb.nlr.gov/electricity/2025/data",
)

_CATALOG = Catalog(
    techs=[
        TechSpec(
            kind="solar_pv",
            label="Utility-scale solar PV (single-axis tracking)",
            capex_usd_per_kw=1450,
            fixed_om_usd_per_kw_yr=22,
            lifetime_years=30,
            land_acres_per_mw=6.0,
            typical_capacity_factor=0.27,
            provenance=_PLACEHOLDER,
        ),
        TechSpec(
            kind="onshore_wind",
            label="Onshore wind",
            capex_usd_per_kw=1650,
            fixed_om_usd_per_kw_yr=30,
            lifetime_years=30,
            land_acres_per_mw=40.0,
            typical_capacity_factor=0.32,
            provenance=_PLACEHOLDER,
        ),
        TechSpec(
            kind="gas_cc",
            label="Natural gas combined cycle",
            capex_usd_per_kw=1300,
            fixed_om_usd_per_kw_yr=30,
            var_om_usd_per_mwh=2.5,
            heat_rate_mmbtu_per_mwh=6.4,
            co2_kg_per_mmbtu=53.06,
            lifetime_years=30,
            land_acres_per_mw=0.05,
            provenance=_PLACEHOLDER,
        ),
        TechSpec(
            kind="gas_ct",
            label="Natural gas combustion turbine (peaker)",
            capex_usd_per_kw=1000,
            fixed_om_usd_per_kw_yr=22,
            var_om_usd_per_mwh=5.0,
            heat_rate_mmbtu_per_mwh=9.7,
            co2_kg_per_mmbtu=53.06,
            lifetime_years=30,
            land_acres_per_mw=0.03,
            provenance=_PLACEHOLDER,
        ),
        TechSpec(
            kind="battery",
            label="Li-ion battery storage",
            capex_usd_per_kw=350,
            capex_usd_per_kwh=330,
            fixed_om_usd_per_kw_yr=40,
            round_trip_efficiency=0.85,
            lifetime_years=15,
            land_acres_per_mw=0.1,
            provenance=_PLACEHOLDER,
        ),
    ],
    transmission=TransmissionSpec(
        line_usd_per_km=1_500_000,
        substation_usd=30_000_000,
        provenance=_PLACEHOLDER,
    ),
)


def get_catalog() -> Catalog:
    return _CATALOG.model_copy(deep=True)
