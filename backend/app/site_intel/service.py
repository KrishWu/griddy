"""Satellite + environmental site screening.  OWNER: workstream E (Site Intelligence).

STUB: returns an empty screening. Replace with Earth Engine land cover /
slope / solar resource, a Planet or Earth Engine imagery overlay, AirNow
air quality, and hourly grid carbon for carbon-aware load shifting
(see docs/workstreams/E-site-intel.md). Keep the function signature.
"""

from __future__ import annotations

from app.contract import EvaluationResult, Finding, LngLat, Provenance, Scenario, SimulationResult, SiteIntel


def site_intel(location: LngLat) -> SiteIntel:
    return SiteIntel(
        location=location,
        findings=[
            Finding(id="site_intel_stub", module="site", severity="info", title="Site screening pending", detail="Satellite and air-quality screening lands with workstream E."),
        ],
        provenance=[Provenance(kind="assumption", source="STUB")],
    )


def site_findings(scenario: Scenario, sim: SimulationResult, evaluation: EvaluationResult) -> list[Finding]:
    """Findings that need the scenario's results, appended to every /api/run.

    E.g. AIR_PERMIT_RISK = C's gas NOx (evaluation.extras["nox_t_per_yr"]) at a site in a
    nonattainment area (from cached AirNow/EPA data, never a live call here: this
    runs on every scenario run and compare). STUB: no findings yet.
    """
    return []
