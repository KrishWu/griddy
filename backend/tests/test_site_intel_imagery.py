"""Satellite overlay: offline tiles, path safety and graceful degradation.  OWNER: workstream E."""

import pytest

from app.contract import LngLat
from app.site_intel import earthengine, imagery
from app.site_intel.config import DEMO_SITES, TILES

KERN = DEMO_SITES["kern"]["location"]


@pytest.fixture
def no_ee(monkeypatch):
    monkeypatch.delenv("EE_PROJECT", raising=False)


def test_tile_path_serves_committed_tiles_only():
    png = next(TILES.glob("*/*/*.png"))
    z, x, y = int(png.parent.parent.name), int(png.parent.name), int(png.stem)
    assert imagery.tile_path(z, x, y) == png.resolve()
    assert imagery.tile_path(z, x + 10_000, y) is None
    for bad in ((-1, 0, 0), (3, 8, 0), (3, 0, -1), (23, 0, 0)):
        assert imagery.tile_path(*bad) is None
    assert imagery.tile_path("..", 0, 0) is None  # type: ignore[arg-type]


def test_meta_covers_the_demo_site():
    meta = imagery.tiles_meta()
    w, s, e, n = meta["bounds"]
    assert w < KERN.lon < e and s < KERN.lat < n
    assert meta["attribution"] and meta["source"]


def test_offline_overlay_for_demo_site(no_ee):
    overlays, prov, findings = imagery.imagery_overlays(KERN)
    assert [o.url for o in overlays] == ["/api/site/tiles/{z}/{x}/{y}.png"]
    assert overlays[0].type == "raster" and overlays[0].attribution
    assert prov and prov[0].kind == "observed"
    assert findings == []


def test_far_site_gets_info_finding(no_ee):
    overlays, _, findings = imagery.imagery_overlays(LngLat(lon=-100.0, lat=40.0))
    assert overlays == [] and [f.id for f in findings] == ["imagery_unavailable"]


def test_live_failure_falls_back_to_cache(monkeypatch):
    def boom(*_a, **_k):
        raise earthengine.EEUnavailable("timed out")

    monkeypatch.setattr(earthengine, "get_ee", lambda: object())
    monkeypatch.setattr(earthengine, "run", boom)
    overlays, _, _ = imagery.imagery_overlays(KERN)
    assert overlays and overlays[0].url == "/api/site/tiles/{z}/{x}/{y}.png"

    def worse(*_a, **_k):
        raise RuntimeError("unexpected")

    monkeypatch.setattr(earthengine, "get_ee", worse)
    assert imagery.imagery_overlays(KERN)[0]  # still the cached overlay, no exception
