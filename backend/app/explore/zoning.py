"""Bounded, cached queries of California LCI's published zoning polygons.

Runtime data is optional. An outage is reported as unavailable, never an invented zone.
Source collection was largely 2021–23; each feature retains its recorded date/source.
"""
from __future__ import annotations

from functools import lru_cache
import json
import math
import time

import httpx
from pydantic import Field
from pyproj import Transformer
from shapely import get_num_coordinates
from shapely.errors import ShapelyError
from shapely.geometry import box, mapping, shape
from shapely.ops import transform

from app.contract import Model
from app.explore.area import area_geometry

SERVICES = {
    "north": "https://services8.arcgis.com/Xr1lDrwMv89PhjD9/arcgis/rest/services/California_Statewide_Zoning_North/FeatureServer/1",
    "south": "https://services8.arcgis.com/Xr1lDrwMv89PhjD9/arcgis/rest/services/California_Statewide_Zoning_South/FeatureServer/0",
}
SOURCE = "California Office of Land Use and Climate Innovation — Statewide Zoning"
MAX_AREA_KM2 = 100
MAX_FEATURES_PER_REGION = 200
MAX_VERTICES = 30000
MAX_RESPONSE_BYTES = 2_000_000
TO_METERS = Transformer.from_crs(4326, 3310, always_xy=True).transform
TO_WGS84 = Transformer.from_crs(3310, 4326, always_xy=True).transform


class ZoningRequest(Model):
    footprint: dict = Field(description="Highlighted project area; maximum 100 km²")


def selected_zoning(footprint: dict) -> dict:
    selection, area = area_geometry(footprint)
    if area > MAX_AREA_KM2:
        raise ValueError("Highlight a smaller area for zoning (maximum 100 km²).")
    fc = zoning(",".join(str(v) for v in selection.bounds))
    return _clip_collection(fc, selection)


def zoning(bbox: str) -> dict:
    try:
        bounds = tuple(float(v) for v in bbox.split(","))
    except ValueError as exc:
        raise ValueError("bbox must be west,south,east,north.") from exc
    if len(bounds) != 4 or not all(math.isfinite(v) for v in bounds):
        raise ValueError("bbox needs four finite coordinates.")
    w, s, e, n = bounds
    if not (-125 <= w < e <= -113 and 32 <= s < n <= 43):
        raise ValueError("Select a California map extent.")
    _, area = area_geometry(mapping(box(w, s, e, n)))
    if area > MAX_AREA_KM2:
        raise ValueError("Highlight a smaller area for zoning (maximum 100 km²).")
    return _query(bounds, int(time.time() // 300))


def _category(properties: dict) -> str:
    text = str(properties.get("New_Class") or properties.get("Description") or "").lower()
    for category, terms in {
        "Residential": ("residen", "family"), "Industrial": ("industr",),
        "Commercial": ("commerc",), "Agricultural": ("agric",),
        "Open space": ("open space", "conservation", "recreation"),
    }.items():
        if any(term in text for term in terms):
            return category
    return "Other"


def _clip_collection(fc: dict, selection) -> dict:
    """Clip before tiling: even one intersecting county-sized zone can be enormous."""
    features, vertices = [], 0
    truncated = fc["metadata"]["truncated"]
    for feature in fc["features"]:
        try:
            geom = shape(feature["geometry"])
            if not geom.is_valid:
                continue
            clipped = geom.intersection(selection)
            if clipped.is_empty or clipped.geom_type not in ("Polygon", "MultiPolygon"):
                continue
            simplified = transform(TO_METERS, clipped).simplify(4, preserve_topology=True)
            simplified = transform(TO_WGS84, simplified).intersection(selection)
            if simplified.is_empty or simplified.geom_type not in ("Polygon", "MultiPolygon"):
                continue
            count = int(get_num_coordinates(simplified))
            if vertices + count > MAX_VERTICES:
                truncated = True
                continue
            vertices += count
            props = {k: feature.get("properties", {}).get(k) for k in ("OBJECTID", "Code", "Description", "Jurisdiction", "New_Class", "Source", "Date")}
            props["category"] = _category(props)
            # Five decimal places is ~1 m here; four-metre generalization is disclosed.
            geometry = json.loads(json.dumps(mapping(simplified)), parse_float=lambda x: round(float(x), 5))
            features.append({"type": "Feature", "id": feature.get("id"), "geometry": geometry, "properties": props})
        except (ValueError, TypeError, KeyError, ShapelyError):
            truncated = True
    meta = {**fc["metadata"], "truncated": truncated, "vertices": vertices,
        "max_area_km2": MAX_AREA_KM2, "simplification_m": 4,
        "rendering": "Clipped to highlighted area and generalized to about 4 m; screening only, not parcel boundaries."}
    if truncated and meta["status"] == "available":
        meta["status"] = "partial"
    return {"type": "FeatureCollection", "features": features, "metadata": meta}


@lru_cache(maxsize=64)
def _query(bounds: tuple, bucket: int) -> dict:
    features, unavailable, truncated = [], [], False
    w, s, e, n = bounds
    regions = [r for r in SERVICES if (r == "north" and n >= 35.78) or (r == "south" and s <= 39.69)]
    with httpx.Client(timeout=12) as client:
        for region in regions:
            try:
                params = {
                    "f": "geojson", "where": "1=1", "geometry": ",".join(map(str, bounds)),
                    "geometryType": "esriGeometryEnvelope", "inSR": 4326, "outSR": 4326,
                    "spatialRel": "esriSpatialRelIntersects", "returnGeometry": "true",
                    "outFields": "OBJECTID,Code,Description,Jurisdiction,New_Class,Source,Date",
                    "resultRecordCount": MAX_FEATURES_PER_REGION, "orderByFields": "OBJECTID", "maxAllowableOffset": 0.00005,
                    "geometryPrecision": 5,
                }
                with client.stream("GET", SERVICES[region] + "/query", params=params) as res:
                    res.raise_for_status()
                    body = bytearray()
                    for chunk in res.iter_bytes():
                        body.extend(chunk)
                        if len(body) > MAX_RESPONSE_BYTES:
                            raise ValueError("Zoning response too large; select a smaller area.")
                    data = json.loads(body)
                if data.get("type") != "FeatureCollection" or not isinstance(data.get("features"), list):
                    raise ValueError("Invalid zoning response")
                rows = data["features"]
                truncated |= len(rows) >= MAX_FEATURES_PER_REGION or bool(data.get("exceededTransferLimit")) or bool(data.get("properties", {}).get("exceededTransferLimit"))
                for f in rows[:MAX_FEATURES_PER_REGION]:
                    if f.get("geometry", {}).get("type") not in ("Polygon", "MultiPolygon"):
                        continue
                    f["id"] = f"{region}-{f.get('properties', {}).get('OBJECTID', len(features))}"
                    features.append(f)
            except (httpx.HTTPError, ValueError, TypeError, KeyError):
                unavailable.append(region)
    return _clip_collection({"type": "FeatureCollection", "features": features,
        "metadata": {"source": SOURCE, "urls": list(SERVICES.values()), "unavailable": unavailable,
            "truncated": truncated, "status": "unavailable" if len(unavailable) == len(regions) else "partial" if unavailable or truncated else "available",
            "caveat": "Historical zoning screening, largely collected 2021–23. Feature Source/Date fields identify vintage. Verify current zoning and allowed uses with the jurisdiction; this layer does not establish permit eligibility."}}, box(w, s, e, n))


def validate_selection(footprint: dict):
    selection, area = area_geometry(footprint)
    w, s, e, n = selection.bounds
    if not (-125 <= w < e <= -113 and 32 <= s < n <= 43):
        raise ValueError("Highlight an area in California.")
    _, envelope_area = area_geometry(mapping(box(w, s, e, n)))
    if max(area, envelope_area) > MAX_AREA_KM2:
        raise ValueError("Highlight a smaller area for zoning (maximum 100 km²).")
    return selection, area


@lru_cache(maxsize=128)
def _stream_page(region: str, bounds: tuple, offset: int, bucket: int):
    params = {"f": "geojson", "where": "1=1", "geometry": ",".join(map(str, bounds)),
        "geometryType": "esriGeometryEnvelope", "inSR": 4326, "outSR": 4326,
        "spatialRel": "esriSpatialRelIntersects", "returnGeometry": "true",
        "outFields": "OBJECTID,Code,Description,Jurisdiction,New_Class,Source,Date",
        "resultRecordCount": 50, "resultOffset": offset, "orderByFields": "OBJECTID",
        "maxAllowableOffset": 0.00005, "geometryPrecision": 5}
    with httpx.Client(timeout=10) as client:
        with client.stream("GET", SERVICES[region] + "/query", params=params) as response:
            response.raise_for_status()
            body = bytearray()
            for chunk in response.iter_bytes():
                body.extend(chunk)
                if len(body) > MAX_RESPONSE_BYTES:
                    raise ValueError("Response too large; highlight a smaller area.")
            data = json.loads(body)
    if data.get("type") != "FeatureCollection" or not isinstance(data.get("features"), list):
        raise ValueError("Zoning provider returned an invalid response.")
    return data


def stream_zoning(footprint: dict):
    """NDJSON: every processed page is delivered before requesting the next one."""
    selection, area = validate_selection(footprint)
    bounds = selection.bounds
    regions = [r for r in SERVICES if (r == "north" and bounds[3] >= 35.78) or (r == "south" and bounds[1] <= 39.69)]
    total, vertices, truncated, unavailable = 0, 0, False, []
    seen = set()
    yield json.dumps({"type": "start", "area_km2": area}) + "\n"
    for region in regions:
        for offset in range(0, MAX_FEATURES_PER_REGION, 50):
            try:
                page = _stream_page(region, bounds, offset, int(time.time() // 300))
                rows = [{**f, "id": f"{region}-{(f.get('properties') or {}).get('OBJECTID', offset + i)}"} for i, f in enumerate(page["features"][:50])]
                clipped = _clip_collection({"features": rows, "metadata": {"truncated": False, "status": "available"}}, selection)
                ready = []
                for feature in clipped["features"]:
                    if feature["id"] in seen:
                        continue
                    count = int(get_num_coordinates(shape(feature["geometry"])))
                    if vertices + count > MAX_VERTICES:
                        truncated = True
                        continue
                    vertices += count
                    seen.add(feature["id"])
                    ready.append(feature)
                total += len(ready)
                truncated |= clipped["metadata"]["truncated"]
                yield json.dumps({"type": "features", "features": ready, "loaded": total}, separators=(",", ":")) + "\n"
                more = len(page["features"]) >= 50 or bool(page.get("exceededTransferLimit"))
                if not more:
                    break
                if offset + 50 >= MAX_FEATURES_PER_REGION or vertices >= MAX_VERTICES:
                    truncated = True
                    break
            except (httpx.HTTPError, ValueError, TypeError, KeyError, ShapelyError):
                unavailable.append(region)
                break
    status = "unavailable" if unavailable and not total else "partial" if unavailable or truncated else "available"
    yield json.dumps({"type": "complete", "loaded": total, "metadata": {"status": status, "truncated": truncated,
        "unavailable": unavailable, "vertices": vertices, "source": SOURCE, "simplification_m": 4}}, separators=(",", ":")) + "\n"
