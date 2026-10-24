"""Explore endpoints.  OWNER: workstream A.

Layers (and the interconnection-queue JSON) are served as bytes serialized and gzipped once
(service.layer_bytes / layer_gzip / queue_payload) with a weak ETag, so the map's first load is a
cache lookup per layer and reloads are 304s.
"""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, HTTPException, Query, Request, Response
from fastapi.responses import FileResponse

from app.contract import LngLat, SiteSummary
from app.explore.service import (
    LAYERS,
    fallback_style_path,
    layer_bytes,
    layer_etag,
    layer_gzip,
    layer_info,
    queue_payload,
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


def _cached_json(request: Request, raw: bytes, gz: bytes, etag: str) -> Response:
    """Pre-serialized JSON (and its gzip) with a weak ETag: 304 on a match, gzip when the client accepts it."""
    headers = {"ETag": etag, "Cache-Control": CACHE_CONTROL, "Vary": "Accept-Encoding"}
    if _etag_matches(request.headers.get("if-none-match"), etag):
        return Response(status_code=304, headers=headers)
    if _accepts_gzip(request.headers.get("accept-encoding")):
        return Response(gz, media_type="application/json", headers={**headers, "Content-Encoding": "gzip"})
    return Response(raw, media_type="application/json", headers=headers)


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
    return _cached_json(request, layer_bytes(layer), layer_gzip(layer), layer_etag(layer))


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


@router.get("/explore/fallback-style", responses={404: {"description": "No bundled fallback style"}})
def fallback_style() -> FileResponse:
    """Bundled minimal MapLibre style for when the basemap tile provider is down."""
    path = fallback_style_path()
    if path is None:
        raise HTTPException(404, "No bundled fallback basemap style (data/explore/basemap_fallback.json)")
    return FileResponse(path, media_type="application/json", headers={"Cache-Control": CACHE_CONTROL})


@router.get(
    "/explore/queue",
    response_class=Response,
    responses={
        200: {"content": {"application/json": {}}, "description": "LBNL interconnection queue aggregated by California county"},
        304: {"description": "Not modified (If-None-Match matched the ETag)"},
        404: {"description": "Queue data unavailable"},
    },
)
def interconnection_queue(request: Request) -> Response:
    """Active interconnection requests by county (LBNL Queued Up 2026, CC BY 4.0): statewide totals,
    per-county MW by type and the largest requests."""
    payload = queue_payload()
    if payload is None:
        raise HTTPException(404, "Interconnection-queue data unavailable (data/explore/queue_ca_by_county.json)")
    return _cached_json(request, *payload)
