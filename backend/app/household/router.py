"""Griddy Home endpoints.  OWNER: household (backend)."""

from fastapi import APIRouter

from app.household.models import (
    HouseholdOptions,
    HouseholdRequest,
    HouseholdResult,
    SolarOptimizeRequest,
    SolarOptimizeResult,
    UsageParseRequest,
    UsageParseResult,
)
from app.household.optimize import optimize_solar
from app.household.service import options, parse_usage, plan

router = APIRouter(prefix="/api/household", tags=["household"])


@router.get("/options", response_model=HouseholdOptions)
def get_options() -> HouseholdOptions:
    return options()


@router.post("/usage/parse", response_model=UsageParseResult)
def post_usage_parse(req: UsageParseRequest) -> UsageParseResult:
    return parse_usage(req.csv_text)


@router.post("/plan", response_model=HouseholdResult)
def post_plan(req: HouseholdRequest) -> HouseholdResult:
    return plan(req)


@router.post("/solar/optimize", response_model=SolarOptimizeResult)
def post_solar_optimize(req: SolarOptimizeRequest) -> SolarOptimizeResult:
    return optimize_solar(req)
