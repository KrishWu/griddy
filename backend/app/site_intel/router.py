"""Site intelligence endpoints.  OWNER: workstream E."""

from fastapi import APIRouter

from app.contract import LngLat, SiteIntel
from app.site_intel.service import site_intel

router = APIRouter(prefix="/api", tags=["site_intel"])


@router.get("/site/intel", response_model=SiteIntel)
def intel(lon: float, lat: float) -> SiteIntel:
    return site_intel(LngLat(lon=lon, lat=lat))
