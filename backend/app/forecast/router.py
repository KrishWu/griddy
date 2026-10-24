"""Demand forecast endpoints.  OWNER: workstream A (Phase 2)."""

from fastapi import APIRouter, Query

from app.contract import DemandForecast, ForecastRequest
from app.forecast.service import forecast

router = APIRouter(prefix="/api", tags=["forecast"])


@router.get("/forecast", response_model=DemandForecast)
def get_forecast(scenario: str = "mid", year: int = Query(2035, ge=2025, le=2070)) -> DemandForecast:
    return forecast(ForecastRequest(scenario=scenario, year=year))


@router.post("/forecast/whatif", response_model=DemandForecast)
def whatif(req: ForecastRequest) -> DemandForecast:
    return forecast(req)
