"""Nearest qualifying grid assets per voltage threshold (app/site_intel/grid_tiers.py).  OWNER: workstream E.

Ranges and invariants only: A's layers will keep changing the numbers.
"""

import json

import numpy as np
import pytest
import shapely

from app.contract import LngLat
from app.explore import service as ex
from app.explore.service import summarize_site
from app.site_intel import grid_tiers, service
from app.site_intel.config import DEMO_SITES

KERN = DEMO_SITES["kern"]["location"]
MOJAVE = LngLat(lon=-117.0, lat=35.0)

needs_layers = pytest.mark.skipif(not (ex._count("substations") and ex._count("transmission")), reason="A's grid layers are not committed")


@pytest.fixture
def offline(monkeypatch):
    monkeypatch.delenv("EE_PROJECT", raising=False)
    monkeypatch.delenv("AIRNOW_API_KEY", raising=False)


@needs_layers
@pytest.mark.parametrize("loc", [KERN, MOJAVE], ids=["kern", "mojave"])
def test_every_tier_qualifies_by_tagged_voltage_and_nests(loc):
    g = grid_tiers.grid_tiers(loc)
    json.dumps(g, allow_nan=False)
    assert g["available"] is True and g["thresholds_kv"] == [69, 115, 220]
    prev = {"substation": 0.0, "line": 0.0}
    for kv in g["thresholds_kv"]:
        t = g["tiers"][str(kv)]
        for kind in ("substation", "line"):
            assert t[f"{kind}_state"] == "available"
            a = t[kind]
            assert a["voltage_kv"] is not None and a["voltage_kv"] >= kv  # never untagged, never lower
            assert a["distance_km"] >= prev[kind] - 1e-9  # a higher threshold can only be farther
            prev[kind] = a["distance_km"]


@needs_layers
def test_220_kv_tier_matches_a_summary():
    s = summarize_site(KERN).extras
    t = grid_tiers.grid_tiers(KERN)["tiers"]["220"]
    assert t["substation"]["distance_km"] == pytest.approx(s["nearest_hv_substation"]["distance_km"])
    assert t["substation"]["name"] == s["nearest_hv_substation"]["name"]
    assert t["line"]["distance_km"] == pytest.approx(s["nearest_line"]["distance_km"])


@needs_layers
def test_closer_untagged_substations_are_reported_not_counted():
    kv, usable = grid_tiers._substation_kv()
    subs = ex._substations()
    tagged = subs.pts.xy[usable & (kv >= 69)]
    # An untagged transmission substation at least 1 km from every tagged 69 kV+ one.
    i = next(int(j) for j in np.flatnonzero(subs.candidate & np.isnan(kv) & usable) if np.hypot(*(tagged - subs.pts.xy[j]).T).min() > 1000)
    lon, lat = subs.pts.lonlat[i]
    t = grid_tiers.grid_tiers(LngLat(lon=float(lon), lat=float(lat)))["tiers"]["69"]
    assert t["substation"]["voltage_kv"] >= 69
    assert t["substation"]["closer_untagged_km"] < t["substation"]["distance_km"]


@needs_layers
def test_distance_is_to_the_line_geometry_not_its_vertices():
    lines = grid_tiers._lines_by_threshold()[115]
    # The longest straight segment of any qualifying line: its midpoint is far from both vertices.
    best = (0.0, None)
    for geom in lines.geoms:
        for part in shapely.get_parts(geom):
            xy = shapely.get_coordinates(part)
            seg = np.hypot(*(xy[1:] - xy[:-1]).T)
            j = int(np.argmax(seg))
            if seg[j] > best[0]:
                best = (float(seg[j]), (xy[j], xy[j + 1]))
    length, (a, b) = best
    assert length > 10_000, "need a segment over 10 km for this test"
    mid = (a + b) / 2
    normal = np.array([-(b - a)[1], (b - a)[0]]) / length
    x, y = mid + 500.0 * normal  # 500 m off the middle of the segment
    lon, lat = ex._to_wgs84().transform(float(x), float(y))
    km = grid_tiers.grid_tiers(LngLat(lon=lon, lat=lat))["tiers"]["115"]["line"]["distance_km"]
    nearest_vertex_km = min(np.hypot(*(a - (x, y))), np.hypot(*(b - (x, y)))) / 1000.0
    assert km <= 0.51 and nearest_vertex_km > 4.0, (km, nearest_vertex_km)


def test_missing_layers_are_unavailable_not_absent(monkeypatch):
    monkeypatch.setattr(ex, "_count", lambda name: 0)
    t = grid_tiers.grid_tiers(KERN)["tiers"]["115"]
    assert t["line_state"] == "unavailable" and t["line"] is None


@needs_layers
def test_site_intel_carries_the_tiers_and_survives_a_broken_search(offline, monkeypatch):
    assert service.site_intel(KERN).extras["grid_tiers"]["available"] is True

    def boom(*_):
        raise RuntimeError("index broken")

    monkeypatch.setattr(grid_tiers, "grid_tiers", boom)
    intel = service.site_intel(KERN)
    assert intel.extras["grid_tiers"] == {"available": False, "reason": "grid search failed"}
    assert not any(f.id == "site_intel_error" for f in intel.findings)
