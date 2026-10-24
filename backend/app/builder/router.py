"""Presets + report endpoints.  OWNER: workstream D."""

from fastapi import APIRouter, HTTPException
from fastapi.responses import PlainTextResponse

from app.builder.service import list_presets, report_csv
from app.contract import Scenario, ScenarioResult
from app.builder.optimizer import OptimizeRequest, optimize
from app.builder.planner import PlanRequest, plan_project

router = APIRouter(prefix="/api", tags=["build"])


@router.get("/presets", response_model=list[Scenario])
def presets() -> list[Scenario]:
    return list_presets()


@router.post("/report.csv", response_class=PlainTextResponse)
def report(result: ScenarioResult) -> str:
    return report_csv(result)


@router.post("/projects/plan")
def plan(req: PlanRequest) -> dict:
    try:
        return plan_project(req)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@router.post("/projects/optimize")
def optimize_route(req: OptimizeRequest) -> dict:
    try:
        return optimize(req)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
