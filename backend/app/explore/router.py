"""Explore endpoints.  OWNER: workstream A.

Layers are served as bytes serialized and gzipped once (service.layer_bytes / layer_gzip)
with a weak ETag, so the map's first load is a cache lookup per layer and reloads are 304s.
"""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, HTTPException, Query, Request, Response
from fastapi.responses import FileResponse
from fastapi.responses import StreamingResponse

from app.contract import LngLat, SiteSummary
from app.explore.area import AreaRequest, summarize_area
from app.explore.zoning import ZoningRequest, selected_zoning, stream_zoning, validate_selection, zoning
from app.explore.search import search_places
from app.explore.service import (
    LAYERS,
    fallback_style_path,
    layer_bytes,
    layer_etag,
    layer_gzip,
    layer_info,
    summarize_site,
)

router = APIRouter(prefix="/api", tags=["explore"])

CACHE_CONTROL = "public, max-age=300"


def _accepts_gzip(accept_encoding: str | None) -> bool:
    """True if Accept-Encoding allows gzip (an explicit gzip;q=0 wins over *)."""
    q_by_coding: dict[str, float] = {}
    for part in (accept_encoding or "").split(","):
        coding, *params = (p.strip() for p in part.split(";"))
        if not coding:
            continue
        q = 1.0
        for param in params:
            key, _, value = param.partition("=")
            if key.strip().lower() == "q":
                try:
                    q = float(value)
                except ValueError:
                    q = 0.0
        q_by_coding[coding.lower()] = q
    if "gzip" in q_by_coding:
        return q_by_coding["gzip"] > 0
    return q_by_coding.get("*", 0.0) > 0


def _etag_matches(if_none_match: str | None, etag: str) -> bool:
    """Weak comparison, as If-None-Match requires (W/"x" matches "x")."""
    if not if_none_match:
        return False
    opaque = etag.removeprefix("W/")
    return any(tag.strip() == "*" or tag.strip().removeprefix("W/") == opaque for tag in if_none_match.split(","))


@router.get(
    "/layers/{layer}",
    response_class=Response,
    responses={
        200: {"content": {"application/json": {}}, "description": "GeoJSON FeatureCollection"},
        304: {"description": "Not modified (If-None-Match matched the ETag)"},
        404: {"description": "Unknown layer"},
    },
)
def layer(layer: str, request: Request) -> Response:
    if layer not in LAYERS:
        raise HTTPException(404, f"Unknown layer {layer!r}; expected one of {LAYERS}")
    etag = layer_etag(layer)
    headers = {"ETag": etag, "Cache-Control": CACHE_CONTROL, "Vary": "Accept-Encoding"}
    if _etag_matches(request.headers.get("if-none-match"), etag):
        return Response(status_code=304, headers=headers)
    if _accepts_gzip(request.headers.get("accept-encoding")):
        return Response(layer_gzip(layer), media_type="application/json", headers={**headers, "Content-Encoding": "gzip"})
    return Response(layer_bytes(layer), media_type="application/json", headers=headers)


@router.get("/site/summary", response_model=SiteSummary)
def site_summary(
    lon: Annotated[float, Query(ge=-180, le=180, allow_inf_nan=False, description="Longitude, WGS84 degrees")],
    lat: Annotated[float, Query(ge=-90, le=90, allow_inf_nan=False, description="Latitude, WGS84 degrees")],
) -> SiteSummary:
    return summarize_site(LngLat(lon=lon, lat=lat))


@router.get("/explore/layers")
def explore_layers() -> dict[str, Any]:
    """Per dataset: feature count, source, license, url, attribution and source date."""
    return layer_info()


@router.get("/explore/search")
def place_search(q: str = Query(min_length=2, max_length=120)) -> dict:
    try:
        return search_places(q)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@router.post("/explore/area")
def selected_area(req: AreaRequest) -> dict:
    try:
        return summarize_area(req)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@router.get("/explore/zoning")
def zoning_layer(bbox: str) -> dict:
    try:
        return zoning(bbox)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@router.post("/explore/zoning")
def highlighted_zoning(req: ZoningRequest) -> dict:
    try:
        return selected_zoning(req.footprint)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@router.post("/explore/zoning/stream")
def progressive_zoning(req: ZoningRequest):
    try:
        validate_selection(req.footprint)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    return StreamingResponse(stream_zoning(req.footprint), media_type="application/x-ndjson",
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})


@router.get("/explore/fallback-style", responses={404: {"description": "No bundled fallback style"}})
def fallback_style() -> FileResponse:
    """Bundled minimal MapLibre style for when the basemap tile provider is down."""
    path = fallback_style_path()
    if path is None:
        raise HTTPException(404, "No bundled fallback basemap style (data/explore/basemap_fallback.json)")
    return FileResponse(path, media_type="application/json", headers={"Cache-Control": CACHE_CONTROL})
