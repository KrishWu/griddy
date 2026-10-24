"""Scenario presets + report export.  OWNER: workstream D (Build + Report + UI shell).

The three presets compare on the same 1 GW data-center demand (~900 MW average)
and site. They are illustrative configurations, not engineered designs, sized
relative to average load so each one tells its story:
  Hybrid: PV ~1.4x load (a midday surplus charges the battery), gas + imports
  >= PEAK demand (firm through the night after the battery empties, with margin for
  real, non-flat load), 4 h battery ~0.33x. Meets demand every hour.
  Renewable-heavy: deliberately thin on firm capacity, so the stress test has an
  honest "needs firming" finding to show.
Re-tune with B and C once real profiles land.

Mode B ("community") has one preset: a ~20 MW neighborhood microgrid with rooftop-scale
solar, a community battery and a grid tie sized to cover the evening peak.
"""

from __future__ import annotations

import csv
import io
import json

from app.contract import Asset, DemandSpec, GridConnection, LngLat, Scenario, ScenarioResult, Site
from app.builder.project_report import project_report_rows

# Where the website starts: Stanford University, Santa Clara County (PG&E territory). The nearest
# 220 kV+ facility is the SLAC 230 kV substation/line, 3.4 km away (A's site summary).
DEFAULT_SITE = Site(
    id="stanford",
    name="Stanford, Santa Clara County",
    location=LngLat(lon=-122.1697, lat=37.4275),
    county="Santa Clara",
    utility_territory="PG&E",
)
DEFAULT_POI_KV = 230.0
DEFAULT_INTERCONNECTION_KM = 3.4


def _base(
    id_: str,
    name: str,
    assets: list[Asset],
    import_limit_mw: float,
    site: Site,
    demand: DemandSpec | None = None,
    mode: str = "industrial",
    grid: GridConnection | None = None,
) -> Scenario:
    return Scenario(
        id=id_,
        name=name,
        mode=mode,
        preset=id_,
        site=site,
        demand=demand or DemandSpec(peak_mw=1000, load_factor=0.9, pue=1.2, profile="flat"),
        assets=assets,
        # Starts at the default site's nearest 230 kV tie; A's nearest-line data replaces these after a map click.
        grid=grid
        or GridConnection(import_limit_mw=import_limit_mw, export_limit_mw=0, interconnection_km=DEFAULT_INTERCONNECTION_KM, poi_voltage_kv=DEFAULT_POI_KV),
    )


def list_presets(site: Site | None = None) -> list[Scenario]:
    site = site or DEFAULT_SITE
    return [
        _base("grid_connected", "Grid-connected", [], 1100, site),
        _base(
            "hybrid",
            "Hybrid power campus",
            [
                Asset(id="solar-1", kind="solar_pv", capacity_mw=1300),
                Asset(id="gas-1", kind="gas_cc", capacity_mw=700),
                Asset(id="batt-1", kind="battery", capacity_mw=300, duration_h=4),
            ],
            300,
            site,
        ),
        _base(
            "renewable_heavy",
            "Renewable-heavy",
            [
                Asset(id="solar-1", kind="solar_pv", capacity_mw=2000),
                Asset(id="wind-1", kind="onshore_wind", capacity_mw=800),
                Asset(id="batt-1", kind="battery", capacity_mw=900, duration_h=4),
                Asset(id="gas-1", kind="gas_ct", capacity_mw=300),
            ],
            400,
            site,
        ),
        _base(
            "community_microgrid",
            "Community microgrid",
            [
                Asset(id="solar-1", kind="solar_pv", capacity_mw=30),
                Asset(id="batt-1", kind="battery", capacity_mw=8, duration_h=4),
            ],
            20,
            site,
            demand=DemandSpec(kind="community", peak_mw=20, load_factor=0.55, pue=1.0, profile="community"),
            mode="community",
            # Ties into existing distribution: a short feeder, no new transmission substation.
            grid=GridConnection(import_limit_mw=20, export_limit_mw=0, interconnection_km=1, new_substation=False),
        ),
    ]


def report_csv(result: ScenarioResult) -> str:
    """Flat CSV mirroring the /report page: headline metrics, site, design, assumptions,
    cost lines with sources, BOM, emissions by source and findings."""
    buf = io.StringIO()
    w = csv.writer(buf)
    sc, sim = result.scenario, result.simulation
    e, em, s = result.evaluation.economics, result.evaluation.emissions, sim.summary
    a = sc.assumptions

    w.writerow(["section", "item", "value", "unit", "source"])
    w.writerow(["summary", "scenario", sc.name, "", ""])
    w.writerow(["summary", "capex_total", round(e.capex_total_usd), "USD", ""])
    w.writerow(["summary", "annual_opex", round(e.annual_opex_usd), "USD/yr", ""])
    w.writerow(["summary", "npc", round(e.npc_usd), "USD", ""])
    w.writerow(["summary", "lcoe", round(e.lcoe_usd_per_mwh, 2), "USD/MWh", ""])
    w.writerow(["summary", "emissions", round(em.annual_t_co2e), "t CO2e/yr", ""])
    w.writerow(["summary", "carbon_intensity", round(em.intensity_kg_per_mwh, 1), "kg CO2e/MWh", ""])
    w.writerow(["summary", "onsite_clean_share", round(s.onsite_clean_share, 4), "fraction", ""])
    w.writerow(["summary", "unmet_hours", s.hours_unmet, "h", ""])
    w.writerow(["summary", "financial_boundary", e.financial_boundary, "", ""])

    w.writerow(["site", "name", sc.site.name, "", ""])
    w.writerow(["site", "location", f"{sc.site.location.lat:.4f},{sc.site.location.lon:.4f}", "lat,lon", ""])
    w.writerow(["site", "county", sc.site.county or "", "", ""])
    w.writerow(["site", "utility_territory", sc.site.utility_territory or "", "", ""])

    w.writerow(["design", "mode", sc.mode, "", ""])
    w.writerow(["design", "peak_demand", sc.demand.peak_mw, "MW", "facility peak at the meter = IT load x PUE"])
    if sc.mode != "community":
        w.writerow(["design", "it_load", round(sc.demand.peak_mw / sc.demand.pue, 1), "MW", "peak_demand / PUE"])
    w.writerow(["design", "load_factor", sc.demand.load_factor, "", ""])
    w.writerow(["design", "pue", sc.demand.pue, "", ""])
    w.writerow(["design", "load_profile", sc.demand.profile, "", ""])
    for asset in sc.assets:
        w.writerow(["design", f"{asset.kind} ({asset.id})", round(asset.capacity_mw, 1), "MW", ""])
        if asset.kind == "battery":
            w.writerow(["design", f"{asset.kind} ({asset.id}) duration", asset.duration_h, "h", ""])
    w.writerow(["design", "grid_import_limit", round(sc.grid.import_limit_mw, 1), "MW", ""])
    w.writerow(["design", "grid_export_limit", round(sc.grid.export_limit_mw, 1), "MW", ""])
    w.writerow(["design", "interconnection_km", sc.grid.interconnection_km, "km", ""])
    w.writerow(["design", "poi_voltage", sc.grid.poi_voltage_kv or "", "kV", ""])

    for name, value in a.model_dump().items():
        w.writerow(["assumption", name, value, "", ""])

    for line in e.lines:
        w.writerow([line.category, line.item, round(line.usd), "USD" if line.category == "capex" else "USD/yr", line.provenance.source])
    for b in e.bom:
        w.writerow(["bom", b.item, b.quantity, b.unit, b.basis])
    for source, t in em.by_source_t_co2e.items():
        w.writerow(["emissions", source, round(t), "t CO2e/yr", ""])
    for f in result.findings:
        w.writerow(["finding", f.title, f.severity, "", f.detail])
    w.writerows(project_report_rows(result))
    if sc.site.footprint:
        w.writerow(["site", "selected_footprint", json.dumps(sc.site.footprint), "GeoJSON", "User-selected area"])
    return buf.getvalue()
