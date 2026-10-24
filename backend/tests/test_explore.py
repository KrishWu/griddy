"""Explore (workstream A) tests: layers, site summary, router.  OWNER: workstream A.

Asserts ranges and invariants, not exact numbers: the OSM substation layer changes
whenever it is refreshed.
"""

from __future__ import annotations

import gzip
import json
import math
import re
import shutil
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
SANTA_BARBARA = LngLat(lon=-119.68, lat=34.43)  # SCE territory: bulk lines are 220 kV
TEHACHAPI = LngLat(lon=-118.40, lat=35.05)
FUELS = {"solar", "wind", "gas", "hydro", "geothermal", "battery", "nuclear", "other"}
CA_BBOX = (-124.6, 32.3, -113.9, 42.2)  # substations reach 2 km into neighboring states


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


def test_no_substations_in_mexico():
    # The CA-Mexico line runs straight from the Pacific (-117.124, 32.534) to the Colorado River
    # (-114.719, 32.718); as a geodesic it bows north of this lon/lat chord, so US points are north of it.
    def border_lat(lon: float) -> float:
        return 32.534 + (lon + 117.124) / (117.124 - 114.719) * (32.718 - 32.534)

    for f in get_layer("substations")["features"]:
        lon, lat = f["geometry"]["coordinates"]
        if -117.124 <= lon <= -114.719:
            assert lat >= border_lat(lon), f["properties"]["id"]


def test_bare_osm_nodes_carry_no_voltage():
    # A node with no name, ref, operator or substation type and a "voltage" is a transformer's kVA rating.
    for f in get_layer("substations")["features"]:
        p = f["properties"]
        if p["id"].startswith("osm-n") and p["name"] == "Unnamed substation" and not p["operator"] and not p["substation_type"]:
            assert p["voltage_kv"] is None, p["id"]


def test_line_labels_agree_with_voltage():
    for f in get_layer("transmission")["features"]:
        p = f["properties"]
        m = re.search(r"(\d+(?:\.\d+)?)\s*kV", p["name"], re.IGNORECASE)
        assert m is None or float(m.group(1)) == p["voltage_kv"], (p["id"], p["name"], p["voltage_kv"])
        if p["owner"] == "TRANS BAY CABLE":  # +/-200 kV HVDC
            assert "DC" in p["voltage_label"], p


def test_plant_grid_voltages_are_in_kv():
    volts = {208.0, 240.0, 277.0, 416.0, 480.0, 481.0, 600.0}  # service voltages entered in volts
    assert not [f["properties"]["id"] for f in get_layer("plants")["features"] if f["properties"]["grid_voltage_kv"] in volts]


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
    stats = s.extras["plants_within_25km"]
    assert set(stats["by_fuel_mw"]) <= FUELS
    assert sum(stats["by_fuel_mw"].values()) == pytest.approx(stats["total_mw"], abs=0.5)
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


@pytest.mark.parametrize("site", [SANTA_BARBARA, TEHACHAPI], ids=["santa_barbara", "tehachapi"])
def test_sce_220kv_counts_as_high_voltage(site: LngLat):
    s = summarize_site(site)
    _check_summary_invariants(s)
    assert s.nearest_line_kv is not None and s.nearest_line_kv >= 220
    assert s.nearest_line_km is not None and s.nearest_line_km < 15
    assert s.extras["nearest_hv_substation"]["voltage_kv"] >= 220
    assert s.extras["nearest_hv_substation"]["distance_km"] < 30


@pytest.mark.parametrize("site", [LngLat(lon=-122.385, lat=37.757), LngLat(lon=-121.88, lat=38.04)], ids=["potrero", "pittsburg"])
def test_trans_bay_hvdc_cable_is_never_the_nearest_line(site: LngLat):
    s = summarize_site(site)
    for key in ("nearest_line", "nearest_any_line"):
        line = s.extras[key]
        assert line["owner"] != "TRANS BAY CABLE" and "DC" not in line["voltage_label"], (key, line)


def test_hybrid_plants_are_split_by_generator():
    s = summarize_site(LngLat(lon=-121.78, lat=36.81))  # Moss Landing: 2,148 MW gas + 750 MW battery hybrid
    mix = s.extras["plants_within_25km"]["by_fuel_mw"]
    assert mix["battery"] > 750 and mix["gas"] < 2000
    found = {f.id: f for f in s.findings}
    assert "hybrid" in found["nearby_generation"].detail


def test_substation_list_has_one_entry_per_site():
    s = summarize_site(LngLat(lon=-122.40, lat=37.78))  # San Francisco: Embarcadero is mapped twice in OSM
    named = [x["name"] for x in s.nearest_substations[:3] if not x["name"].startswith("Unnamed")]
    assert len(named) == len(set(named)), named


@pytest.mark.parametrize(
    "site",
    [
        LngLat(lon=-122.30, lat=37.70),  # SF Bay
        LngLat(lon=-122.40, lat=38.05),  # San Pablo Bay
        LngLat(lon=-120.74665, lat=39.00337),  # Oxbow plant, in a gap between El Dorado and Placer
        LngLat(lon=-118.27262, lat=33.71911),  # AltaSea plant, Port of Los Angeles
    ],
    ids=["sf_bay", "san_pablo_bay", "county_gap", "harbor"],
)
def test_bays_and_county_gaps_are_in_california(site: LngLat):
    s = summarize_site(site)
    _check_summary_invariants(s)
    assert s.extras["in_california"] is True and s.site.county
    assert s.site.name.startswith("Site in ")
    assert s.population_within_10km is not None
    assert "outside_california" not in {f.id for f in s.findings}


@pytest.mark.parametrize(
    "a,b",
    [(KERN, LngLat(lon=-119.47, lat=35.85)), (KERN, LngLat(lon=-118.92, lat=35.40)), (TRACY, LngLat(lon=-121.10, lat=38.00))],
    ids=["north", "east", "diagonal"],
)
def test_albers_distance_matches_haversine(a: LngLat, b: LngLat):
    want = _haversine_km(a, b)
    assert 40 < want < 60
    assert distance_km(a, b) == pytest.approx(want, rel=0.01)


@pytest.mark.parametrize("site", [RENO, PACIFIC, LngLat(lon=-114.60, lat=32.70)], ids=["reno", "pacific", "yuma_az"])
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
# Interconnection queue (LBNL Queued Up, aggregated by county)
# ---------------------------------------------------------------------------

QUEUE_KEYS = {
    "county", "active_projects", "active_mw", "generation_mw", "storage_mw", "ia_executed_projects", "ia_executed_mw",
    "by_type_mw", "largest", "rank", "counties_ranked", "statewide_active_mw", "source", "as_of", "url",
}  # fmt: skip


def _queue_finding(s: SiteSummary):
    return next((f for f in s.findings if f.id == "interconnection_queue"), None)


def test_queue_at_demo_site():
    s = summarize_site(KERN)
    _check_summary_invariants(s)
    qc = s.extras["queue_county"]
    assert QUEUE_KEYS <= set(qc) and qc["county"] == "Kern"
    assert qc["active_mw"] > 10_000 and qc["rank"] <= 3 and qc["counties_ranked"] == 58
    assert 0 < qc["ia_executed_projects"] <= qc["active_projects"]
    assert 0 < qc["ia_executed_mw"] <= qc["active_mw"] < qc["statewide_active_mw"]
    assert sum(qc["by_type_mw"].values()) == pytest.approx(qc["active_mw"], abs=1)
    assert 1 <= len(qc["largest"]) <= 3 and qc["url"].startswith("https://") and qc["as_of"]
    assert all(p["name"] is None or p["name"] != p["name"].upper() for p in qc["largest"])  # ALL CAPS title-cased
    f = _queue_finding(s)
    assert f is not None and f.module == "explore" and f.severity == "warn"
    assert f.metric == qc["active_mw"]
    assert f.title.startswith("Kern County: ") and "active interconnection requests" in f.title and "GW" in f.title
    assert "Midway" in f.detail and "nearest 220 kV+ substation" in f.detail and "13%" in f.detail
    queue_prov = [p for p in s.provenance if p.source.startswith("LBNL Queued Up")]
    assert len(queue_prov) == 1 and queue_prov[0].kind == "observed" and queue_prov[0].url == qc["url"]
    assert "queue" not in s.extras["missing_data"]


@pytest.mark.parametrize("site", [TRACY, LOS_BANOS], ids=["san_joaquin", "merced"])
def test_queue_at_candidate_sites(site: LngLat):
    s = summarize_site(site)
    qc = s.extras["queue_county"]
    assert qc["county"] == s.site.county and qc["active_projects"] > 0 and 1 <= qc["rank"] <= 58
    f = _queue_finding(s)
    assert f is not None and f.severity == ("warn" if qc["active_mw"] >= 10_000 else "info")
    assert f.title.startswith(f"{s.site.county} County: ")


def test_substation_key_and_line_heuristics():
    assert service._substation_key("Midway Substation") == "midway"
    assert service._substation_key("Los Banos Substation") == "los banos"
    assert service._substation_key("230kV Switching Station") is None  # a voltage names nothing
    assert service._substation_key("500 kV Tesla Substation") == "tesla"
    assert service._poi_is_line("DELEVAN-CORTINA")
    assert service._poi_is_line("Midway-Kern Line #2")
    assert not service._poi_is_line("Vaca-Dixon 230 kV")
    assert not service._poi_is_line("Midway 230 kV")


def test_voltage_named_substation_claims_no_queue_poi():
    # Nearest 220 kV+ substation is SCE's "230kV Switching Station" (Torrance); it must not match
    # LADWP's "Haynes 230kV Switchyard" in the LA County top-3 list.
    s = summarize_site(LngLat(lon=-118.37, lat=33.86))
    f = _queue_finding(s)
    assert f is not None and "nearest 220 kV+" not in f.detail


def test_county_without_queue_requests_gets_info_finding():
    s = summarize_site(SANTA_BARBARA)  # no active requests in Santa Barbara County
    qc = s.extras["queue_county"]
    assert qc["county"] == "Santa Barbara" and qc["active_projects"] == 0 and qc["active_mw"] == 0 and qc["largest"] == []
    f = _queue_finding(s)
    assert f is not None and f.severity == "info" and f.metric == 0
    assert f.title == "No active interconnection requests in Santa Barbara County"


@pytest.mark.parametrize("site", [RENO, PACIFIC], ids=["reno", "pacific"])
def test_queue_outside_california(site: LngLat):
    s = summarize_site(site)
    assert s.extras["queue_county"] is None
    assert _queue_finding(s) is None
    assert not any(p.source.startswith("LBNL Queued Up") for p in s.provenance)


def test_boundaries_carry_queue_properties():
    feats = get_layer("boundaries")["features"]
    for f in feats:
        p = f["properties"]
        assert isinstance(p["queue_active_mw"], float) and p["queue_active_mw"] >= 0, p
        assert isinstance(p["queue_active_projects"], int) and p["queue_active_projects"] >= 0, p
        assert isinstance(p["queue_ia_executed_mw"], float) and 0 <= p["queue_ia_executed_mw"] <= p["queue_active_mw"], p
    statewide = service._queue().statewide_active_mw
    assert statewide > 50_000
    assert sum(f["properties"]["queue_active_mw"] for f in feats) == pytest.approx(statewide, rel=0.001)
    kern = next(f["properties"] for f in feats if f["properties"]["name"] == "Kern")
    assert kern["queue_active_mw"] == summarize_site(KERN).extras["queue_county"]["active_mw"]
    served = json.loads(service.layer_bytes("boundaries"))["features"]  # the ETag'd bytes include the join
    assert all("queue_active_mw" in f["properties"] for f in served)


def test_readable_project_names():
    assert service._readable("SANBORN HYBRID 3") == "Sanborn Hybrid 3"
    assert service._readable("POTENTIA-VIRIDI") == "Potentia-Viridi"
    assert service._readable("LASSEN LODGE HYDROELECTRIC II") == "Lassen Lodge Hydroelectric II"
    assert service._readable("Carissalito Creek") == "Carissalito Creek"  # mixed case is left alone


@pytest.fixture(params=["missing", "corrupt", "wrong_shape"])
def no_queue(request: pytest.FixtureRequest, monkeypatch: pytest.MonkeyPatch, tmp_path) -> Iterator[None]:
    """Only the counties layer, plus a missing / corrupt / malformed queue file."""
    shutil.copy(service.EXPLORE_DIR / service._DATASETS["boundaries"]["file"], tmp_path)
    if request.param == "corrupt":
        (tmp_path / service.QUEUE_FILE).write_text('{"counties": {"Kern": ', encoding="utf-8")
    elif request.param == "wrong_shape":
        (tmp_path / service.QUEUE_FILE).write_text('[{"county": "Kern"}]', encoding="utf-8")
    monkeypatch.setattr(service, "EXPLORE_DIR", tmp_path)
    service.clear_caches()
    yield
    monkeypatch.undo()
    service.clear_caches()


def test_missing_queue_degrades_gracefully(no_queue: None):
    s = summarize_site(KERN)
    assert SiteSummary.model_validate_json(s.model_dump_json()) == s
    assert s.site.county == "Kern"
    assert s.extras["queue_county"] is None and "queue" in s.extras["missing_data"]
    assert _queue_finding(s) is None
    assert not any(p.source.startswith("LBNL Queued Up") for p in s.provenance)
    feats = get_layer("boundaries")["features"]
    assert len(feats) == 58 and not any(k.startswith("queue_") for f in feats for k in f["properties"])
    assert service.layer_info()["queue"]["available"] is False
    assert client.get("/api/explore/queue").status_code == 404


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


def test_queue_endpoint():
    r = client.get("/api/explore/queue", headers={"Accept-Encoding": "gzip"})
    assert r.status_code == 200 and r.headers["content-type"].startswith("application/json")
    assert r.headers["cache-control"] == "public, max-age=300" and r.headers["content-encoding"] == "gzip"
    body = r.json()
    assert len(body["counties"]) == 58 and body["statewide"]["active_mw"] > 50_000
    assert body["as_of"] and body["page_url"].startswith("https://") and "CC BY" in body["license"]
    assert client.get("/api/explore/queue", headers={"If-None-Match": r.headers["etag"]}).status_code == 304
    info = client.get("/api/explore/layers").json()["queue"]
    assert info["layer"] is False and info["available"] is True and info["count"] == 58 and info["updated"] == body["as_of"]
