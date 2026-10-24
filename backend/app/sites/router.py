"""Site recommendation endpoints.  OWNER: workstream B (Phase 2)."""

from fastapi import APIRouter, Query

from app.contract import ForecastRequest, LngLat, SiteRecommendation, SiteRequest
from app.sites.grade import SiteGrade, grade
from app.sites.service import recommend

router = APIRouter(prefix="/api", tags=["sites"])


@router.get("/sites/grade", response_model=SiteGrade)
def get_grade(lon: float = Query(ge=-180, le=180), lat: float = Query(ge=-90, le=90)) -> SiteGrade:
    """GriddyGrade: the site-location model's projected 1-100 data center feasibility score for one point."""
    return grade(LngLat(lon=lon, lat=lat))


@router.get("/sites", response_model=SiteRecommendation)
def get_sites(scenario: str = "mid", year: int = Query(2035, ge=2025, le=2070)) -> SiteRecommendation:
    return recommend(SiteRequest(forecast=ForecastRequest(scenario=scenario, year=year)))


@router.post("/sites/whatif", response_model=SiteRecommendation)
def whatif(req: SiteRequest) -> SiteRecommendation:
    return recommend(req)
