import httpx
import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.explore import area, zoning
from app.main import app

POLYGON = {"type": "Polygon", "coordinates": [[[-120, 35], [-119.9, 35], [-119.9, 35.1], [-120, 35.1], [-120, 35]]]}


def test_population_counts_centroids_inside_area_with_explicit_demand_assumptions(monkeypatch):
    monkeypatch.setattr(area, "population_points", lambda: np.array([[-119.95, 35.05, 290], [-118, 36, 500]]))
    r = area.summarize_area(area.AreaRequest(footprint=POLYGON))
    assert r["population"] == 290
    assert r["estimated_households"] == pytest.approx(100)
    assert r["residential_demand_mwh_per_year"] == pytest.approx(650)
    assert r["estimated_residential_peak_mw"] * 0.55 * 8760 == pytest.approx(650)
    assert r["area_km2"] > 90
    assert "actual utility customers" in r["caveat"]


def test_holes_exclude_population_and_missing_data_is_not_zero(monkeypatch):
    poly = {**POLYGON, "coordinates": POLYGON["coordinates"] + [[[-119.96, 35.04], [-119.94, 35.04], [-119.94, 35.06], [-119.96, 35.06], [-119.96, 35.04]]]}
    monkeypatch.setattr(area, "population_points", lambda: np.array([[-119.95, 35.05, 290]]))
    assert area.summarize_area(area.AreaRequest(footprint=poly))["population"] == 0
    monkeypatch.setattr(area, "population_points", lambda: None)
    r = area.summarize_area(area.AreaRequest(footprint=POLYGON))
    assert r["population"] is None and r["estimated_households"] is None


@pytest.mark.parametrize("geometry", [{"type": "Point", "coordinates": [-120, 35]}, {"type": "Polygon", "coordinates": []}, {"type": "nope"}])
def test_invalid_area_returns_422(geometry):
    assert TestClient(app).post("/api/explore/area", json={"footprint": geometry}).status_code == 422


def test_zoning_uses_both_overlapping_services_and_retains_vintage(monkeypatch):
    calls = []
    def handle(req):
        calls.append(str(req.url))
        polygon = {"type": "Polygon", "coordinates": [[[-120, 37], [-119.9, 37], [-119.9, 37.1], [-120, 37.1], [-120, 37]]]}
        return httpx.Response(200, json={"type": "FeatureCollection", "features": [{"type": "Feature", "geometry": polygon, "properties": {"OBJECTID": 1, "Code": "A", "Date": "2022"}}]})
    real_client = httpx.Client
    monkeypatch.setattr(zoning.httpx, "Client", lambda **kw: real_client(transport=httpx.MockTransport(handle)))
    zoning._query.cache_clear()
    r = zoning.zoning("-120,37,-119.9,37.1")
    assert len(calls) == 2 and len(r["features"]) == 2
    assert len({f["id"] for f in r["features"]}) == 2
    assert r["features"][0]["properties"]["Date"] == "2022"
    assert r["metadata"]["status"] == "available"
    zoning.zoning("-120,37,-119.9,37.1")
    assert len(calls) == 2  # cache hit
    zoning._query.cache_clear()


def test_zoning_outage_and_invalid_extent_are_explicit(monkeypatch):
    real_client = httpx.Client
    monkeypatch.setattr(zoning.httpx, "Client", lambda **kw: real_client(transport=httpx.MockTransport(lambda req: httpx.Response(503))))
    zoning._query.cache_clear()
    r = zoning.zoning("-120,37,-119.9,37.1")
    assert r["metadata"]["status"] == "unavailable" and not r["features"]
    for bbox in ("nan,37,-119,38", "-125,32,-114,42", "bad"):
        with pytest.raises(ValueError):
            zoning.zoning(bbox)
    zoning._query.cache_clear()
