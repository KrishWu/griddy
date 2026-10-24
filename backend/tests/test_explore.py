"""Explore (workstream A) tests: layers, site summary, router.  OWNER: workstream A.

Asserts ranges and invariants, not exact numbers: the OSM substation layer changes
whenever it is refreshed.
"""

from __future__ import annotations

import gzip
import json
import math
import time
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from app.contract import LngLat, SiteSummary
from app.explore import service
from app.explore.service import LAYERS, distance_km, get_layer, summarize_site
from app.main import app

client = TestClient(app)

KERN = LngLat(lon=-119.47, lat=35.40)  # demo-site placeholder
TRACY = LngLat(lon=-121.55, lat=37.71)
LOS_BANOS = LngLat(lon=-120.85, lat=37.06)
RENO = LngLat(lon=-119.81, lat=39.53)
PACIFIC = LngLat(lon=-126.0, lat=36.0)
FUELS = {"solar", "wind", "gas", "hydro", "geothermal", "battery", "nuclear", "other"}
CA_BBOX = (-124.6, 32.3, -113.9, 42.2)  # substations reach 2 km past the state line


def _in_bbox(lon: float, lat: float) -> bool:
    return CA_BBOX[0] <= lon <= CA_BBOX[2] and CA_BBOX[1] <= lat <= CA_BBOX[3]


def _haversine_km(a: LngLat, b: LngLat) -> float:
    r = 6371.0088
    p1, p2 = math.radians(a.lat), math.radians(b.lat)
    dp, dl = p2 - p1, math.radians(b.lon - a.lon)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


# ---------------------------------------------------------------------------
# Layers
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("layer", LAYERS)
def test_every_layer_is_a_nonempty_feature_collection(layer: str):
    fc = get_layer(layer)
    assert fc["type"] == "FeatureCollection"
    assert fc["features"], f"{layer} is empty"
    ids = []
    for f in fc["features"]:
        props = f["properties"]
        assert isinstance(props["id"], str) and props["id"], props
        assert isinstance(props["name"], str) and props["name"].strip(), props
        assert props.get("source"), props
        ids.append(props["id"])
    assert len(ids) == len(set(ids)), f"duplicate ids in {layer}"


def test_plants_have_fuel_capacity_and_ca_points():
    feats = get_layer("plants")["features"]
    assert 1000 < len(feats) < 3000
    for f in feats:
        p = f["properties"]
        assert p["fuel"] in FUELS
        assert p["capacity_mw"] >= 1
        assert f["geometry"]["type"] == "Point" and _in_bbox(*f["geometry"]["coordinates"])
    assert 60_000 < sum(f["properties"]["capacity_mw"] for f in feats) < 120_000


def test_lines_and_substations_have_voltage():
    for f in get_layer("transmission")["features"]:
        assert f["properties"]["voltage_kv"] >= 69
        assert f["geometry"]["type"] in ("LineString", "MultiLineString")
    subs = get_layer("substations")["features"]
    assert len(subs) > 1000
    for f in subs:
        kv = f["properties"]["voltage_kv"]
        assert kv is None or kv > 0
        assert f["geometry"]["type"] == "Point" and _in_bbox(*f["geometry"]["coordinates"])


def test_boundaries_are_the_58_counties():
    names = {f["properties"]["name"] for f in get_layer("boundaries")["features"]}
    assert len(names) == 58 and {"Kern", "Los Angeles", "San Francisco"} <= names


def test_unknown_layer_is_empty():
    assert get_layer("nope") == {"type": "FeatureCollection", "features": []}


def test_layer_bytes_match_get_layer():
    for layer in LAYERS:
        raw = service.layer_bytes(layer)
        assert json.loads(raw) == get_layer(layer)
        assert gzip.decompress(service.layer_gzip(layer)) == raw


# ---------------------------------------------------------------------------
# summarize_site
# ---------------------------------------------------------------------------


def _check_summary_invariants(s: SiteSummary) -> None:
    assert SiteSummary.model_validate_json(s.model_dump_json()) == s
    json.dumps(s.model_dump(), allow_nan=False)  # plain JSON: no NaN, no numpy scalars
    subs = [x["distance_km"] for x in s.nearest_substations]
    assert subs == sorted(subs) and len(subs) <= 4
    for x in s.nearest_substations:
        assert {"id", "name", "voltage_kv", "distance_km", "location", "operator", "substation_type", "osm_url"} <= set(x)
    plants = [x["distance_km"] for x in s.nearby_plants]
    assert plants == sorted(plants) and len(plants) <= 30
    assert all(d <= 25 for d in plants)
    assert all(x["fuel"] in FUELS for x in s.nearby_plants)
    ids = [f.id for f in s.findings]
    assert len(ids) == len(set(ids))
    assert all(f.module == "explore" for f in s.findings)
    assert any(f.needs_utility_study for f in s.findings)
    assert {p.kind for p in s.provenance} >= {"observed", "inferred"}


def test_summary_at_demo_site():
    s = summarize_site(KERN)
    _check_summary_invariants(s)
    assert s.site.county == "Kern"
    assert s.site.name == "Site in Kern County, CA"
    assert s.site.balancing_authority == "CAISO"
    assert s.site.utility_territory == "PG&E"
    assert s.nearest_substations and s.nearest_substations[0]["distance_km"] < 50
    assert s.nearest_line_km is not None and 0 <= s.nearest_line_km < 50
    assert s.nearest_line_kv is not None and s.nearest_line_kv >= 230
    hv = s.extras["nearest_hv_substation"]
    assert hv["voltage_kv"] >= 230 and hv["id"] in {x["id"] for x in s.nearest_substations}
    assert s.extras["in_california"] is True
    assert s.extras["nearest_line"]["voltage_kv"] == s.nearest_line_kv
    stats = s.extras["plants_within_25km"]
    assert stats["count"] >= len(s.nearby_plants) and stats["total_mw"] > 0
    assert s.population_within_10km is not None and s.population_within_10km >= 0
    found = {f.id: f for f in s.findings}
    assert found["hv_substation_distance"].severity == "info"
    assert found["hv_substation_distance"].metric == hv["distance_km"]
    assert found["grid_capacity_unverified"].needs_utility_study
    assert "outside_california" not in found


@pytest.mark.parametrize("site", [TRACY, LOS_BANOS], ids=["tracy", "los_banos"])
def test_summary_at_candidate_sites(site: LngLat):
    s = summarize_site(site)
    _check_summary_invariants(s)
    assert s.site.county and s.extras["in_california"] is True
    assert s.nearest_substations[0]["distance_km"] < 50
    assert s.nearest_line_km is not None and s.nearest_line_km < 50 and s.nearest_line_kv >= 230


def test_nearest_line_is_operational_ac():
    s = summarize_site(KERN)
    line = next(f for f in get_layer("transmission")["features"] if f["properties"]["id"] == s.extras["nearest_line"]["id"])
    assert line["properties"]["operational"] is True and "DC" not in line["properties"]["voltage_label"]


@pytest.mark.parametrize(
    "a,b",
    [(KERN, LngLat(lon=-119.47, lat=35.85)), (KERN, LngLat(lon=-118.92, lat=35.40)), (TRACY, LngLat(lon=-121.10, lat=38.00))],
    ids=["north", "east", "diagonal"],
)
def test_albers_distance_matches_haversine(a: LngLat, b: LngLat):
    want = _haversine_km(a, b)
    assert 40 < want < 60
    assert distance_km(a, b) == pytest.approx(want, rel=0.01)


@pytest.mark.parametrize("site", [RENO, PACIFIC], ids=["reno", "pacific"])
def test_outside_california_degrades_cleanly(site: LngLat):
    s = summarize_site(site)
    assert SiteSummary.model_validate_json(s.model_dump_json()) == s
    assert s.site.county is None and s.site.name == "Site outside California"
    assert s.extras["in_california"] is False
    assert s.population_within_10km is None
    found = {f.id: f for f in s.findings}
    assert found["outside_california"].severity == "warn"
    assert found["grid_capacity_unverified"].needs_utility_study


def test_far_offshore_has_no_hv_substation_nearby():
    found = {f.id: f for f in summarize_site(PACIFIC).findings}
    assert found["hv_substation_distance"].severity == "fail"


def test_non_caiso_balancing_authority_is_flagged():
    s = summarize_site(LngLat(lon=-118.24, lat=34.05))  # downtown Los Angeles (LADWP)
    assert s.site.balancing_authority == "LADWP"
    assert any(f.id == "non_caiso_balancing_authority" and f.severity == "warn" for f in s.findings)


def test_warm_summary_is_fast_and_returns_independent_copies():
    summarize_site(KERN)  # warm the indexes
    t0 = time.perf_counter()
    first = summarize_site(LngLat(lon=-120.123, lat=36.456))  # new location: not cached
    uncached = time.perf_counter() - t0
    t0 = time.perf_counter()
    second = summarize_site(LngLat(lon=-120.123, lat=36.456))
    cached = time.perf_counter() - t0
    assert uncached < 0.2 and cached < 0.2
    assert first == second and first is not second
    snapshot = first.model_dump()
    first.nearest_substations.clear()
    first.extras["plants_within_25km"]["count"] = -1
    first.site.county = "Mutated"
    assert summarize_site(LngLat(lon=-120.123, lat=36.456)).model_dump() == snapshot


@pytest.fixture
def no_data(monkeypatch: pytest.MonkeyPatch, tmp_path) -> Iterator[None]:
    monkeypatch.setattr(service, "EXPLORE_DIR", tmp_path)
    service.clear_caches()
    yield
    monkeypatch.undo()
    service.clear_caches()


def test_missing_data_files_degrade_gracefully(no_data: None):
    for layer in LAYERS:
        assert get_layer(layer) == {"type": "FeatureCollection", "features": []}
        assert json.loads(service.layer_bytes(layer))["features"] == []
    s = summarize_site(KERN)
    assert SiteSummary.model_validate_json(s.model_dump_json()) == s
    assert s.nearest_substations == [] and s.nearby_plants == []
    assert s.nearest_line_km is None and s.population_within_10km is None
    assert any(f.id == "grid_capacity_unverified" for f in s.findings)
    assert set(s.extras["missing_data"]) >= set(LAYERS)
    assert all(not info["available"] for info in service.layer_info().values())
    assert service.fallback_style_path() is None


# ---------------------------------------------------------------------------
# Router
# ---------------------------------------------------------------------------


def test_layer_endpoint_gzip_etag_and_304():
    raw = service.layer_bytes("plants")
    r = client.get("/api/layers/plants", headers={"Accept-Encoding": "gzip"})
    assert r.status_code == 200
    assert r.headers["content-encoding"] == "gzip"
    assert "accept-encoding" in r.headers["vary"].lower()
    assert r.headers["cache-control"] == "public, max-age=300"
    assert int(r.headers["content-length"]) < len(raw) / 3
    assert r.content == raw  # httpx decodes gzip
    etag = r.headers["etag"]

    not_modified = client.get("/api/layers/plants", headers={"If-None-Match": etag})
    assert not_modified.status_code == 304 and not_modified.content == b""
    assert not_modified.headers["etag"] == etag
    assert client.get("/api/layers/plants", headers={"If-None-Match": '"stale"'}).status_code == 200

    plain = client.get("/api/layers/plants", headers={"Accept-Encoding": "identity"})
    assert plain.status_code == 200 and "content-encoding" not in plain.headers
    assert plain.content == raw and plain.headers["etag"] == etag
    refused = client.get("/api/layers/plants", headers={"Accept-Encoding": "gzip;q=0, *"})
    assert "content-encoding" not in refused.headers


def test_unknown_layer_is_404():
    r = client.get("/api/layers/nope")
    assert r.status_code == 404 and "Unknown layer" in r.json()["detail"]


def test_site_summary_endpoint_validates_coordinates():
    assert client.get("/api/site/summary", params={"lon": -119.47, "lat": 200}).status_code == 422
    assert client.get("/api/site/summary", params={"lon": -181, "lat": 35}).status_code == 422
    assert client.get("/api/site/summary", params={"lon": "nan", "lat": 35}).status_code == 422
    r = client.get("/api/site/summary", params={"lon": KERN.lon, "lat": KERN.lat})
    assert r.status_code == 200
    assert SiteSummary.model_validate(r.json()).site.county == "Kern"


def test_explore_layers_endpoint():
    info = client.get("/api/explore/layers").json()
    for layer in LAYERS:
        assert info[layer]["layer"] is True and info[layer]["count"] > 0
        assert info[layer]["source"] and info[layer]["license"] and info[layer]["url"]
    assert info["population"]["layer"] is False and info["population"]["count"] > 20_000


def test_fallback_style_endpoint():
    r = client.get("/api/explore/fallback-style")
    if service.fallback_style_path() is None:
        assert r.status_code == 404
    else:
        assert r.status_code == 200 and isinstance(r.json(), dict)
