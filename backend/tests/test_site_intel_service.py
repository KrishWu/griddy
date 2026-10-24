"""site_intel() / site_findings() / E's endpoints, offline (no Earth Engine, no AirNow key).  OWNER: workstream E."""

import json

import pytest
from fastapi.testclient import TestClient

from app.contract import LngLat
from app.main import app
from app.site_intel import imagery, land, service
from app.site_intel.config import DEMO_SITES, TILES

client = TestClient(app)
KERN = DEMO_SITES["kern"]["location"]


@pytest.fixture
def offline(monkeypatch):
    monkeypatch.delenv("EE_PROJECT", raising=False)
    monkeypatch.delenv("AIRNOW_API_KEY", raising=False)


def test_demo_site_screens_offline(offline):
    intel = service.site_intel(KERN)
    assert intel.extras["land_tier"] == "offline_area"
    assert sum(intel.land_cover.values()) == pytest.approx(1.0, abs=0.02)
    assert intel.mean_slope_deg is not None and 0 <= intel.mean_slope_deg < 5
    assert intel.solar_ghi_kwh_m2_day is not None and 4.5 < intel.solar_ghi_kwh_m2_day < 6.5
    kinds = {o.id: o for o in intel.overlays}
    assert kinds["site-buffer"].type == "geojson" and kinds["site-buffer"].data["type"] == "FeatureCollection"
    assert kinds["satellite"].url == "/api/site/tiles/{z}/{x}/{y}.png"
    assert intel.provenance and all(p.source for p in intel.provenance)
    order = {"fail": 0, "warn": 1, "pass": 2, "info": 3}
    assert [order[f.severity] for f in intel.findings] == sorted(order[f.severity] for f in intel.findings)


def test_far_site_degrades_to_findings(offline):
    intel = service.site_intel(LngLat(lon=-100.0, lat=40.0))  # Kansas: outside every offline dataset
    assert intel.land_cover == {}
    assert any(f.id == "land_screening_unavailable" and f.severity == "warn" for f in intel.findings)
    assert not any(o.id == "satellite" for o in intel.overlays)


def test_site_intel_never_raises_when_every_source_breaks(offline, monkeypatch):
    def boom(*_):
        raise RuntimeError("all sources down")

    for mod, name in ((land, "get_land_stats"), (imagery, "imagery_overlays")):
        monkeypatch.setattr(mod, name, boom)
    intel = service.site_intel(KERN)
    assert "land_screening_unavailable" in {f.id for f in intel.findings}


def test_endpoints(offline):
    r = client.get("/api/site/intel", params={"lon": KERN.lon, "lat": KERN.lat})
    assert r.status_code == 200 and r.json()["land_cover"]
    assert client.get("/api/site/intel", params={"lon": -119.47, "lat": 95}).status_code == 422
    assert client.get("/api/site/tiles/3/1/1.png").status_code == 404
    assert client.get("/api/site/tiles/16/-1/0.png").status_code == 404
    meta = json.loads((TILES / "meta.json").read_text())
    png = next(TILES.glob(f"{meta['maxzoom']}/*/*.png"))
    z, x, y = int(png.parent.parent.name), int(png.parent.name), int(png.stem)
    r = client.get(f"/api/site/tiles/{z}/{x}/{y}.png")
    assert r.status_code == 200 and r.headers["content-type"] == "image/png" and r.content[:4] == b"\x89PNG"
