"""Explore endpoints.  OWNER: workstream A."""

from fastapi import APIRouter, HTTPException

from app.contract import LngLat, SiteSummary
from app.explore.service import LAYERS, get_layer, summarize_site

router = APIRouter(prefix="/api", tags=["explore"])


@router.get("/layers/{layer}")
def layer(layer: str) -> dict:
    if layer not in LAYERS:
        raise HTTPException(404, f"Unknown layer {layer!r}; expected one of {LAYERS}")
    return get_layer(layer)


@router.get("/site/summary", response_model=SiteSummary)
def site_summary(lon: float, lat: float) -> SiteSummary:
    return summarize_site(LngLat(lon=lon, lat=lat))
