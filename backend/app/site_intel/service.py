"""Satellite + environmental site screening.  OWNER: workstream E (Site Intelligence).

STUB: returns an empty screening. Replace with Earth Engine land cover /
slope / solar resource, a Planet or Earth Engine imagery overlay, AirNow
air quality, and hourly grid carbon for carbon-aware load shifting
(see docs/workstreams/E-site-intel.md). Keep the function signature.
"""

from __future__ import annotations

from app.contract import Finding, LngLat, Provenance, SiteIntel


def site_intel(location: LngLat) -> SiteIntel:
    return SiteIntel(
        location=location,
        findings=[
            Finding(id="site_intel_stub", module="site", severity="info", title="Site screening pending", detail="Satellite and air-quality screening lands with workstream E."),
        ],
        provenance=[Provenance(kind="assumption", source="STUB")],
    )
