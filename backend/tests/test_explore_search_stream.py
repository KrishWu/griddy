import json

import pytest
from fastapi.testclient import TestClient
from shapely.geometry import box, mapping, shape

from app.explore import zoning
from app.explore.search import search_places
from app.main import app

FOOTPRINT = mapping(box(-119.48, 35.39, -119.46, 35.41))


def test_search_finds_california_cities_counties_and_coordinates():
    for term in ("San Francisco", "Kern County", "San Jose", "Buttonwillow"):
        found = search_places(term)["results"]
        assert found and term.lower() in found[0]["name"].lower()
        assert -125 < found[0]["location"]["lon"] < -113
    point = search_places("37.77, -122.42")["results"][0]
    assert point["kind"] == "Coordinates"
    assert point["location"] == {"lat": 37.77, "lon": -122.42}
    assert search_places("no-such-place-zzzz")["results"] == []
    with pytest.raises(ValueError):
        search_places("50.0, 100.0")


def test_stream_delivers_processed_batch_before_fetching_next_page(monkeypatch):
    calls = []
    def page(region, bounds, offset, bucket):
        calls.append(offset)
        features = [{"type": "Feature", "geometry": mapping(box(-120, 35, -119, 36)),
            "properties": {"OBJECTID": offset + i, "Code": "A", "Date": "2022", "New_Class": "Agricultural"}} for i in range(50 if offset == 0 else 1)]
        return {"type": "FeatureCollection", "features": features}
    monkeypatch.setattr(zoning, "_stream_page", page)
    stream = zoning.stream_zoning(FOOTPRINT)
    assert json.loads(next(stream))["type"] == "start"
    assert calls == []
    batch = json.loads(next(stream))
    assert batch["type"] == "features" and batch["loaded"] == 50
    assert calls == [0]  # next page has not been fetched while this batch is ready
    for feature in batch["features"]:
        clipped = shape(feature["geometry"])
        assert clipped.area < 0.001
        assert shape(FOOTPRINT).buffer(0.00001).covers(clipped)
        assert feature["properties"]["Date"] == "2022"
    tail = [json.loads(line) for line in stream]
    assert calls == [0, 50]
    assert tail[-1]["metadata"]["status"] == "available"
    assert tail[-1]["loaded"] == 51


def test_stream_preserves_partial_results_when_later_page_fails(monkeypatch):
    def page(region, bounds, offset, bucket):
        if offset:
            raise ValueError("provider down")
        return {"type": "FeatureCollection", "features": [{"type": "Feature", "geometry": FOOTPRINT, "properties": {"OBJECTID": i}} for i in range(50)]}
    monkeypatch.setattr(zoning, "_stream_page", page)
    events = [json.loads(line) for line in zoning.stream_zoning(FOOTPRINT)]
    assert events[-1]["loaded"] == 50
    assert events[-1]["metadata"]["status"] == "partial"


def test_stream_rejects_large_area_before_response_starts():
    response = TestClient(app).post("/api/explore/zoning/stream", json={"footprint": mapping(box(-120, 35, -119, 36))})
    assert response.status_code == 422
    assert "100 km" in response.text


def test_search_endpoint_is_local_and_validated():
    client = TestClient(app)
    assert client.get("/api/explore/search?q=Fresno").json()["results"][0]["name"] == "Fresno"
    assert client.get("/api/explore/search?q=x").status_code == 422
