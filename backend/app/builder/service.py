"""Scenario presets + report export.  OWNER: workstream D (Build + Report + UI shell).

The three presets compare on the same 1 GW data-center demand (~900 MW average)
and site. They are illustrative configurations, not engineered designs, sized
relative to average load so each one tells its story:
  Hybrid: PV ~1.4x load (a midday surplus charges the battery), gas + imports
  >= load (firm at night), 4 h battery ~0.33x. Meets demand every hour.
  Renewable-heavy: deliberately thin on firm capacity, so the stress test has an
  honest "needs firming" finding to show.
Re-tune with B and C once real profiles land.

Mode B ("community") has one preset: a ~20 MW neighborhood microgrid with rooftop-scale
solar, a community battery and a grid tie sized to cover the evening peak.
"""

from __future__ import annotations

import csv
import io

from app.contract import Asset, DemandSpec, GridConnection, LngLat, Scenario, ScenarioResult, Site

DEFAULT_SITE = Site(
    id="kern-example",
    name="Example site - Kern County, CA",
    location=LngLat(lon=-119.47, lat=35.40),
    county="Kern",
    utility_territory="PG&E",
)


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
        grid=grid or GridConnection(import_limit_mw=import_limit_mw, export_limit_mw=0, interconnection_km=15),
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
                Asset(id="gas-1", kind="gas_cc", capacity_mw=600),
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
    """Flat CSV of headline metrics, cost lines and BOM. STUB - extend as needed."""
    buf = io.StringIO()
    w = csv.writer(buf)
    e, em, s = result.evaluation.economics, result.evaluation.emissions, result.simulation.summary
    w.writerow(["section", "item", "value", "unit", "source"])
    w.writerow(["summary", "scenario", result.scenario.name, "", ""])
    w.writerow(["summary", "capex_total", round(e.capex_total_usd), "USD", ""])
    w.writerow(["summary", "annual_opex", round(e.annual_opex_usd), "USD/yr", ""])
    w.writerow(["summary", "lcoe", round(e.lcoe_usd_per_mwh, 2), "USD/MWh", ""])
    w.writerow(["summary", "emissions", round(em.annual_t_co2e), "t CO2e/yr", ""])
    w.writerow(["summary", "unmet_hours", s.hours_unmet, "h", ""])
    for line in e.lines:
        w.writerow([line.category, line.item, round(line.usd), "USD" if line.category == "capex" else "USD/yr", line.provenance.source])
    for b in e.bom:
        w.writerow(["bom", b.item, b.quantity, b.unit, b.basis])
    for f in result.findings:
        w.writerow(["finding", f.title, f.severity, "", f.detail])
    return buf.getvalue()
