"""Site recommendation endpoints.  OWNER: workstream B (Phase 2)."""

from fastapi import APIRouter, Query

from app.contract import ForecastRequest, SiteRecommendation, SiteRequest
from app.sites.service import recommend

router = APIRouter(prefix="/api", tags=["sites"])


@router.get("/sites", response_model=SiteRecommendation)
def get_sites(scenario: str = "mid", year: int = Query(2035, ge=2025, le=2070)) -> SiteRecommendation:
    return recommend(SiteRequest(forecast=ForecastRequest(scenario=scenario, year=year)))


@router.post("/sites/whatif", response_model=SiteRecommendation)
def whatif(req: SiteRequest) -> SiteRecommendation:
    return recommend(req)
