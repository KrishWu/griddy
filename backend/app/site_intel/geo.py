"""Small pure-Python geometry helpers (no shapely at runtime).  OWNER: workstream E."""

from __future__ import annotations

import math
from typing import Any

from app.contract import LngLat

EARTH_KM = 6371.0088


def haversine_km(a: LngLat, b: LngLat) -> float:
    p1, p2 = math.radians(a.lat), math.radians(b.lat)
    dp, dl = p2 - p1, math.radians(b.lon - a.lon)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_KM * math.asin(min(1.0, math.sqrt(h)))


def circle_feature(center: LngLat, radius_km: float, properties: dict[str, Any] | None = None, n: int = 64) -> dict[str, Any]:
    """GeoJSON Feature: a geodesic circle approximated by an n-gon."""
    lat0, lon0 = math.radians(center.lat), math.radians(center.lon)
    d = radius_km / EARTH_KM
    ring = []
    for i in range(n + 1):
        brg = 2 * math.pi * (i % n) / n
        lat = math.asin(math.sin(lat0) * math.cos(d) + math.cos(lat0) * math.sin(d) * math.cos(brg))
        lon = lon0 + math.atan2(math.sin(brg) * math.sin(d) * math.cos(lat0), math.cos(d) - math.sin(lat0) * math.sin(lat))
        ring.append([round(math.degrees(lon), 6), round(math.degrees(lat), 6)])
    return {"type": "Feature", "geometry": {"type": "Polygon", "coordinates": [ring]}, "properties": properties or {}}


def _in_ring(lon: float, lat: float, ring: list[list[float]]) -> bool:
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if (yi > lat) != (yj > lat) and lon < (xj - xi) * (lat - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def point_in_geometry(loc: LngLat, geometry: dict[str, Any]) -> bool:
    """Point-in-polygon for GeoJSON Polygon / MultiPolygon (holes respected)."""
    polys = geometry["coordinates"] if geometry["type"] == "MultiPolygon" else [geometry["coordinates"]]
    for rings in polys:
        if rings and _in_ring(loc.lon, loc.lat, rings[0]) and not any(_in_ring(loc.lon, loc.lat, h) for h in rings[1:]):
            return True
    return False


def lonlat_to_tile(lon: float, lat: float, z: int) -> tuple[int, int]:
    """Web-Mercator XYZ tile containing the point."""
    n = 2**z
    x = int((lon + 180.0) / 360.0 * n)
    lat_r = math.radians(max(-85.0511, min(85.0511, lat)))
    y = int((1.0 - math.asinh(math.tan(lat_r)) / math.pi) / 2.0 * n)
    return min(max(x, 0), n - 1), min(max(y, 0), n - 1)
