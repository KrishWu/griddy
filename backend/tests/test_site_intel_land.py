"""Land screening: committed demo-area grids, cache tiers and the Earth Engine result parser.  OWNER: workstream E."""

import pytest

from app.contract import LngLat
from app.site_intel import earthengine, land
from app.site_intel.config import DEMO_SITES
from app.site_intel.screening import land_findings


@pytest.fixture
def no_ee(monkeypatch):
    monkeypatch.delenv("EE_PROJECT", raising=False)


@pytest.mark.parametrize("name", list(DEMO_SITES))
def test_every_demo_site_has_a_valid_offline_cell(name):
    s = land.load_area_cell(DEMO_SITES[name]["location"])
    assert s is not None and s.method == "earth_engine" and s.sources
    assert sum(s.land_cover.values()) == pytest.approx(1.0, abs=0.01)
    for v in (s.fallow_share, s.active_crop_share, s.protected_share, s.water_share):
        assert v is not None and 0 <= v <= 1
    assert 0 <= s.mean_slope_deg < 30
    assert 4.5 < s.solar_ghi_kwh_m2_day < 6.5  # California valley floor: ~5-6 kWh/m2/day
    assert s.cdl_year >= 2024


def test_kern_placeholder_is_flat_sunny_farmland():
    findings = {f.id: f.severity for f in land_findings(land.load_area_cell(DEMO_SITES["kern"]["location"]))}
    assert findings["land_slope"] == "pass"
    assert findings["land_solar_resource"] == "pass"


def test_grid_covers_nearby_clicks_but_not_far_ones():
    kern = DEMO_SITES["kern"]["location"]
    assert land.load_area_cell(LngLat(lon=kern.lon + 0.043, lat=kern.lat - 0.048)) is not None  # ~5 km away
    assert land.load_area_cell(LngLat(lon=kern.lon + 0.2, lat=kern.lat)) is None


def test_get_land_stats_tiers(no_ee, monkeypatch, tmp_path):
    assert land.get_land_stats(DEMO_SITES["los_banos"]["location"])[1] == "offline_area"
    far = LngLat(lon=-100.0, lat=40.0)
    assert land.get_land_stats(far) == (None, "unavailable")

    # Runtime cache round trip, then a live call that fails: still never raises.
    monkeypatch.setattr(land, "LAND_CACHE", tmp_path)
    cell = land.load_area_cell(DEMO_SITES["kern"]["location"])
    land._write_cache(far, cell)
    stats, tier = land.get_land_stats(far)
    assert tier == "cache" and stats.land_cover == cell.land_cover

    def boom(*_a, **_k):
        raise earthengine.EEUnavailable("quota")

    monkeypatch.setattr(earthengine, "get_ee", lambda: object())
    monkeypatch.setattr(land, "land_stats_ee", boom)
    assert land.get_land_stats(LngLat(lon=-101.0, lat=40.0)) == (None, "unavailable")


def test_stats_from_raw_parses_earth_engine_output():
    raw = {
        "worldcover": {"40": 600.0, "30": 300.5, "50": 99.5},
        "cdl": {"61": 25.0, "75": 50.0, "176": 25.0},  # fallow, almonds, grassland/pasture
        "cdl_year": 2025,
        "slope": 1.25,
        "protected": 0.0,
        "water": 0.012,
        "ghi_j_m2_day": 20.0e6,
    }
    s = land.stats_from_raw(raw)
    assert s.land_cover == {"Cropland": 0.6, "Grassland": 0.3005, "Built-up": 0.0995}
    assert (s.fallow_share, s.active_crop_share) == (0.25, 0.5)
    assert s.solar_ghi_kwh_m2_day == pytest.approx(5.5556, abs=1e-3)
    assert s.cdl_year == 2025 and s.method == "earth_engine"
    empty = land.stats_from_raw({"worldcover": None, "cdl": {}, "slope": None})
    assert empty.land_cover == {} and empty.fallow_share is None and empty.mean_slope_deg is None
