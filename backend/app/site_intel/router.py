"""Site intelligence endpoints.  OWNER: workstream E."""

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse

from app.contract import LngLat, SiteIntel
from app.site_intel import earthengine
from app.site_intel.carbon import CarbonAwareRequest, CarbonAwareResult, carbon_aware
from app.site_intel.imagery import tile_path
from app.site_intel.service import site_intel

router = APIRouter(prefix="/api", tags=["site_intel"])
earthengine.warm_up()  # no-op without EE_PROJECT


@router.get("/site/intel", response_model=SiteIntel)
def intel(lon: float = Query(ge=-180, le=180), lat: float = Query(ge=-90, le=90)) -> SiteIntel:
    return site_intel(LngLat(lon=lon, lat=lat))


@router.get("/site/tiles/{z}/{x}/{y}.png")
def tile(z: int, x: int, y: int) -> FileResponse:
    """Offline satellite tiles for the demo area (prep/imagery.py); 404 outside it."""
    path = tile_path(z, x, y)
    if path is None:
        raise HTTPException(status_code=404, detail="no cached tile")
    return FileResponse(path, media_type="image/png", headers={"Cache-Control": "public, max-age=86400"})


@router.post("/site/carbon-aware", response_model=CarbonAwareResult)
def carbon_shift(req: CarbonAwareRequest) -> CarbonAwareResult:
    """Shift the flexible share of load to each day's cleanest hours (Green Software Foundation SCI)."""
    return carbon_aware(req)
