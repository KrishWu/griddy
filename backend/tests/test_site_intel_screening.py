"""Site-intel foundations: cache keys, geometry helpers and land-screening thresholds.  OWNER: workstream E."""

import math

import pytest

from app.contract import LngLat
from app.site_intel.config import key_center, site_key
from app.site_intel.geo import circle_feature, haversine_km, lonlat_to_tile, point_in_geometry
from app.site_intel.screening import LandStats, land_findings


def stats(**kw) -> LandStats:
    return LandStats(method="open_data", computed_at="2026-10-23", **kw)


def ids(findings) -> dict[str, str]:
    return {f.id: f.severity for f in findings}


def test_site_key_rounds_to_hundredths_and_round_trips():
    assert site_key(LngLat(lon=-119.4712, lat=35.4049)) == "35.40,-119.47"
    assert site_key(LngLat(lon=-0.001, lat=0.001)) == "0.00,0.00"  # no "-0.00"
    c = key_center("35.40,-119.47")
    assert (c.lon, c.lat) == (-119.47, 35.40)


def test_haversine_and_circle():
    sf, la = LngLat(lon=-122.4194, lat=37.7749), LngLat(lon=-118.2437, lat=34.0522)
    assert 550 < haversine_km(sf, la) < 570
    center = LngLat(lon=-119.47, lat=35.40)
    ring = circle_feature(center, 2.0)["geometry"]["coordinates"][0]
    assert ring[0] == ring[-1]
    for lon, lat in ring[:-1]:
        assert haversine_km(center, LngLat(lon=lon, lat=lat)) == pytest.approx(2.0, abs=0.01)


def test_point_in_geometry_respects_holes_and_multipolygons():
    outer = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]
    hole = [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]]
    poly = {"type": "Polygon", "coordinates": [outer, hole]}
    assert point_in_geometry(LngLat(lon=2, lat=2), poly)
    assert not point_in_geometry(LngLat(lon=5, lat=5), poly)
    assert not point_in_geometry(LngLat(lon=11, lat=5), poly)
    multi = {"type": "MultiPolygon", "coordinates": [[outer], [[[20, 20], [21, 20], [21, 21], [20, 21], [20, 20]]]]}
    assert point_in_geometry(LngLat(lon=20.5, lat=20.5), multi)


def test_lonlat_to_tile_matches_slippy_map_formula():
    assert lonlat_to_tile(0.0, 0.0, 0) == (0, 0)
    lon, lat, z = -119.47, 35.40, 14
    x, y = lonlat_to_tile(lon, lat, z)
    n = 2**z
    assert x == math.floor((lon + 180) / 360 * n)
    assert y == math.floor((1 - math.log(math.tan(math.radians(lat)) + 1 / math.cos(math.radians(lat))) / math.pi) / 2 * n)


@pytest.mark.parametrize(
    ("kw", "expect"),
    [
        ({"mean_slope_deg": 1.2}, {"land_slope": "pass"}),
        ({"mean_slope_deg": 7.5}, {"land_slope": "warn"}),
        ({"protected_share": 0.25}, {"land_protected": "fail"}),
        ({"protected_share": 0.03}, {"land_protected": "warn"}),
        ({"water_share": 0.15}, {"land_water": "fail"}),
        ({"water_share": 0.04}, {"land_water": "warn"}),
        ({"land_cover": {"Built-up": 0.4, "Grassland": 0.6}}, {"land_built_up": "fail", "land_cover_summary": "info"}),
        ({"fallow_share": 0.3, "cdl_year": 2025}, {"land_fallow": "pass"}),
        ({"active_crop_share": 0.6}, {"land_farmland_conversion": "warn"}),
        ({"solar_ghi_kwh_m2_day": 5.6}, {"land_solar_resource": "pass"}),
    ],
)
def test_land_findings_thresholds(kw, expect):
    got = ids(land_findings(stats(**kw)))
    for k, sev in expect.items():
        assert got.get(k) == sev, got


def test_clean_flat_fallowed_site_has_no_warnings():
    s = stats(
        land_cover={"Shrubland": 0.5, "Cropland": 0.3, "Bare / sparse vegetation": 0.2},
        mean_slope_deg=0.8,
        fallow_share=0.35,
        active_crop_share=0.05,
        protected_share=0.0,
        water_share=0.0,
        solar_ghi_kwh_m2_day=5.5,
    )
    severities = {f.severity for f in land_findings(s)}
    assert severities <= {"pass", "info"}
    assert all(f.module == "site" for f in land_findings(s))


def test_missing_stats_produce_no_findings():
    assert land_findings(stats()) == []
