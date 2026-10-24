"""Grid map layers + site summary.  OWNER: workstream A (Explore / GIS).

STUB: returns tiny sample layers so the map renders. Replace with EIA-860
plants, OpenStreetMap/HIFLD lines + substations, and county boundaries
(see docs/workstreams/A-explore.md). Keep the function signatures.
"""

from __future__ import annotations

from typing import Any

from app.contract import Finding, LngLat, Provenance, Site, SiteSummary

LAYERS = ("plants", "transmission", "substations", "boundaries")

_SAMPLE = Provenance(kind="assumption", source="STUB sample features - not real infrastructure")


def _fc(features: list[dict[str, Any]]) -> dict[str, Any]:
    return {"type": "FeatureCollection", "features": features}


def get_layer(layer: str) -> dict[str, Any]:
    """Return a GeoJSON FeatureCollection for one of LAYERS."""
    if layer == "plants":
        return _fc(
            [
                {
                    "type": "Feature",
                    "geometry": {"type": "Point", "coordinates": [-119.55, 35.33]},
                    "properties": {"id": "sample-plant-1", "name": "Sample solar plant", "fuel": "solar", "capacity_mw": 250, "sample": True},
                },
                {
                    "type": "Feature",
                    "geometry": {"type": "Point", "coordinates": [-119.30, 35.45]},
                    "properties": {"id": "sample-plant-2", "name": "Sample gas plant", "fuel": "gas", "capacity_mw": 500, "sample": True},
                },
            ]
        )
    if layer == "substations":
        return _fc(
            [
                {
                    "type": "Feature",
                    "geometry": {"type": "Point", "coordinates": [-119.49, 35.27]},
                    "properties": {"id": "sample-sub-1", "name": "Sample 500 kV substation", "voltage_kv": 500, "sample": True},
                }
            ]
        )
    if layer == "transmission":
        return _fc(
            [
                {
                    "type": "Feature",
                    "geometry": {"type": "LineString", "coordinates": [[-119.49, 35.27], [-119.40, 35.60], [-119.20, 36.00]]},
                    "properties": {"id": "sample-line-1", "voltage_kv": 500, "sample": True},
                }
            ]
        )
    return _fc([])


def summarize_site(location: LngLat) -> SiteSummary:
    return SiteSummary(
        site=Site(id=f"site-{location.lon:.3f}-{location.lat:.3f}", name="Selected site", location=location, county=None),
        nearest_substations=[{"id": "sample-sub-1", "name": "Sample 500 kV substation", "voltage_kv": 500, "distance_km": 14.0}],
        nearby_plants=[],
        findings=[
            Finding(id="explore_stub", module="explore", severity="info", title="Sample data", detail="Explore layers are stubs until workstream A lands real data."),
        ],
        provenance=[_SAMPLE],
    )
